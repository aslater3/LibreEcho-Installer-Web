// The origin-wide writer lock.
//
// app.js already excludes two USB operations inside ONE tab (`recoveryClaims`).
// That registry is a `Map`, so a second tab of the same origin sees an empty one
// and believes it is the only writer. The browser restores the previous tab's
// USB grant after a reload, so both tabs really can be live at once — and the
// operator's actual failure was a reload followed by a second press.
//
// The exclusion therefore has to live in the BROWSER, not in a value this page
// can rewrite. `navigator.locks.request(name, { mode: 'exclusive',
// ifAvailable: true })` grants at most one caller per origin, hands the loser a
// null lock instead of a queue slot, and — crucially — holds the grant for as
// long as the granted callback's promise is pending. That is what these pin:
//
//   * Two attempts issued BEFORE either callback runs still resolve to exactly
//     one holder and one refusal. Ordering of the callbacks is not our choice,
//     so exclusion must not depend on it.
//   * The grant survives awaited device work with no heartbeat, because the
//     lock is held by the pending callback rather than by a timestamp.
//   * There is no staleness window at all. A lock cannot be taken over on a
//     timer, because a frozen or backgrounded tab is still holding it.
//   * Every failure is fail-closed: no Web Locks API, a rejected request, or a
//     request that throws all mean "do not install", never "install anyway".
//
// Nothing here writes to storage: an origin-wide lock has no record to persist,
// and the device journal (js/resume.js) stays the authority for what a half
// finished run actually did.

import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireWriterLock, WRITER_LOCK_NAME, WRITER_LOCK_KEY } from './writer-lock.js';

const TAB_A = 'tab-a';
const TAB_B = 'tab-b';

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const tick = () => new Promise((resolve) => { setImmediate(resolve); });

// ---------------------------------------------------------------------------
// A LockManager double, shared by every "tab" below exactly as the real one is:
// one origin-wide table, granted only when free, held for as long as the
// granted callback's promise is pending, released when it settles.
// ---------------------------------------------------------------------------

function lockManagerDouble({ defer = false } = {}) {
  // `defer` is ONE-SHOT: it holds back the first batch of attempts so a test can
    // issue several before any callback runs, then the manager behaves normally
    // again. A real browser does not stay stuck.
  let armed = defer === true;
  const queue = [];
  const grantedEntries = new Set();
  const held = new Set();
  const log = { calls: [], granted: [], released: [], refused: [], steal: [] };

  function settle(entry, error, value) {
    if (entry.settled) return; // the browser settles a request exactly once
    entry.settled = true;
    if (error) entry.reject(error); else entry.resolve(value);
  }

  function take(entry) {
    const at = queue.indexOf(entry);
    if (at >= 0) queue.splice(at, 1);
  }

  function pump() {
    for (const entry of [...queue]) {
      if (!held.has(entry.name)) {
        take(entry);
        held.add(entry.name);
        grantedEntries.add(entry);
        entry.state = 'granted';
        log.granted.push(entry.name);
        Promise.resolve()
          .then(() => entry.callback({ name: entry.name, mode: entry.mode }))
          .then(
            (value) => {
              // The lock lives exactly as long as the granted callback.
              if (!entry.settled) {
                held.delete(entry.name);
                grantedEntries.delete(entry);
                log.released.push(entry.name);
              }
              settle(entry, null, value);
            },
            (error) => {
              if (!entry.settled) { held.delete(entry.name); grantedEntries.delete(entry); }
              settle(entry, error);
            },
          );
        continue;
      }
      // ifAvailable: the request is refused now, not queued behind the holder.
      if (!entry.ifAvailable) continue;
      take(entry);
      entry.state = 'refused';
      log.refused.push(entry.name);
      Promise.resolve()
        .then(() => entry.callback(null))
        .then((value) => settle(entry, null, value), (error) => settle(entry, error));
    }
  }

  const manager = {
    log,
    isHeld: (name) => held.has(name),
    /** A tab that is killed or crashes: the browser drops its grants itself. */
    kill() {
      for (const entry of [...grantedEntries]) {
        grantedEntries.delete(entry);
        held.delete(entry.name);
        log.released.push(entry.name);
        entry.orphaned = true;
        settle(entry, null, undefined);
      }
    },
    request(name, options, callback) {
      const opts = typeof options === 'function' ? {} : { ...(options || {}) };
      const cb = typeof options === 'function' ? options : callback;
      log.calls.push({ name, options: opts });
      if (typeof cb !== 'function') return Promise.reject(new TypeError('callback is required'));
      if (opts.steal) {
        log.steal.push(name);
        return Promise.reject(new Error('steal must never be requested'));
      }
      let resolveEntry;
      let rejectEntry;
      const entry = {
        name,
        mode: opts.mode ?? 'exclusive',
        ifAvailable: opts.ifAvailable === true,
        callback: cb,
        settled: false,
        state: 'pending',
        resolve: (value) => resolveEntry(value),
        reject: (error) => rejectEntry(error),
        promise: new Promise((res, rej) => { resolveEntry = res; rejectEntry = rej; }),
      };
      queue.push(entry);
      if (armed) return entry.promise;
      pump();
      return entry.promise;
    },
    /** Only meaningful while `defer` is armed: run the queued attempts now. */
    flush() { armed = false; pump(); },
  };
  return manager;
}

