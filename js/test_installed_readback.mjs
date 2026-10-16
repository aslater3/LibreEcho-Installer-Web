// The real helper refuses a repeated finalize with rc=1/result=failed while
// attaching fresh installed-state evidence. That narrow observation is not a
// successful finalize and must never relax ordinary phase acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { runDirectPhase } from './direct-install.js';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const pin = 'a'.repeat(64);
const digest = 'b'.repeat(64);
const boot = 'c'.repeat(64);
const options = { phase: 'finalize', dryRun: true, bundleManifestSha256: pin,
  target: 'radar_puffin', release: 'test-release', deviceDigest: digest,
  verifyInstalledBootSha256: boot };
function transport({ rc = 1, patch = {}, duplicate = '' } = {}) {
  const calls = [];
  return { calls, shell: async command => {
    calls.push(command);
    const nonce = /--invocation-id ([a-f0-9]{64})/.exec(command)[1];
    const fields = { protocol: '2', phase: 'finalize', invocation_id: nonce,
      bundle_manifest_sha256: pin, target: options.target, release: options.release,
      device_digest: digest,
      invocation_sha256: createHash('sha256').update(`2|finalize|${pin}|${digest}|${options.target}|${options.release}`).digest('hex'),
      result: 'failed', error: 'already-finalized', installed_state: 'verified',
      installed_layout: 'v3', installed_boot_sha256: boot, ...patch };
    return { stdout: `\n__HELPER_RC__${rc}\n__RECEIPT__` + Object.entries(fields)
      .filter(([,v]) => v !== undefined).map(([k,v]) => `${k}=${v}\n`).join('') + duplicate };
  } };
}
test('fresh already-finalized observation proves installed state without accepting finalize', async () => {
  const adb = transport();
  const result = await runDirectPhase({ ...options, adb });
  assert.equal(result.installed_state, 'verified');
  assert.equal(result.result, 'failed');
  assert.equal(adb.calls.length, 1);
  assert.match(adb.calls[0], /--phase finalize .*--dry-run/);
});
test('ordinary finalize dry-run still refuses the already-finalized observation', async () => {
  await assert.rejects(runDirectPhase({ ...options, verifyInstalledBootSha256: null, adb: transport() }));
});
for (const [name, change] of [
  ['wrong boot pin', { patch: { installed_boot_sha256: 'd'.repeat(64) } }],
  ['missing readback', { patch: { installed_state: undefined } }],
  ['stale nonce', { patch: { invocation_id: 'e'.repeat(64) } }],
  ['wrong digest', { patch: { invocation_sha256: 'e'.repeat(64) } }],
  ['wrong device', { patch: { device_digest: 'e'.repeat(64) } }],
  ['wrong failure', { patch: { error: 'finalize-uncertain' } }],
  ['ordinary dry-run success', { rc: 0, patch: { result: 'dry-run-ok' } }],
  ['unexpected exit', { rc: 2 }],
  ['duplicate evidence', { duplicate: 'installed_state=verified\n' }],
  ['inconsistent evidence', { patch: { installed_state_reason: 'complete-digest-mismatch' } }],
]) test(`installed observation refuses ${name}`, async () => {
  await assert.rejects(runDirectPhase({ ...options, adb: transport(change) }));
});
for (const change of [{ dryRun: false }, { phase: 'prepare' }, { deviceDigest: null },
  { verifyInstalledBootSha256: 'bad' }]) {
  test(`installed observation rejects unsafe invocation ${JSON.stringify(change)}`, async () => {
    const adb = transport();
    await assert.rejects(runDirectPhase({ ...options, ...change, adb }));
    assert.equal(adb.calls.length, 0);
  });
}
