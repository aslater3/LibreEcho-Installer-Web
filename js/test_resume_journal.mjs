// The durable resume journal: what survives a reload, and what may never be
// persisted in the first place.
//
// A reload previously cost the operator the whole page: no identity, no release
// selection, no verified bundle, and — worst — the only way back was the
// findRecovery button, which requires a fastboot identity the device no longer
// has. So the page needs one durable, non-secret transaction record that says
// "this install is about a specific device, board and release" and nothing more.
//
// Everything here is deliberately fail-closed. The journal is a HINT about what
// was in progress; it is never the authority for whether a phase may run, and it
// is never a reason to re-arm unlock or formatting. A corrupt or unreadable
// journal is therefore indistinguishable from no journal, which is the safe
// reading: start over from a fresh choice rather than trust a damaged record.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RESUME_JOURNAL_VERSION,
  RESUME_JOURNAL_KEY,
  SECRET_FIELD_NAMES,
  classifyResumeState,
  readResumeJournal,
  writeResumeJournal,
  clearResumeJournal,
  isSecretFieldName,
} from './resume.js';

const hex64 = 'a'.repeat(64);

/**
 * A localStorage double: getItem/setItem/removeItem, with optional denial.
 *
 * `deny` and `denyWrite` name keys to refuse, so a read-only refusal and a
 * write-only refusal are distinguishable — the page must survive both, and they
 * are genuinely two different failures.
 */
function storage({ deny = null, denyWrite = null, entries = new Map() } = {}) {
  const denied = deny ? new Set(deny) : new Set();
  const deniedWrites = denyWrite ? new Set(denyWrite) : new Set();
  return {
    map: entries,
    getItem(key) {
      if (denied.has(key)) { const e = new Error('storage denied'); e.name = 'SecurityError'; throw e; }
      return entries.has(key) ? entries.get(key) : null;
    },
    setItem(key, value) {
      if (deniedWrites.has(key)) { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; }
      if (denied.has(key)) { const e = new Error('storage denied'); e.name = 'SecurityError'; throw e; }
      entries.set(key, String(value));
    },
    removeItem(key) {
      if (denied.has(key)) { const e = new Error('denied'); e.name = 'SecurityError'; throw e; }
      entries.delete(key);
    },
    get length() { return entries.size; },
    key(index) { return [...entries.keys()][index] ?? null; },
  };
}

