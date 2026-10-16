// Post-install: confirm LibreEcho actually started, then route to its page or
// to the in-page setup. Host-only fakes; no USB, no device.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BOOT_PROBE_COMMAND, parseBootProbe, classifyBoot, pollRunningEcho, sendSetupToRunningEcho, RUNNING_ADB_FILTERS } from './post-install.js';

const out = (o) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join('\r\n') + '\r\n';
const base = { serial: 'G090L90964010665', ready: 1, web: 1, setup: 0, pending: 0, ip: '' };

test('the running image is matched by its measured USB identity only', () => {
  assert.deepEqual(RUNNING_ADB_FILTERS, [{ vendorId: 0x18d1, productId: 0xd001 }]);
});

test('the probe reads presence and status codes only, never a secret file body', () => {
  assert.doesNotMatch(BOOT_PROBE_COMMAND, /cat |provision\.json\b(?!\s*&&)|wpa_supplicant|users\b|secrets/);
  assert.match(BOOT_PROBE_COMMAND, /startup-ready/);
  assert.match(BOOT_PROBE_COMMAND, /setup-complete/);
});

test('parse: the measured Dot output after an install with setup skipped', () => {
  const p = parseBootProbe(out(base));
  assert.deepEqual(p, { serial: 'G090L90964010665', ready: true, web: true, setupComplete: false,
    provisionPending: false, provision: null, ip: null });
  assert.deepEqual(classifyBoot(p), { state: 'needs-setup' });
});

test('parse: hostile values are dropped, not passed through', () => {
  const p = parseBootProbe(out({ ...base, ip: '127.0.0.1', provision_result: 'x;rm -rf /', provision_error: '<b>' }));
  assert.equal(p.ip, null);
  assert.equal(p.provision, null);
  assert.equal(parseBootProbe(out({ ...base, ip: '999.1.1.1' })).ip, null);
});

test('classify: not started yet keeps waiting', () => {
  assert.equal(classifyBoot(parseBootProbe(out({ ...base, ready: 0 }))).state, 'booting');
  assert.equal(classifyBoot(parseBootProbe(out({ ...base, web: 0 }))).state, 'booting');
  assert.equal(classifyBoot(parseBootProbe('')).state, 'booting');
});

test('classify: delivered settings wait for the device to apply them and join Wi-Fi', () => {
  assert.equal(classifyBoot(parseBootProbe(out({ ...base, pending: 1 }))).state, 'applying');
  assert.equal(classifyBoot(parseBootProbe(out(base)), { expectProvision: true }).state, 'applying');
  assert.equal(classifyBoot(parseBootProbe(out({ ...base, setup: 1 }))).state, 'applying');
  assert.deepEqual(classifyBoot(parseBootProbe(out({ ...base, setup: 1, ip: '192.168.0.50' }))),
    { state: 'done', ip: '192.168.0.50' });
  assert.deepEqual(classifyBoot(parseBootProbe(out({ ...base, provision_result: 'applied', ip: '10.0.0.9' }))),
    { state: 'done', ip: '10.0.0.9' });
});

test('classify: a refused or failed provision is reported, never shown as success', () => {
  const v = classifyBoot(parseBootProbe(out({ ...base, provision_result: 'partial', provision_error: 'assoc-timeout', provision_wifi: 'failed' })),
    { expectProvision: true });
  assert.deepEqual(v, { state: 'setup-failed', error: 'assoc-timeout', wifi: 'failed' });
  assert.equal(classifyBoot(parseBootProbe(out({ ...base, provision_result: 'rejected', provision_error: 'already-complete' }))).state,
    'setup-failed');
});

const clock = () => { let t = 0; return { now: () => t, sleep: async (ms) => { t += ms; } }; };

test('poll: waits through boot, then reports needs-setup', async () => {
  const replies = [out({ ...base, ready: 0 }), out({ ...base, ready: 0 }), out(base)];
  const client = { shell: async () => ({ stdout: replies.shift() }) };
  const c = clock();
  const r = await pollRunningEcho({ client, expectedSerial: base.serial, ...c });
  assert.equal(r.verdict.state, 'needs-setup');
  assert.equal(replies.length, 0);
});

test('poll: a different Echo is refused', async () => {
  const client = { shell: async () => ({ stdout: out({ ...base, serial: 'OTHER0000000000' }) }) };
  await assert.rejects(pollRunningEcho({ client, expectedSerial: base.serial, ...clock() }), /different Echo/);
});

test('poll: bounded; reports timeout with the last state', async () => {
  const client = { shell: async () => ({ stdout: out({ ...base, ready: 0 }) }) };
  const r = await pollRunningEcho({ client, expectedSerial: base.serial, timeoutMs: 9000, intervalMs: 3000, ...clock() });
  assert.deepEqual(r.verdict, { state: 'timeout', last: 'booting' });
});

test('send setup to a running Echo: atomic delivery, then only the web service restarts', async () => {
  const calls = [];
  let size = 0;
  const client = {
    shell: async (cmd) => {
      calls.push(cmd);
      if (cmd.startsWith('mount')) return { stdout: '/dev/mmcblk0p16 on /data type ext4 (rw)\n' };
      if (cmd.startsWith('wc -c')) return { stdout: `${size} /data/libreecho/config/provision.json\n` };
      return { stdout: '' };
    },
    push: async (path, blob) => { calls.push(`push ${path}`); size = blob.size; },
  };
  const form = { username: 'admin', password: 'correct horse', passwordConfirm: 'correct horse', ssid: 'Home',
    security: 'wpa2', wifiPassword: 'wifipassword', hostname: 'libreecho', volume: 50, wakeWord: 'Alexa',
    wakeSensitivity: 68, localOnly: false, telemetry: false };
  await sendSetupToRunningEcho({ client, form, release: 'r', target: 'biscuit' });
  assert.equal(calls.at(-1).startsWith('/etc/init.d/libreecho-web.init restart'), true);
  assert.ok(calls.indexOf('mv -f /data/libreecho/config/provision.json.tmp /data/libreecho/config/provision.json') < calls.length - 1);
  assert.equal(calls.some((c) => /reboot|mkfs|dd |format|twrp/.test(c)), false);
});

test('phase guards are retired only after a known outcome, and only for that device+release', async () => {
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const { directPhaseGuardKey, retireDirectPhaseGuards } = await import('./direct-install.js');
  for (const phase of ['prepare', 'initialize', 'transfer', 'finalize']) {
    store.set(await directPhaseGuardKey('SERIAL0665', 'tag-a', phase), 'pending-or-completed');
  }
  const other = await directPhaseGuardKey('SERIAL0665', 'tag-b', 'prepare');
  store.set(other, 'pending-or-completed');
  store.set('libreecho.unlock.sent.x', 'submitted-or-unknown');
  assert.equal(await retireDirectPhaseGuards({ serialRaw: 'SERIAL0665', tag: 'tag-a' }), 4);
  assert.equal(store.has(other), true, 'another release\'s unknown attempt was forgotten');
  assert.equal(store.get('libreecho.unlock.sent.x'), 'submitted-or-unknown', 'the unlock guard was touched');
  assert.equal(await retireDirectPhaseGuards({ serialRaw: '', tag: 'tag-a' }), 0);
});
