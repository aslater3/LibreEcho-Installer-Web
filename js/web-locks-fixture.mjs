// A faithful `navigator.locks` for host-side (node) app-level test fixtures.
//
// WHY THIS EXISTS
// js/writer-lock.js takes the browser's own origin-wide mutex and fails CLOSED
// when there is none: no Web Locks, a rejected request or a throwing request all
// refuse the install rather than run it unguarded. There is deliberately no
// localStorage fallback, because a record this page can rewrite is not exclusion.
//
// Node 22 exposes a `navigator` global but not `navigator.locks`, so every
// app-level fixture that drives `runInstall`/`resumeInstall` fails closed at the
// lock and never reaches the behaviour it was written to test. The fix is a
// LockManager double HERE, in test support — not a production change. The browser
// has the real thing; node does not.
//
// WHY THIS IS NOT AN ALWAYS-SUCCESS STUB
// A stub whose `request` resolves immediately would hand every caller a grant.
// That makes the suite green while proving nothing about exclusion, and it is the
// single most likely way for a passing app suite to lie. This double keeps the
// four properties the real LockManager guarantees and that writer-lock.js
// actually depends on:
//
//   1. EXCLUSION. One origin-wide table of held names. At most one granted
//      callback per name at a time — and the DECISION is made in request(),
//      not in a deferred callback, so two attempts cannot both be granted.
//   2. LIFETIME. The grant exists exactly as long as the granted callback's
//      promise is pending, and not a microtask longer. A callback that returns
//      immediately releases it immediately, so a test cannot silently hold a
//      lock it never released.
//   3. ifAvailable REFUSAL. A request for a held name with `ifAvailable: true` is
//      refused NOW — the callback receives `null` and the request resolves —
//      rather than queued behind the holder. This is what lets writer-lock.js
//      tell a second tab "no" immediately instead of waiting silently.
//   4. ATOMICITY. Several attempts issued before any callback runs still settle
//      as one grant plus refusals, so callback ordering cannot decide the winner.
//
// What the real API rejects is rejected here too: a missing callback, a `steal`
// request, and a throwing granted callback (which releases the lock before
// propagating, as the browser does).
//
// LIFECYCLE. `installWebLocksFixture()` is idempotent: one double per process,
// installed on `globalThis.navigator.locks`. `resetWebLocksFixture()` drops every
// grant, queued attempt and recorded request WITHOUT uninstalling it, which is
// what an app fixture wants between tests — app.js releases the lock in a
// `finally`, but a test that fails mid-run can leave one held, and a held lock
// would refuse the NEXT test's install for a reason that has nothing to do with
// what it is testing.
//
// TEST SUPPORT ONLY. Imported solely by js/test_*.mjs fixtures; never referenced
// by index.html or any page.

const originTable = {
  /** name -> the entry currently holding the grant, absent when the name is free. */
  holders: new Map(),
  /** Entries granted a lock and not yet released. */
  granted: new Set(),
  /** Every request in order, for fixture-level assertions. */
  log: [],
  /** Attempts queued behind `defer`, awaiting flush() or a release. */
  queue: [],
  /** Whether `defer` is armed. */
  armed: false,
};

function table() {
  return originTable;
}

/**
 * Names currently granted to a callback that has not settled yet.
 *
 * Diagnostic only: a test asserts on it, production never reads it.
 */
export function heldLockNames() {
  return [...table().holders.keys()];
}

/**
 * The object to hang `locks` off. Node 22 exposes `navigator` as an accessor
 * with no setter, so a bare `globalThis.navigator = {}` throws in a module
 * (every ES module is strict). Define the property instead when it is absent.
 */
function navigatorSlot() {
  if (globalThis.navigator) return globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true, writable: true, value: {},
  });
  return globalThis.navigator;
}

/**
 * Install the double on `globalThis.navigator.locks`, where js/app.js and
 * js/writer-lock.js read it. Idempotent — calling it again returns the same
 * manager rather than stacking a second one over the same origin table.
 *
 * Returns the LockManager double so a test can inspect `query()` or drive
 * `flush()` when it needs several attempts issued before any callback runs.
 *
 * Call this AFTER any fixture that redefines `globalThis.navigator` itself (most
 * app fixtures add a fake `navigator.usb`), because a redefinition replaces the
 * whole object and would take `locks` with it.
 *
 * @param {{ defer?: boolean }} [options]
 *   `defer: true` holds every request back until `flush()`, so a test can queue
 *   several attempts and prove atomicity. It is one-shot: `flush()` releases the
 *   hold and the manager behaves normally from then on. A real browser does not
 *   stay stuck, and neither does this.
 */
