// The origin-wide writer lock.
//
// app.js already excludes two USB operations inside ONE tab (`recoveryClaims`).
// That registry is a `Map`, so a second tab of this origin sees an empty one and
// believes it is the only writer. The browser restores the previous tab's USB
// grant after a reload, so both tabs really can be live at once — and the
// operator's actual failure was a reload followed by a second press. Whatever
// protects the device has to be something a second tab cannot rewrite.
//
// That is `navigator.locks`. It is the browser's own, origin-wide mutual
// exclusion: at most one caller per origin is granted a named lock, and the
// grant lasts exactly as long as the granted callback's promise is pending.
// Three properties are the whole reason this replaced a hand-rolled mutex, and
// none of them is reproducible in application code:
//
//   * The grant is atomic. Two attempts issued before either callback runs
//     still resolve to one holder and one refusal, so exclusion cannot be lost
//     to the ordering of two callbacks.
//   * There is no heartbeat and no timestamp. A backgrounded, throttled or
//     event-loop-starved tab is still holding the lock, so a slow phase cannot
//     be mistaken for an abandoned one, and a live install cannot be stolen by
//     anyone waiting on a timer.
//   * Tab death is the browser's problem, not this page's. A closed, crashed or
//     killed tab has its grants dropped, so a hard refresh cannot strand the
//     page and there is no stale record to reclaim.
//
// Everything fails CLOSED. No Web Locks API (an insecure context, or a browser
// without it), a rejected request, a request that throws, or a granted callback
// that throws all resolve to `{ ok: false }`: the install does not start. A
// mutex that excludes nobody is worse than no mutex, so there is no degraded
// fallback.
//
// This module owns no record. It does not write to localStorage, does not read
// a clock, and does not fabricate a per-tab identity: the browser holds the
// state, which is precisely why a superseded tab cannot believe it still owns
// the install. What a half-finished run actually DID to the device stays
// ambiguous in the browser's view and must be reconciled with verified device
// evidence. The browser journal (js/resume.js) is only a hint, never authority
// for re-sending or skipping a phase.

/**
 * The contended lock name. Every tab of this origin asks for this exact string,
 * so it must never be varied per tab and must carry no secret: it is a mutex
 * name, not a record of what the operator typed.
 */
export const WRITER_LOCK_NAME = "libreecho.writer.exclusive/1";

/**
 * Historical export name, kept only so an existing caller importing it still
 * resolves. It is an alias of the same constant — NOT a storage key. Nothing in
 * this module reads or writes localStorage, and there is no stale-lock record
 * to inspect.
 */
export const WRITER_LOCK_KEY = WRITER_LOCK_NAME;

function failure(reason) {
  return { ok: false, reason, name: WRITER_LOCK_NAME, lock: null };
}

/** The LockManager, or null. `navigator.locks` is SecureContext-only. */
function lockManager(provided) {
  const locks = provided !== undefined
    ? provided
    : (globalThis.navigator?.locks ?? null);
  if (!locks || typeof locks.request !== "function") return null;
  return locks;
}

/**
 * Claims exclusive write ownership for this tab, WITHOUT stealing from anyone.
 *
 * Always returns a Promise of the result — never a bare object — so the caller
 * has exactly one control-flow shape to handle:
 *
 *   const claim = await acquireWriterLock();
 *   if (!claim.ok) { showWhyNot(claim.reason); return; }
 *   try { ...install... } finally { await claim.release(); }
 *
 * On success the result is the handle `{ ok: true, name, reason, lock, held,
 * phase, setPhase, renew, release }`:
 *   * `setPhase(phase)` records which stage this tab is on and returns true
 *     while the grant is still held. It is a label for diagnostics only.
 *   * `renew()` returns true while the grant is held. There is no heartbeat to
 *     run — it exists so a caller that already polls can keep polling, and it
 *     becomes false the moment `release()` is called.
 *   * `release()` resolves ONCE, and only after the browser has actually
 *     released the grant, so a caller can await it and know the next tab may
 *     install. It is idempotent: repeat calls resolve without letting go twice.
 *
 * The granted callback stays pending until `release()` resolves, and that pending
 * promise IS the lock. Returning from the callback early would hand the device
 * to a second tab while this one was still writing to it.
 *
 * On refusal `{ ok: false, reason }` names the cause, and there is no `release`,
 * `renew` or `setPhase` to misuse: nothing was granted, so nothing is owed.
 */
