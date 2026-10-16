// The Web Locks fixture the app-level tests stand on.
//
// js/writer-lock.js deliberately refuses every install when `navigator.locks` is
// absent — there is no localStorage fallback, because a record this page can
// rewrite is not an origin-wide mutex. Node 22 exposes `navigator` but not
// `navigator.locks`, so an app-level fixture that does not provide one now
// fails closed at runInstall and never reaches the path it was written to test.
//
// That is exactly what these tests pin: the fixture must be a real mutex, not an
// always-success stub. A stub would let app.js past the lock and would silently
// stop proving anything about exclusion, and it is the single most likely way to
// make a passing suite lie. Each case below would FAIL against a stub.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  installWebLocksFixture, resetWebLocksFixture, heldLockNames,
} from './web-locks-fixture.mjs';

const tick = () => new Promise((resolve) => { setImmediate(resolve); });

test.beforeEach(() => { resetWebLocksFixture(); });

test('the fixture lands on navigator.locks, where the page reads it', () => {
  const manager = installWebLocksFixture();
  assert.equal(globalThis.navigator.locks, manager,
    'app.js reads globalThis.navigator.locks, so the fixture must be installed there');
  assert.equal(typeof manager.request, 'function');
});

test('an uncontended name is granted, and the grant outlives the request call', async () => {
  const locks = installWebLocksFixture();
  let settled = false;
  const pending = locks.request('a', { mode: 'exclusive', ifAvailable: true }, () => new Promise(() => {}));
  pending.then(() => { settled = true; });

  await tick();
  assert.deepEqual(heldLockNames(), ['a'], 'a granted exclusive lock was not recorded as held');
  assert.equal(settled, false, 'the request settled while the granted callback was still pending');
  assert.deepEqual((await locks.query()).held, ['a']);
  // A sentinel that wins the race only if `pending` has NOT settled.
  const winner = await Promise.race([pending, Promise.resolve('still pending')]);
  assert.equal(winner, 'still pending', 'an unreleased lock resolved its request');
});

test('a second request for a HELD name is refused, not queued', async () => {
  const locks = installWebLocksFixture();
  const granted = [];
  locks.request('a', { ifAvailable: true }, () => new Promise(() => {}));
  await tick();
  await locks.request('a', { ifAvailable: true }, (lock) => { granted.push(lock); });

  assert.deepEqual(granted, [null],
    'a refused writer must be handed a null lock, exactly as the real LockManager does');
  assert.deepEqual(heldLockNames(), ['a'], 'the first holder lost its lock');
});

test('different names do not block each other', async () => {
  const locks = installWebLocksFixture();
  const held = [];
  locks.request('a', { ifAvailable: true }, () => new Promise(() => {}));
  locks.request('b', { ifAvailable: true }, (lock) => {
    held.push(lock?.name ?? null);
    return new Promise(() => {});
  });
  await tick();
  assert.deepEqual(held, ['b'], 'exclusion is per lock name, not global');
});

test('the lock is released only when the granted callback settles, and then is reusable', async () => {
  const locks = installWebLocksFixture();
  let letGo;
  locks.request('a', { ifAvailable: true }, () => new Promise((resolve) => { letGo = resolve; }));
  await tick();
  assert.deepEqual(heldLockNames(), ['a']);

  letGo('done');
  await tick(); await tick();
  assert.deepEqual(heldLockNames(), [], 'the lock outlived its granted callback');
  assert.deepEqual((await locks.query()).held, []);

  const second = [];
  await locks.request('a', { ifAvailable: true }, (lock) => { second.push(lock?.name ?? null); });
  assert.deepEqual(second, ['a'], 'a released lock was not granted to the next requester');
});

test('a request without a callback is a TypeError, not a silent grant', async () => {
  const locks = installWebLocksFixture();
  await assert.rejects(() => locks.request('a', {}), TypeError);
  assert.deepEqual(heldLockNames(), [], 'a rejected request still took the lock');
});

test('steal is never honoured: it cannot hand the lock to a second holder', async () => {
  const locks = installWebLocksFixture();
  locks.request('a', { ifAvailable: true }, () => new Promise(() => {}));
  await tick();
  await assert.rejects(
    () => locks.request('a', { steal: true }, () => Promise.resolve()),
    /steal/i,
    'stealing a live writer lock must be refused, never granted');
  assert.deepEqual(heldLockNames(), ['a']);
});

test('two attempts issued before either callback runs resolve to one grant and one refusal', async () => {
  // The property the browser guarantees and a hand-rolled mutex loses: the grant
  // is atomic, so ordering cannot decide the winner.
  const locks = installWebLocksFixture({ defer: true });
  const outcomes = [];
  locks.request('a', { ifAvailable: true }, (lock) => { outcomes.push(lock?.name ?? null); return new Promise(() => {}); });
  locks.request('a', { ifAvailable: true }, (lock) => { outcomes.push(lock?.name ?? null); return new Promise(() => {}); });
  locks.request('a', { ifAvailable: true }, (lock) => { outcomes.push(lock?.name ?? null); return new Promise(() => {}); });
  locks.flush();
  await tick();

  assert.equal(outcomes.filter((name) => name === 'a').length, 1, `expected exactly one grant, got ${JSON.stringify(outcomes)}`);
  assert.equal(outcomes.filter((name) => name === null).length, 2, `expected two refusals, got ${JSON.stringify(outcomes)}`);
  assert.deepEqual(heldLockNames(), ['a']);
});

test('installing after a fixture redefines navigator still lands on the new object', () => {
  // Most app fixtures replace `globalThis.navigator` wholesale to add a fake
  // `navigator.usb`. A double installed before that would be thrown away, and
  // the app would fail closed again. This is the exact install order the app
  // fixtures use, so it is pinned here rather than discovered later.
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true, writable: true, value: { usb: { getDevices: async () => [] } },
  });
  const manager = installWebLocksFixture();
  assert.equal(globalThis.navigator.locks, manager, 'locks did not follow the redefined navigator');
  assert.equal(globalThis.navigator.usb !== undefined, true, 'the fixture displaced the fake usb');
});

test('installing twice returns one manager over one origin table', async () => {
  const first = installWebLocksFixture();
  const second = installWebLocksFixture();
  assert.equal(first, second, 'a second double was stacked over the first');
  // Two "tabs" on one table: the second must still be refused.
  first.request('a', { ifAvailable: true }, () => new Promise(() => {}));
  await tick();
  const refused = [];
  await second.request('a', { ifAvailable: true }, (lock) => refused.push(lock?.name ?? null));
  assert.deepEqual(refused, [null], 'the stacked double granted a lock another tab held');
});

test('the fixture lives on node navigator, which is accessor-only by default', () => {
  // Node 22 defines `navigator` as a getter with no setter, so assigning to
  // globalThis.navigator throws inside a module. The double must not.
  assert.equal(typeof globalThis.navigator, 'object');
  assert.doesNotThrow(() => installWebLocksFixture());
  assert.equal(typeof globalThis.navigator.locks.request, 'function');
});

test('a throwing granted callback still frees the lock', async () => {
  const locks = installWebLocksFixture();
  await assert.rejects(
    () => locks.request('a', { ifAvailable: true }, () => { throw new Error('callback blew up'); }),
    /blew up/);
  assert.deepEqual(heldLockNames(), [], 'a crashed holder stranded the lock forever');
});