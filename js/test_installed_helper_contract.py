#!/usr/bin/env python3
"""Host-only cross-repo contract: actual shell receipt -> production JS parser.

Pass the Platform checkout explicitly. Uses its existing regular-file block
fixture and stub mount/format/dd commands, never a device or browser. Does not
validate USB, a signed published artifact, or first boot.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import subprocess

NODE = r'''
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { runDirectPhase } from './js/direct-install.js';
const f = JSON.parse(process.argv[1]);
const adb = {shell: async command => {
  assert.match(command, /--phase finalize .*--dry-run/);
  const nonce = /--invocation-id ([a-f0-9]{64})/.exec(command)[1];
  const result = spawnSync(f.argv[0], [...f.argv.slice(1), '--dry-run', '--invocation-id', nonce],
    { encoding: 'utf8', env: f.env });
  if (result.error || result.signal) throw result.error ?? Error(result.signal);
  const { readFileSync } = await import('node:fs');
  return {stdout: result.stdout + `\n__HELPER_RC__${result.status}\n__RECEIPT__`
    + readFileSync(f.receipt, 'utf8')};
}};
const run = () => runDirectPhase({adb, phase: 'finalize', dryRun: true,
  bundleManifestSha256: f.manifest, target: f.target, release: f.release,
  deviceDigest: f.device, verifyInstalledBootSha256: f.boot });
if (f.reject) await assert.rejects(run());
else {
  const result = await run();
  assert.equal(result.result, 'failed');
  assert.equal(result.error, 'already-finalized');
  assert.equal(result.installed_state, 'verified');
  assert.equal(result.installed_boot_sha256, f.boot);
}
'''

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('platform', type=Path)
    args = parser.parse_args()
    path = args.platform / 'tools/mt8163-arm32/recovery-install/tests/test_direct_userdata_install.py'
    spec = importlib.util.spec_from_file_location('platform_install_fixture', path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    case = module.V3InstalledStateTests('test_a_completed_v3_install_reads_back_verified')
    case.setUp()
    try:
        manifest = case.install_v3()
        # Actual successful finalize lacks installed_state. A fresh observation
        # must be requested; stored installed receipts cannot serve as readback.
        assert case.h.receipt()['result'] == 'installed'
        assert 'installed_state' not in case.h.receipt()
        payload = dict(argv=case.h._argv(case.h.helper, 'finalize', manifest, ()),
                       env=case.h.helper_env(), receipt=str(case.h.state / 'receipt'),
                       manifest=module.sha256_file(manifest), target=case.h.target,
                       release=case.h.manifest_release(manifest),
                       device=case.h.guard()['device_digest'], boot=module.sha256_file(case.boot))
        root = Path(__file__).resolve().parents[1]
        for tampered in (False, True):
            if tampered:
                target = case.generation() / 'COMPLETE'
                target.chmod(0o600)
                target.write_text('0' * 64 + '\n')
            before = module.tree_snapshot(case.h.data)
            guard_before = (case.h.state / 'transaction.state').read_bytes()
            payload['reject'] = tampered
            result = subprocess.run(['node', '--input-type=module', '-e', NODE, json.dumps(payload)],
                                    cwd=root, text=True, capture_output=True, timeout=60)
            if result.returncode:
                raise AssertionError(result.stdout + result.stderr)
            case.assert_readback_wrote_nothing(before, 'browser readback')
            assert (case.h.state / 'transaction.state').read_bytes() == guard_before
            print('PASS: ' + ('tampered generation refused' if tampered else 'real finalized receipt freshly verified')
                  + '; no userdata/boot/GPT/guard mutation')
    finally:
        case.tearDown()
        case.doCleanups()

if __name__ == '__main__':
    main()
