// The app-level fixtures' Web Locks double is only trustworthy if it makes the
// REAL writer-lock module refuse a second writer — not merely hand one out.
//
// If `js/web-locks-fixture.mjs` were an always-success stub, every app test that
// drives runInstall would go green while proving nothing about exclusion: two
// "tabs" could both install and no test would notice. These cases drive the
// unmodified production `acquireWriterLock` against the fixture, so a regression
// that made the fixture permissive fails HERE rather than silently weakening the
// whole app suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireWriterLock, WRITER_LOCK_NAME } from './writer-lock.js';
import {
  installWebLocksFixture, resetWebLocksFixture, heldLockNames,
} from './web-locks-fixture.mjs';

const tick = () => new Promise((resolve) => { setImmediate(resolve); });

test.beforeEach(() => { resetWebLocksFixture(); });

test('the fixture grants writer-lock.js a real exclusive grant it must release', async () => {
  installWebLocksFixture();
  const handle = await acquireWriterLock();
  assert.equal(handle.ok, true, handle.reason);
  assert.equal(handle.name, WRITER_LOCK_NAME);
  assert.equal(handle.held, true);
  assert.deepEqual(heldLockNames(), [WRITER_LOCK_NAME], 'no origin-wide grant was recorded');

  assert.equal(handle.release instanceof Function, true);
  await handle.release();
  assert.equal(handle.held, false, 'release() did not give the grant up');
  assert.deepEqual(heldLockNames(), [], 'the writer lock survived release()');
});

test('a second tab is refused while the first holds the writer lock', async () => {
  installWebLocksFixture();
  const first = await acquireWriterLock();
  assert.equal(first.ok, true, first.reason);

  // The exact call app.js makes at runInstall when a reload left the first tab
  // still installing. Web Locks are non-reentrant, so this must refuse.
  const second = await acquireWriterLock();
  assert.equal(second.ok, false, 'a second tab was granted the same exclusive writer lock');
  assert.match(second.reason, /another tab/i, `unhelpful refusal reason: ${second.reason}`);
  assert.equal(second.lock ?? null, null, 'a refusal handed out a lock');
  assert.equal(second.release, undefined, 'a refusal exposed a release() to misuse');

  assert.equal(first.held, true, 'the refusal stole the grant from the live holder');
  await first.release();
});

test('three simultaneous attempts on a cold lock yield exactly one install', async () => {
  // The operator's real failure: a reload, then presses in two tabs. Whichever
  // order the callbacks happen to run in, exactly one writer may proceed.
  installWebLocksFixture();
  const outcomes = [];
  const attempts = [1, 2, 3].map(() => acquireWriterLock().then((result) => {
    outcomes.push(result.ok ? 'granted' : 'refused');
    return result;
  }));
  const [first, ...rest] = await Promise.all(attempts);

  assert.equal(outcomes.filter((outcome) => outcome === 'granted').length, 1,
    `expected exactly one grant, got ${JSON.stringify(outcomes)}`);
  assert.equal(outcomes.filter((outcome) => outcome === 'refused').length, 2,
    `expected two refusals, got ${JSON.stringify(outcomes)}`);
  assert.deepEqual(heldLockNames(), [WRITER_LOCK_NAME]);
  for (const refused of rest) assert.match(refused.reason, /another tab/i);

  // Every handle is released, or this test leaks a held lock into the next one.
  await first.release();
  assert.deepEqual(heldLockNames(), [], 'the granted writer lock outlived release()');
});

test('a burst issued before any callback runs still grants exactly one', async () => {
  // The atomicity the browser guarantees and a hand-rolled mutex loses: three
  // attempts queued before any callback runs settle as one grant, two refusals.
  const locks = installWebLocksFixture({ defer: true });
  const outcomes = [];
  const attempts = [1, 2, 3].map(() => acquireWriterLock().then((result) => {
    outcomes.push(result.ok ? 'granted' : 'refused');
    return result;
  }));
  await tick();
  assert.deepEqual(outcomes, [], 'an attempt was granted before the burst completed');

  locks.flush();
  const [first, ...rest] = await Promise.all(attempts);
  assert.deepEqual(outcomes.sort(), ['granted', 'refused', 'refused'],
    `expected one grant and two refusals, got ${JSON.stringify(outcomes)}`);
  assert.deepEqual(heldLockNames(), [WRITER_LOCK_NAME]);
  for (const refused of rest) assert.equal(refused.lock ?? null, null);

  await first.release();
  assert.deepEqual(heldLockNames(), []);
});

test('release() is what ends the lock: a leaked handle keeps refusing the next tab', async () => {
  installWebLocksFixture();
  const held = await acquireWriterLock();
  assert.equal(held.ok, true);
  assert.equal((await acquireWriterLock()).ok, false, 'a second tab installed during a live run');

  await held.release();
  const next = await acquireWriterLock();
  assert.equal(next.ok, true, `the next tab was still refused after release(): ${next.reason}`);
  await next.release();
});

test('the fixture stays fail-closed when app.js never asks for the lock (dry run)', async () => {
  // Nothing to assert about app.js here — this pins that our fixture is not a
  // blanket grant: a caller that asks for a name nobody holds gets it, and only
  // that one.
  installWebLocksFixture();
  await acquireWriterLock();
  assert.equal((await acquireWriterLock({ name: 'some.other.lock' })).ok, true,
    'a DIFFERENT lock name must still be grantable — exclusion is per name');
});