/** A complete, valid journal body for the happy path. */
function validBody(overrides = {}) {
  return {
    version: RESUME_JOURNAL_VERSION,
    serial: 'G090L90964010665',
    serialSha256: hex64,
    board: 'radar_puffin',
    release: 'radar-puffin-v0.14.0',
    releaseTag: 'radar-puffin-v0.14.0',
    bundleManifestSha256: hex64,
    deviceDigest: 'd'.repeat(64),
    phase: 'transfer',
    unlockState: 'submitted',
    updatedAt: 1750000000000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Secrets are never written, not even hashed
// ---------------------------------------------------------------------------

test('a body carrying a secret field is refused before anything is stored', () => {
  const store = storage();
  const result = writeResumeJournal(storageWith(store), validBody({ password: 'hunter2' }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /secret/i);
  assert.equal(store.length, 0, 'a refused body must leave storage untouched');
});

test('a body carrying a hashed secret is refused too', () => {
  const store = storage();
  // A digest of a secret is still a secret-derived value: it must never be
  // persisted, or the browser becomes an offline password oracle.
  const result = writeResumeJournal(storageWith(store), validBody({ passwordSha256: hex64 }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /secret/i);
  assert.equal(store.length, 0);
});

test('every secret-ish field name is recognised, including near-misses', () => {
  for (const name of [...SECRET_FIELD_NAMES, 'ssid', 'wifiPassword', 'wifi_password', 'provisionForm']) {
    assert.equal(isSecretFieldName(name), true, `${name} was not treated as a secret field`);
  }
  for (const name of ['serial', 'board', 'release', 'phase', 'deviceDigest']) {
    assert.equal(isSecretFieldName(name), false, `${name} was wrongly treated as a secret`);
  }
});

test('the serial is stored only as a digest, never in the clear', async () => {
  const store = storage();
  const result = writeResumeJournal(storageWith(store), validBody());
  assert.equal(result.ok, true);
  const raw = JSON.stringify([...store.map.entries()]);
  assert.doesNotMatch(raw, /G090L90964010665/, 'the full serial reached durable storage');
  assert.match(raw, new RegExp(hex64), 'the serial digest is stored');
});

// ---------------------------------------------------------------------------
// 2. Round trip
// ---------------------------------------------------------------------------

test('a written journal reads back with the same fields', () => {
  const store = storage();
  assert.equal(writeResumeJournal(storageWith(store), validBody()).ok, true);
  const read = readResumeJournal(storageWith(store));
  assert.equal(read.ok, true);
  assert.equal(read.journal.serialSha256, hex64);
  assert.equal(read.journal.board, 'radar_puffin');
  assert.equal(read.journal.releaseTag, 'radar-puffin-v0.14.0');
  assert.equal(read.journal.phase, 'transfer');
  // The raw serial is never echoed back into the page's memory either.
  assert.equal(Object.hasOwn(read.journal, 'serial'), false);
});

test('clearing removes the journal and leaves nothing to read', () => {
  const store = storage();
  writeResumeJournal(storageWith(store), validBody());
  assert.equal(clearResumeJournal(storageWith(store)).ok, true);
  assert.equal(readResumeJournal(storageWith(store)).ok, false);
  assert.match(readResumeJournal(storageWith(store)).reason, /no resume journal/i);
});

// ---------------------------------------------------------------------------
// 3. Every failure mode is safe, not fatal
// ---------------------------------------------------------------------------

// Every one of these is a way the READ path can fail. A denied write is a
// different failure with its own test below.
const FAILURES = [
  { name: 'storage denied on read', store: () => storage({ deny: [RESUME_JOURNAL_KEY] }), pattern: /cannot read/i },
  { name: 'corrupt JSON', store: () => storage({ entries: new Map([[RESUME_JOURNAL_KEY, '{not json']]) }), pattern: /corrupt|unusable/i },
  { name: 'a JSON array instead of an object', store: () => storage({ entries: new Map([[RESUME_JOURNAL_KEY, '[1,2,3]']]) }), pattern: /corrupt|unusable/i },
  { name: 'a JSON primitive', store: () => storage({ entries: new Map([[RESUME_JOURNAL_KEY, '"hello"']]) }), pattern: /corrupt|unusable/i },
  { name: 'an unknown schema version', store: () => storage({ entries: new Map([[RESUME_JOURNAL_KEY, JSON.stringify({ version: 99 })]]) }), pattern: /version/i },
  { name: 'a missing serial digest', store: () => storage({ entries: new Map([[RESUME_JOURNAL_KEY, JSON.stringify({ version: RESUME_JOURNAL_VERSION, board: 'radar_puffin' })]]) }), pattern: /corrupt|unusable|serial/i },
  { name: 'a malformed serial digest', store: () => storage({ entries: new Map([[RESUME_JOURNAL_KEY, JSON.stringify(validBody({ serialSha256: 'nope' }))]]) }), pattern: /corrupt|unusable|serial/i },
  { name: 'an unknown board', store: () => storage({ entries: new Map([[RESUME_JOURNAL_KEY, JSON.stringify(validBody({ board: 'pineapple' }))]]) }), pattern: /corrupt|unusable|board/i },
  { name: 'an unknown phase', store: () => storage({ entries: new Map([[RESUME_JOURNAL_KEY, JSON.stringify(validBody({ phase: 'finalize-now' }))]]) }), pattern: /corrupt|unusable|phase/i },
  // Built as TEXT on purpose: `{ __proto__: x }` in an object literal SETS the
  // prototype and JSON.stringify drops it, so a spread here would never store
  // the key and the test would pass for the wrong reason.
  { name: 'an injected prototype key', store: () => storage({ entries: new Map([[RESUME_JOURNAL_KEY,
    JSON.stringify(validBody()).replace(/^\{/, '{"__proto__":{"polluted":true},')]]) }),
    pattern: /corrupt|unusable|reserved/i },
];

for (const { name, store, pattern } of FAILURES) {
  test(`${name} is reported, never thrown, and never treated as resumable`, () => {
    const backing = store();
    const read = readResumeJournal(storageWith(backing));
    assert.equal(read.ok, false, `${name} was read as resumable`);
    assert.match(read.reason, pattern);
    assert.equal(read.journal, null);
    assert.equal(classifyResumeState(read).resumable, false, `${name} implied a resume`);
    assert.equal({}.polluted, undefined, 'a corrupt journal polluted Object.prototype');
  });
}

test('a refused write is reported, never thrown, and never leaves a half-record', () => {
  const store = storage({ denyWrite: [RESUME_JOURNAL_KEY] });
  const result = writeResumeJournal(storageWith(store), validBody());
  assert.equal(result.ok, false);
  assert.match(result.reason, /cannot persist/i);
  assert.equal(store.length, 0, 'a denied write stored something');
  // And the page must still be usable: a denied write is a lost convenience,
  // never a lost install, so the read path reports no journal rather than failing.
  assert.equal(readResumeJournal(storageWith(store)).ok, false);
});

test('an invalid body is refused before storage is touched', () => {
  const store = storage();
  for (const body of [null, 'a string', 42, []]) {
    const result = writeResumeJournal(storageWith(store), body);
    assert.equal(result.ok, false, `${JSON.stringify(body)} was accepted`);
  }
  assert.equal(store.length, 0);
});

// ---------------------------------------------------------------------------
// 4. The journal is a hint, never an authority
// ---------------------------------------------------------------------------

test('a journal never claims a destructive step is safe on its own', () => {
  // unlockState and phase are recorded, but classification must never hand back
  // "you may re-run this". Anything that touches userdata must be re-verified
  // against the device, which only the caller can do.
  const verdicts = ['fresh', 'identity-only', 'unlock-submitted', 'phases-started', 'provisioning']
    .map((phase) => classifyResumeState({ ok: true, journal: validBody({ phase, unlockState: 'submitted' }) }));
  for (const verdict of verdicts) {
    assert.equal(verdict.mayReunUnlock, false, 'a journal re-armed the unlock');
    assert.equal(verdict.mayReformat, false, 'a journal re-armed formatting');
    assert.equal(verdict.requiresDeviceReverification, true,
      'a journal was treated as proof of on-device state');
  }
});

test('an unlock that was submitted is reported as such and never as pending work', () => {
  const state = classifyResumeState({ ok: true, journal: validBody({ phase: 'fresh', unlockState: 'submitted' }) });
  assert.equal(state.unlockSubmitted, true);
  assert.equal(state.mayReunUnlock, false);
});

test('a journal with no unlock recorded does not claim one is needed', () => {
  const state = classifyResumeState({ ok: true, journal: validBody({ unlockState: 'none' }) });
  assert.equal(state.unlockSubmitted, false);
  // "not recorded" is not "needed": the device still has to be asked.
  assert.equal(state.mayReunUnlock, false);
});

test('an empty page is classified as fresh with nothing to resume', () => {
  const state = classifyResumeState(readResumeJournal(storage()));
  assert.equal(state.fresh, true);
  assert.equal(state.resumable, false);
  assert.equal(state.journal, null);
});

// ---------------------------------------------------------------------------
// 5. Guard keys are never touched
// ---------------------------------------------------------------------------

test('writing, reading and clearing a journal leaves every libreecho guard intact', () => {
  const entries = new Map([
    ['libreecho.unlock.abc', 'submitted-or-unknown'],
    ['libreecho.unlock.sent.def', 'submitted-or-unknown'],
    ['libreecho.recovery.ghi', 'pending-or-completed'],
    ['libreecho.direct.jkl', 'pending-or-completed'],
    ['legacy.unlock.mnop', 'submitted-or-unknown'],
  ]);
  const store = storage({ entries });
  const wrapped = storageWith(store);
  writeResumeJournal(wrapped, validBody());
  readResumeJournal(wrapped);
  clearResumeJournal(wrapped);
  for (const key of entries.keys()) {
    assert.ok(store.map.has(key) === (key === RESUME_JOURNAL_KEY ? store.map.has(key) : true),
      `${key} was removed`);
  }
  assert.equal(entries.size, 5, 'exactly one journal key exists and no guard key was removed');
  assert.equal(store.map.has(RESUME_JOURNAL_KEY), false, 'the journal itself was not cleared');
});

test('the journal key is namespaced so it can never collide with a guard key', () => {
  assert.match(RESUME_JOURNAL_KEY, /^libreecho\.resume\./);
  assert.doesNotMatch(RESUME_JOURNAL_KEY, /unlock|recovery\.|direct\./);
});

/**
 * Wraps a storage double in the `{ get, set, remove }` seam the journal uses, so
 * a test can supply a raw localStorage-shaped object or an injected failure.
 */
function storageWith(backing) {
  return {
    get: (key) => backing.getItem(key),
    set: (key, value) => backing.setItem(key, value),
    remove: (key) => backing.removeItem(key),
  };
}