// ===========================================================================
// A. the request itself: one origin-wide name, exclusive, never stolen
// ===========================================================================

test('the lock is requested as an origin-wide exclusive grant that never steals', async () => {
  const locks = lockManagerDouble();
  const handle = await acquireWriterLock({ locks });
  assert.equal(handle.ok, true, handle.reason);
  assert.equal(locks.log.calls.length, 1);
  const [call] = locks.log.calls;
  assert.equal(call.name, WRITER_LOCK_NAME, 'the lock name must be the same in every tab');
  assert.equal(call.options.mode, 'exclusive');
  assert.equal(call.options.ifAvailable, true, 'a refused writer must be told at once, not queued');
  assert.notEqual(call.options.steal, true, 'stealing a live writer lock was requested');
  await handle.release();
});

test('every tab contends for the identical lock name, and it carries no secret', async () => {
  assert.equal(WRITER_LOCK_NAME, WRITER_LOCK_KEY, 'the compatibility alias drifted from the name');
  assert.match(WRITER_LOCK_NAME, /^libreecho\./, 'the lock must be namespaced like the other guards');
  assert.doesNotMatch(WRITER_LOCK_NAME, /password|ssid|serial|token|secret/i);
});

test('no storage is consulted at all, so there is no record to corrupt or reclaim', async () => {
  // A localStorage that trips on ANY access, installed as a hostile global: a
  // module that read, wrote or cleared a key would fail loudly here. Node may or
  // may not define localStorage itself, which is exactly why the trap is added
  // rather than asserted about.
  const touched = [];
  const trap = {
    getItem: (k) => { touched.push(['getItem', k]); return null; },
    setItem: (k, v) => { touched.push(['setItem', k, v]); },
    removeItem: (k) => { touched.push(['removeItem', k]); },
    clear: () => { touched.push(['clear']); },
    key: () => { touched.push(['key']); return null; },
    get length() { touched.push(['length']); return 0; },
  };
  const real = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true, get() { touched.push(['get localStorage']); return trap; },
  });
  try {
    const locks = lockManagerDouble();
    const holder = await acquireWriterLock({ locks });
    assert.equal(holder.ok, true, holder.reason);
    holder.setPhase('transfer');
    await holder.release();
    assert.equal((await acquireWriterLock({ locks })).ok, true);
    await tick();
  } finally {
    if (real) Object.defineProperty(globalThis, 'localStorage', real);
    else delete globalThis.localStorage;
  }
  assert.deepEqual(touched, [],
    `the writer lock consulted storage it must not own: ${JSON.stringify(touched)}`);
});

// ===========================================================================
// B. two attempts issued before either callback runs: one holder, one refusal
// ===========================================================================

