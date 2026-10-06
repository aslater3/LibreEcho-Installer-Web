// An Echo that already finished an install. Host-only fakes; no USB.
//
// On the Dot the second run's prepare was refused `already-finalized` and the
// page showed "recovery helper exit status missing or nonzero"; a second press
// then hit the browser's own latch. What must be true now:
//   * the finished record is detected BEFORE any phase runs, and nothing is written
//   * moving it aside needs an explicit choice, keeps it (rename, never delete),
//     and refuses anything that is not finished
//   * the bar never moves backwards from the pre-run steps into the run
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  readTransactionGuard, retireFinalizedTransaction, retireFinalizedCommand,
  RESUME_EXIT_MARKER, RESUME_END_MARKER,
} = await import('./resume-device.js');

const D = 'a'.repeat(64);
const guardBody = (phase) => [
  'schema=1', 'protocol=2', 'target=biscuit', 'release=radar-puffin-build-x',
  `bundle_manifest_sha256=${D}`, `device_digest=${D}`, 'format_state=formatted', `phase=${phase}`,
].join('\n');

function fakeTwrp({ guard = null } = {}) {
  const files = new Map();
  if (guard !== null) files.set('/cache/libreecho-direct/transaction.state', guard);
  const calls = [];
  return {
    calls, files,
    shell: async (cmd) => {
      calls.push(cmd);
      if (cmd.includes(RESUME_EXIT_MARKER) && cmd.includes('transaction.state')) {
        const body = files.get('/cache/libreecho-direct/transaction.state');
        return { stdout: body === undefined ? `${RESUME_EXIT_MARKER}2\n${RESUME_END_MARKER}\n`
          : `${RESUME_EXIT_MARKER}0\n${body}\n${RESUME_END_MARKER}\n` };
      }
      if (cmd.includes('__LIBREECHO_RETIRE__')) {
        const body = files.get('/cache/libreecho-direct/transaction.state');
        if (!/^phase=finalized$/m.test(body ?? '')) return { stdout: '__LIBREECHO_RETIRE__=notfinalized\n' };
        const stamp = /\.finalized-([0-9A-Za-z]+)/.exec(cmd)[1];
        files.delete('/cache/libreecho-direct/transaction.state');
        files.set(`/cache/libreecho-direct.finalized-${stamp}/transaction.state`, body);
        return { stdout: '__LIBREECHO_RETIRE__=ok\n' };
      }
      return { stdout: '' };
    },
  };
}

test('a finished install record is read and recognised; an absent one is null', async () => {
  assert.equal((await readTransactionGuard(fakeTwrp({ guard: guardBody('finalized') }))).phase, 'finalized');
  assert.equal(await readTransactionGuard(fakeTwrp()), null);
});

test('moving the record aside renames it, keeping every byte', async () => {
  const twrp = fakeTwrp({ guard: guardBody('finalized') });
  const archive = await retireFinalizedTransaction(twrp, { stamp: '20261006140000' });
  assert.equal(archive, '/cache/libreecho-direct.finalized-20261006140000');
  assert.equal(twrp.files.get(`${archive}/transaction.state`), guardBody('finalized'));
  assert.equal(twrp.calls.some((c) => /\brm\b/.test(c)), false, 'the record was deleted rather than kept');
});

test('an interrupted install is never moved aside', async () => {
  for (const phase of ['prepare', 'initialize', 'transfer', 'finalizing']) {
    const twrp = fakeTwrp({ guard: guardBody(phase) });
    await assert.rejects(retireFinalizedTransaction(twrp, { stamp: '1' }), /not finished/);
    assert.equal(twrp.calls.some((c) => c.includes('mv ')), false, `${phase}: a rename was attempted`);
  }
  await assert.rejects(retireFinalizedTransaction(fakeTwrp(), { stamp: '1' }), /no install record/);
});

test('the rename is re-checked on the device and refuses an unsafe stamp', () => {
  const cmd = retireFinalizedCommand('20261006140000');
  assert.match(cmd, /grep -qx 'phase=finalized'/, 'the device-side check that it is still finished is missing');
  assert.match(cmd, /\[ -e "\$__a" \]/, 'an existing archive could be overwritten');
  assert.throws(() => retireFinalizedCommand('x; rm -rf /'));
});