export function acquireWriterLock({ locks, name = WRITER_LOCK_NAME } = {}) {
  const manager = lockManager(locks);
  if (!manager) {
    // No exclusion means no install. There is deliberately no localStorage
    // fallback: a value this page can rewrite is not an origin-wide mutex.
    return Promise.resolve(failure(
      "this browser does not offer Web Locks, so a second tab of this page could not be excluded",
    ));
  }

  return new Promise((resolve) => {
    // Settles when the BROWSER's request has finished, which is strictly after
    // the granted callback resolved. A caller's `await release()` waits for this,
    // so when it resolves the device is genuinely free.
    let browserSettled;
    const settled = new Promise((res) => { browserSettled = res; });

    // The granted callback. The browser calls it with a Lock, or with null when
    // `ifAvailable` found the lock held — in which case the grant is refused
    // rather than queued behind the holder.
    let grant;
    let releasePromise = null;
    const granted = (lock) => new Promise((releaseGrant) => {
      if (!lock) {
        grant = null;
        resolve(failure(
          "another tab of this page is installing; close it or wait for it to finish, then press the button again",
        ));
        releaseGrant();
        return;
      }
      const lockHandle = lock;
      grant = { held: true, phase: null };
      const owned = () => grant?.held === true;
      resolve({
        ok: true,
        reason: null,
        name: lockHandle?.name ?? name,
        lock: lockHandle,
        /** True while this tab holds the grant. */
        get held() { return owned(); },
        /** The stage label, for diagnostics. */
        get phase() { return grant?.phase ?? null; },
        /** Labels the stage. False once the grant is gone. */
        setPhase(phase) {
          if (!owned()) return false;
          grant.phase = phase === null || phase === undefined ? null : String(phase);
          return true;
        },
        /**
         * True while the grant is held. Not a heartbeat — the browser renews
         * nothing because it never expires. It is here so an existing caller
         * that polls can learn it was superseded.
         */
        renew() { return owned(); },
        /**
         * Resolves once the browser has actually released the grant. Idempotent:
         * repeat calls return the same promise rather than letting go twice.
         */
        release() {
          grant.held = false;
          if (!releasePromise) releasePromise = Promise.all([releaseGrant(), settled]).then(() => undefined);
          return releasePromise;
        },
      });
    });

    // One promise for the browser's request and one for our result; they can
    // settle in either order, and neither may reject into the void. Attaching
    // both handlers here is what keeps a rejected request (a SecurityError, a
    // killed renderer, a hostile double) from surfacing as an unhandled
    // rejection after we have already answered the caller.
    let answered = false;
    const answer = (result) => { if (!answered) { answered = true; resolve(result); } };

    let request;
    try {
      request = manager.request(name, { mode: "exclusive", ifAvailable: true }, granted);
    } catch (error) {
      answer(failure(`the browser refused to hand out the install lock (${describe(error)})`));
      browserSettled();
      return;
    }
    Promise.resolve(request).then(
      () => { browserSettled(); answer(failure("the browser ended the install lock without granting it")); },
      (error) => { browserSettled(); answer(failure(`the browser refused the install lock request (${describe(error)})`)); },
    );
  });
}

function describe(error) {
  if (!error) return "no reason given";
  const name = typeof error.name === "string" && error.name ? `${error.name}: ` : "";
  const message = typeof error.message === "string" ? error.message : String(error);
  return `${name}${message}`.trim() || "no reason given";
}