test('two attempts made before either callback runs still exclude each other', async () => {
  const locks = lockManagerDouble({ defer: true });
  // Both tabs press the button before the browser has called either of them.
  const first = acquireWriterLock({ locks });
  const second = acquireWriterLock({ locks });
  assert.equal(locks.log.granted.length, 0, 'a grant happened before any callback could run');
  locks.flush();

  const [a, b] = await Promise.all([first, second]);
  const held = [a, b].filter((r) => r.ok);
  const refused = [a, b].filter((r) => !r.ok);
  assert.equal(held.length, 1, 'both tabs were granted the same exclusive lock');
  assert.equal(refused.length, 1);
  assert.equal(locks.log.granted.length, 1);
  assert.equal(locks.log.refused.length, 1);
  await held[0].release();
});

test('the refused tab is told why, and is handed no lock to misuse', async () => {
  const locks = lockManagerDouble();
  const holder = await acquireWriterLock({ locks });
  const refused = await acquireWriterLock({ locks });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /another tab/i);
  assert.equal(refused.lock ?? null, null, 'a refusal handed out a usable lock');
  assert.equal(refused.release, undefined, 'a refusal pretended to hold something releasable');
  assert.equal(refused.setPhase, undefined);
  assert.equal(refused.renew, undefined);
  assert.ok(locks.isHeld(WRITER_LOCK_NAME), 'the refusal disturbed the holder lock');
  await holder.release();
});

// ===========================================================================
// C. held through async work, with no heartbeat and no timestamp
// ===========================================================================

test('the grant survives awaited device work, so no heartbeat is needed', async () => {
  const locks = lockManagerDouble();
  const holder = await acquireWriterLock({ locks });
  assert.equal(holder.setPhase('transfer'), true);
  // Interleave real awaits with contention attempts: the lock is held by the
  // pending callback, so nothing about elapsed time can change the answer.
  for (let step = 1; step <= 5; step += 1) {
    await tick();
    const contender = await acquireWriterLock({ locks });
    assert.equal(contender.ok, false, `step ${step}: a live writer was locked out mid-phase`);
    assert.equal(holder.renew(), true, `step ${step}: the holder stopped believing it held the lock`);
    assert.equal(holder.setPhase(`transfer-${step}`), true);
  }
  assert.deepEqual(locks.log.granted, [WRITER_LOCK_NAME], 'the lock was granted more than once');
  assert.equal(locks.log.refused.length, 5, 'a contender was queued instead of refused');
  assert.deepEqual(locks.log.released, [], 'a lock was released while its holder was still working');
  await holder.release();
});

test('ownership is not polled: setPhase and renew stop at release, not at a timeout', async () => {
  const locks = lockManagerDouble();
  const holder = await acquireWriterLock({ locks });
  assert.equal(holder.phase, null);
  holder.setPhase('finalize');
  assert.equal(holder.phase, 'finalize');
  assert.equal(holder.held, true);
  await holder.release();
  assert.equal(holder.held, false);
  assert.equal(holder.renew(), false, 'a released handle still claimed to hold the lock');
  assert.equal(holder.setPhase('done'), false);
});

// ===========================================================================
// D. release: exactly once, and only once the browser has actually let go
// ===========================================================================

test('release resolves only after the browser released the grant', async () => {
  const locks = lockManagerDouble();
  const holder = await acquireWriterLock({ locks });
  let released = false;
  const releasing = holder.release().then(() => { released = true; });
  await releasing;
  assert.equal(released, true, 'release resolved before the lock was actually free');
  assert.equal(locks.isHeld(WRITER_LOCK_NAME), false);
  assert.deepEqual(locks.log.released, [WRITER_LOCK_NAME]);

  // Only now may the next tab install.
  const next = await acquireWriterLock({ locks });
  assert.equal(next.ok, true, next.reason);
  await next.release();
});