export function installWebLocksFixture({ defer = false } = {}) {
  const existing = globalThis.navigator?.locks;
  if (existing && existing.__isWebLocksFixtureDouble === true) {
    table().armed = defer === true;
    return existing;
  }

  function settle(entry, error, value) {
    if (entry.settled) return; // the browser settles a request exactly once
    entry.settled = true;
    if (error) entry.reject(error);
    else entry.resolve(value);
  }

  function releaseGrant(entry) {
    if (table().holders.get(entry.name) === entry) table().holders.delete(entry.name);
    table().granted.delete(entry);
  }

  function grant(entry) {
    table().holders.set(entry.name, entry);
    table().granted.add(entry);
    entry.state = 'granted';
    // Asynchronous, as the browser is: the callback never runs inside request().
    Promise.resolve()
      .then(() => entry.callback({ name: entry.name, mode: entry.mode }))
      .then(
        (value) => {
          // The grant IS the pending callback promise. Nothing else, ever.
          releaseGrant(entry);
          settle(entry, null, value);
          pump(); // a queued requester may now be granted the free name
        },
        (error) => {
          releaseGrant(entry);
          settle(entry, error);
          pump();
        },
      );
  }

  /** Refused by ifAvailable: handed a null lock, settled at once. */
  function refuse(entry) {
    entry.state = 'refused';
    Promise.resolve()
      .then(() => entry.callback(null))
      .then((value) => settle(entry, null, value), (error) => settle(entry, error));
  }

  function pump() {
    for (const entry of table().queue.splice(0, table().queue.length)) {
      const holder = table().holders.get(entry.name);
      if (!holder) grant(entry);
      // ifAvailable is told "no" now; it is never queued behind the holder.
      else if (entry.ifAvailable) refuse(entry);
      // Without ifAvailable the browser waits for the holder to finish, so the
      // request stays queued and is pumped when that grant is released.
      else table().queue.push(entry);
    }
  }

  const locks = {
    /** The browser's own cross-tab view of this origin. */
    async query() {
      return { held: [...table().holders.keys()], pending: [] };
    },
    isHeld: (name) => table().holders.has(name),
    /** Drop every grant, as the browser does when a tab is killed or crashes. */
    kill() {
      for (const entry of [...table().granted]) {
        releaseGrant(entry);
        settle(entry, null, undefined);
      }
      pump();
    },
    request(name, options, callback) {
      const opts = typeof options === 'function' ? {} : { ...(options || {}) };
      const cb = typeof options === 'function' ? options : callback;
      table().log.push({ name, options: opts });
      if (typeof cb !== 'function') return Promise.reject(new TypeError('callback is required'));
      if (opts.steal) return Promise.reject(new Error('steal must never be requested'));
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
      if (table().armed) { table().queue.push(entry); return entry.promise; }
      // EXCLUSION is decided here, synchronously, before any callback runs. This
      // is what makes a burst of simultaneous requests atomic rather than a race.
      if (!table().holders.get(name)) grant(entry);
      else if (entry.ifAvailable) refuse(entry);
      else table().queue.push(entry);
      return entry.promise;
    },
    /** Only meaningful while `defer` is armed: run the queued attempts now. */
    flush() { table().armed = false; pump(); },
  };

  Object.defineProperty(locks, '__isWebLocksFixtureDouble', { value: true, enumerable: false });

  const target = navigatorSlot();
  target.locks = locks;
  table().armed = defer === true;
  return locks;
}

/**
 * Drop every grant, every queued attempt and every recorded request, leaving the
 * double installed on `navigator.locks`.
 *
 * An app fixture calls this between tests. app.js releases the writer lock in a
 * `finally`, so a clean run leaves nothing behind — but a test that fails
 * mid-run can leave the lock held, and the next test would then be refused by a
 * lock it never asked for and knows nothing about.
 */
export function resetWebLocksFixture() {
  table().holders.clear();
  table().granted.clear();
  table().queue.length = 0;
  table().log.length = 0;
  table().armed = false;
}