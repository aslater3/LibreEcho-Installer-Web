// The unpinned-LK opt-in: an operator-only escape hatch for a locked device
// whose LK build has no pinned payload. These tests pin the two properties that
// make it safe to ship — it is never implied, and it is always announced.
import test from 'node:test';
import assert from 'node:assert/strict';

import { PROFILES, payloadForProfile, payloadNameCandidates, isBuildDescription } from './profiles.js';
import { submitUnlockPayload } from './stages.js';
import { sha256Bytes } from './sha256.js';

const radar = PROFILES.find((profile) => profile.id === 'radar');
const biscuit = PROFILES.find((profile) => profile.id === 'biscuit');
// The build from the field report: a locked Echo 2nd Gen with no pinned payload.
const UNPINNED = '3c6be74-20210822_210647';

function memoryStorage() {
  const store = new Map();
  return { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)) };
}

test('an unpinned LK build is refused unless the operator opts in', () => {
  assert.equal(payloadForProfile(radar, UNPINNED), null, 'no opt-in must stay fail-closed');
  const selection = payloadForProfile(radar, UNPINNED, { allowUnpinned: true });
  assert.ok(selection, 'the opt-in resolves the archive default');
  assert.equal(selection.matched, 'fallback');
  assert.equal(selection.payload, radar.fallbackPayload.payload);
  assert.equal(selection.size, radar.fallbackPayload.size);
  assert.equal(selection.sha256, radar.fallbackPayload.sha256);
  assert.equal(selection.build, UNPINNED);
});

test('a declared pin still wins when the opt-in is on', () => {
  const exact = payloadForProfile(radar, '59779ca-20220524_183401', { allowUnpinned: true });
  assert.equal(exact.matched, 'exact');
  assert.equal(exact.payload, 'fastbrick-20220524.img');
  // A string that only resembles a pin is neither a pin nor a build report.
  assert.equal(payloadForProfile(radar, '59779ca-20220524_183401-unqualified-rebuild', { allowUnpinned: true }), null);
  const other = payloadForProfile(radar, UNPINNED, { allowUnpinned: true });
  assert.equal(other.matched, 'fallback');
});

test('the 073612 build stays an exact pin, matching the host installer', () => {
  const exact = payloadForProfile(radar, '63cb91b-20221007_073612');
  assert.equal(exact?.matched, 'exact');
  assert.equal(exact.payload, 'fastbrick.img');
});

test('each profile carries its own archive-default digest', () => {
  const forBiscuit = payloadForProfile(biscuit, UNPINNED, { allowUnpinned: true });
  assert.equal(forBiscuit.payload, 'fastbrick.img');
  assert.equal(forBiscuit.sha256, biscuit.fallbackPayload.sha256);
  assert.notEqual(biscuit.fallbackPayload.sha256, radar.fallbackPayload.sha256,
    'Biscuit ships a different fastbrick.img than Radar');
});

test('a value the device did not report as a build is never treated as unpinned', () => {
  for (const value of ['unknown', '', '   ', 'fastboot mode', 'no build']) {
    assert.equal(payloadForProfile(radar, value, { allowUnpinned: true }), null, JSON.stringify(value));
  }
  assert.equal(isBuildDescription('3c6be74-20210822_210647'), true);
  assert.equal(isBuildDescription('63cb91b-20221007_072309'), true);
  assert.equal(isBuildDescription('3c6be74'), false);
});

test('profiles with no declared default still return null under the opt-in', () => {
  const bare = { id: 'bare', lkBuildMap: {} };
  assert.equal(payloadForProfile(bare, UNPINNED, { allowUnpinned: true }), null);
  assert.equal(payloadForProfile(radar, '', { allowUnpinned: true }), null);
  assert.equal(payloadForProfile(null, UNPINNED, { allowUnpinned: true }), null);
});

test('the archive default name is recognised as a fastbrick candidate', () => {
  for (const profile of [radar, biscuit]) {
    assert.ok(payloadNameCandidates(profile).includes('fastbrick.img'), profile.id);
  }
});

test('submitting an unpinned build without the opt-in refuses and names the control', async () => {
  const prior = globalThis.localStorage;
  globalThis.localStorage = memoryStorage();
  try {
    const client = { flash: async () => { throw new Error('no write may be attempted'); } };
    await assert.rejects(
      submitUnlockPayload({
        client, profile: radar, lkBuild: UNPINNED,
        payloadBytes: new Uint8Array(0), payloadName: 'fastbrick.img', serialRaw: 'TEST0001',
        terminal: { warn() {}, command() {}, progress() {}, endProgress() {}, line() {} },
      }),
      /no pinned unlock payload.*allow untested LK build/,
    );
  } finally {
    globalThis.localStorage = prior;
  }
});

test('with the opt-in the default is sent once, announced, and latched', async () => {
  // A synthetic profile keeps the test fast: the real payload is 114 MB and the
  // size/digest contract is the same whatever the image is.
  const bytes = new TextEncoder().encode('synthetic-fastbrick-image');
  const profile = {
    id: 'synthetic', lkBuildMap: {},
    fallbackPayload: { payload: 'tiny.img', size: bytes.length, sha256: await sha256Bytes(bytes) },
  };
  const flips = [];
  const warnings = [];
  const commands = [];
  const prior = globalThis.localStorage;
  const store = memoryStorage();
  globalThis.localStorage = store;
  const terminal = {
    warn: (message) => warnings.push(message),
    command: (line) => commands.push(line),
    progress() {}, endProgress() {}, line() {},
  };
  try {
    const outcome = await submitUnlockPayload({
      client: { flash: async (partition, data) => { flips.push([partition, data.length]); return {}; } },
      profile, lkBuild: UNPINNED, payloadBytes: bytes, payloadName: 'tiny.img',
      serialRaw: 'SERIAL0001', terminal, allowUnpinned: true,
    });
    assert.equal(outcome.outcome, 'unknown', 'a returned flash command is never proof of unlock');
    assert.deepEqual(flips, [['brick', bytes.length]], 'one whole-image write, no chunking');
    assert.equal(commands.length, 1);
    assert.match(commands[0], /^fastboot flash brick <tiny\.img>$/);
    assert.ok(warnings.some((line) => /not pinned/.test(line) && /untested/.test(line)),
      'the untested combination is announced before the write');

    // The durable single-submission guard is untouched by the opt-in.
    await assert.rejects(
      submitUnlockPayload({
        client: { flash: async () => { throw new Error('second write must not happen'); } },
        profile, lkBuild: UNPINNED, payloadBytes: bytes, payloadName: 'tiny.img',
        serialRaw: 'SERIAL0001', terminal, allowUnpinned: true,
      }),
      /already submitted/,
    );
    assert.equal(flips.length, 1);
  } finally {
    globalThis.localStorage = prior;
  }
});

test('the Opt-in is off by default in page state and never inferred from the device', async () => {
  const source = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('./app.js', import.meta.url), 'utf8'));
  assert.match(source, /allowUnpinnedLk: false,/, 'page state starts closed');
  assert.match(source, /allowUnpinned: state\.allowUnpinnedLk === true,/,
    'the run passes an explicit boolean, not a truthy leftover');
});