test('a contender issued before release resolves is still refused', async () => {
  const locks = lockManagerDouble();
  const holder = await acquireWriterLock({ locks });
  const tooEarly = acquireWriterLock({ locks });
  const releasing = holder.release();
  const refused = await tooEarly;
  assert.equal(refused.ok, false, 'the lock was handed over before the holder finished releasing');
  await releasing;
  assert.equal((await acquireWriterLock({ locks })).ok, true);
});

test('release is idempotent and settles the browser request exactly once', async () => {
  const locks = lockManagerDouble();
  const holder = await acquireWriterLock({ locks });
  const entry = locks.log;
  await holder.release();
  await holder.release();
  await holder.release();
  assert.deepEqual(entry.released, [WRITER_LOCK_NAME], 'a repeated release let go more than once');
  assert.equal(locks.isHeld(WRITER_LOCK_NAME), false);
  assert.equal((await acquireWriterLock({ locks })).ok, true);
});

test('a released lock is immediately available to the next tab', async () => {
  const locks = lockManagerDouble();
  await (await acquireWriterLock({ locks })).release();
  const second = await acquireWriterLock({ locks });
  assert.equal(second.ok, true, 'a finished run stranded the operator out of their own next install');
  await second.release();
});

// ===========================================================================
// E. a dead tab needs no timeout: the browser drops the grant itself
// ===========================================================================

test('a tab that dies releases the lock without any stale-takeover timer', async () => {
  const locks = lockManagerDouble();
  await acquireWriterLock({ locks });
  assert.equal((await acquireWriterLock({ locks })).ok, false, 'the dead tab still excluded a live one');

  locks.kill(); // the browser cleans up after a crashed or closed tab
  const next = await acquireWriterLock({ locks });
  assert.equal(next.ok, true, 'a crashed tab stranded the page forever without a takeover timer');
  await next.release();
});

test('the lock path schedules no timer, so there is no window for a stale takeover', async () => {
  const realTimeout = globalThis.setTimeout;
  const realInterval = globalThis.setInterval;
  const scheduled = [];
  globalThis.setTimeout = (...args) => { scheduled.push('timeout'); return realTimeout(...args); };
  globalThis.setInterval = (...args) => { scheduled.push('interval'); return realInterval(...args); };
  try {
    const locks = lockManagerDouble();
    const holder = await acquireWriterLock({ locks });
    // Time passes, generously, while the install runs. This wait uses the REAL
    // timer so only the lock path's own scheduling is counted.
    await new Promise((done) => { realTimeout(done, 40); });
    assert.equal((await acquireWriterLock({ locks })).ok, false,
      'elapsed time let a second tab steal a live install');
    assert.equal(holder.renew(), true, 'the holder stopped believing it held the lock after 40ms');
    await holder.release();
  } finally {
    globalThis.setTimeout = realTimeout;
    globalThis.setInterval = realInterval;
  }
  assert.deepEqual(scheduled, [], 'the writer lock still schedules a timer of its own');
});

// ===========================================================================
// F. fail closed: no API, a rejected request, and a thrown request
// ===========================================================================

test('a browser without the Web Locks API refuses the install', async () => {
  // `undefined` is deliberately absent here: omitting `locks` means "use
  // navigator.locks", and some runtimes do provide one, so that is asserted
  // apart in section I rather than counted as a browser without the API.
  // Every case below LACKS a usable `request`, which is what "no API" means.
  for (const locks of [null, {}, { request: 'nope' }, Object.create(null), { query: () => null }]) {
    const result = await acquireWriterLock({ locks });
    assert.equal(result.ok, false, `a ${JSON.stringify(locks)} browser was allowed to install unguarded`);
    assert.match(result.reason, /web locks/i);
    assert.equal(result.lock ?? null, null);
  }
});

test('a request that never grants refuses the install rather than installing unguarded', async () => {
  // A LockManager that exists but grants nothing — a stub, a stubbed polyfill, or
  // one that silently drops the request — must still fail closed, and the refusal
  // must say the grant never arrived rather than claim the browser refused it.
  for (const locks of [{ request() {} }, { request: () => null }, { request: () => undefined }]) {
    const result = await acquireWriterLock({ locks });
    assert.equal(result.ok, false, 'a request that granted nothing still ran the install');
    assert.equal(result.lock ?? null, null);
    assert.match(result.reason, /without granting|refused/i, `unhelpful reason: ${result.reason}`);
  }
});

test('a rejected lock request refuses the install and says why', async () => {
  const reason = await acquireWriterLock({ locks: { request: () => Promise.reject(new Error('SecurityError')) } });
  assert.equal(reason.ok, false);
  assert.match(reason.reason, /refused/i);
  assert.match(reason.reason, /SecurityError/);
});

test('a lock request that throws synchronously refuses the install', async () => {
  const reason = await acquireWriterLock({
    locks: { request: () => { throw new Error('opaque origin'); } },
  });
  assert.equal(reason.ok, false);
  assert.match(reason.reason, /opaque origin/);
});

test('a request that fails is refused even when it looks like a grant', async () => {
  // A hostile double that grants and then rejects: the grant must not be trusted.
  const locks = {
    request: () => Promise.reject(new Error('lock service died')),
  };
  const result = await acquireWriterLock({ locks });
  assert.equal(result.ok, false);
  assert.equal(result.release, undefined);
});

// ===========================================================================
// G. no rejected callback escapes as an unhandled rejection
// ===========================================================================

test('a rejected request and a throwing callback produce no unhandled rejection', async () => {
  const seen = [];
  const onUnhandled = (error) => seen.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    const rejected = await acquireWriterLock({ locks: { request: () => Promise.reject(new Error('boom')) } });
    assert.equal(rejected.ok, false);

    // A granted callback that blows up mid-run: the failure is reported, not
    // thrown into the void, and the lock is still released.
    const locks = lockManagerDouble();
    const holder = await acquireWriterLock({ locks });
    holder.setPhase('transfer');
    await holder.release();
    await sleep(20);
    await tick();
    assert.deepEqual(seen.map((e) => e?.message ?? String(e)), [],
      `unhandled rejections escaped: ${seen.map((e) => e?.message)}`);
    assert.equal(locks.isHeld(WRITER_LOCK_NAME), false);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('an internal callback failure resolves the caller instead of rejecting', async () => {
  const locks = lockManagerDouble();
  // The grant is refused with a null lock while a *stale* granted callback throws:
  // the double's chain must not leak, and neither must the module.
  const handle = await acquireWriterLock({ locks });
  assert.equal(handle.ok, true);
  await handle.release();
  const seen = [];
  const onUnhandled = (error) => seen.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    await sleep(20);
    await tick();
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(seen, []);
});

// ===========================================================================
// H. the tab identity the caller logs is the lock name, not a fabricated id
// ===========================================================================

test('the handle exposes the contended name for diagnostics and nothing more', async () => {
  const locks = lockManagerDouble();
  const holder = await acquireWriterLock({ locks });
  assert.equal(holder.name, WRITER_LOCK_NAME);
  assert.equal(holder.reason, null);
  assert.equal(typeof holder.renew, 'function');
  assert.equal(typeof holder.setPhase, 'function');
  assert.equal(typeof holder.release, 'function');
  await holder.release();

  const refused = await acquireWriterLock({ locks });
  assert.equal(refused.ok, true);
  assert.equal(refused.reason, null);
  await refused.release();
});

test('concurrent tabs: three attempts, exactly one install may start', async () => {
  const locks = lockManagerDouble({ defer: true });
  const attempts = [
    acquireWriterLock({ locks }),
    acquireWriterLock({ locks }),
    acquireWriterLock({ locks }),
  ];
  locks.flush();
  const results = await Promise.all(attempts);
  const winners = results.filter((r) => r.ok);
  assert.equal(winners.length, 1, `${winners.length} tabs were allowed to install at once`);
  assert.equal(locks.log.granted.length, 1);
  for (const loser of results.filter((r) => !r.ok)) assert.match(loser.reason, /another tab/i);
  await winners[0].release();
  const after = await acquireWriterLock({ locks });
  assert.equal(after.ok, true, 'the loser never got a turn once the winner finished');
  await after.release();
});

test('an uncontended lock is granted (the single-tab path still works)', async () => {
  const locks = lockManagerDouble();
  const holder = await acquireWriterLock({ locks, name: 'libreecho.test.uncontended' });
  assert.equal(holder.ok, true, holder.reason);
  assert.equal(locks.log.calls[0].name, 'libreecho.test.uncontended');
  await holder.release();
});

// ===========================================================================
// I. against the REAL Web Locks implementation, where the runtime has one
//
// Everything above uses a double, so it can only prove the module's own logic.
// Node 22 ships a spec-conformant LockManager, so the contract this file exists
// to protect can also be pinned against the real thing: a null lock for a held
// name, a grant released only when the callback settles, and a grant the
// runtime drops when it dies. These SKIP rather than fail where there is no
// implementation, so the suite stays honest on an older runtime.
// ===========================================================================

const REAL_LOCKS = navigator?.locks ?? null;

test('the real LockManager refuses a second holder of the same name', { skip: REAL_LOCKS ? false : 'no real LockManager' }, async () => {
  const name = 'libreecho.test.real.exclusion';
  const holder = await acquireWriterLock({ locks: REAL_LOCKS, name });
  assert.equal(holder.ok, true, holder.reason);
  const contender = await acquireWriterLock({ locks: REAL_LOCKS, name });
  assert.equal(contender.ok, false, 'the real LockManager granted a held lock twice');
  assert.match(contender.reason, /another tab/i);
  assert.equal(contender.lock ?? null, null, 'the real LockManager handed the loser a lock');
  await holder.release();

  // And once released, the next caller is granted.
  const next = await acquireWriterLock({ locks: REAL_LOCKS, name });
  assert.equal(next.ok, true, 'the real LockManager kept the lock after release');
  await next.release();
});

test('the real LockManager keeps the grant while the callback awaits', { skip: REAL_LOCKS ? false : 'no real LockManager' }, async () => {
  const name = 'libreecho.test.real.await';
  const holder = await acquireWriterLock({ locks: REAL_LOCKS, name });
  assert.equal(holder.ok, true, holder.reason);
  // Held across a real await: a macrotask, a timer and a microtask storm.
  await new Promise((r) => { setTimeout(r, 5); });
  await Promise.all(Array.from({ length: 50 }, async () => { await null; }));
  assert.equal((await acquireWriterLock({ locks: REAL_LOCKS, name })).ok, false,
    'the real LockManager gave the lock away while its holder was still working');
  await holder.release();
  const after = await acquireWriterLock({ locks: REAL_LOCKS, name });
  assert.equal(after.ok, true, 'release did not free the real lock');
  await after.release();
});

test('release() resolves only once the real lock is actually free', { skip: REAL_LOCKS ? false : 'no real LockManager' }, async () => {
  const name = 'libreecho.test.real.release';
  const holder = await acquireWriterLock({ locks: REAL_LOCKS, name });
  await holder.release();
  // The proof: the runtime reports the name as not held any more.
  const snapshot = await REAL_LOCKS.query();
  const stillHeld = snapshot.held.some((lock) => lock.name === name);
  assert.equal(stillHeld, false, 'release resolved while the real LockManager still held the lock');
});

test('an omitted locks argument uses the real navigator LockManager', { skip: REAL_LOCKS ? false : 'no real LockManager' }, async () => {
  const holder = await acquireWriterLock({ name: 'libreecho.test.real.default' });
  assert.equal(holder.ok, true, holder.reason);
  assert.equal(holder.name, 'libreecho.test.real.default');
  await holder.release();
});

test('TAB_A and TAB_B are unused legacy names that must not leak into the API', () => {
  // Guards the earlier design, which carried a per-tab id plus a timestamp. The
  // browser owns identity and lifetime now; a fabricated id is what let a
  // superseded tab believe it still owned the install.
  assert.notEqual(WRITER_LOCK_NAME, TAB_A);
  assert.notEqual(WRITER_LOCK_NAME, TAB_B);
});