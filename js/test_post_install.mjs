// Post-install: confirm LibreEcho actually started, then say what to do next.
// Host-only fakes; no USB, no device.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BOOT_PROBE_COMMAND, parseBootProbe, classifyBoot, pollRunningEcho, RUNNING_ADB_FILTERS,
  SETUP_COMMANDS, SETUP_URL } from './post-install.js';

const out = (o) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join('\r\n') + '\r\n';
const base = { serial: 'TESTSERIAL0001', ready: 1, web: 1, setup: 0, ip: '' };

test('the running image is matched by its measured USB identity only', () => {
  assert.deepEqual(RUNNING_ADB_FILTERS, [{ vendorId: 0x18d1, productId: 0xd001 }]);
});

test('the probe only tests presence and reads no file body', () => {
  assert.doesNotMatch(BOOT_PROBE_COMMAND, /\bcat |wpa_supplicant|users\b|secrets|provision/);
  assert.doesNotMatch(BOOT_PROBE_COMMAND, /reboot|restart|rm |mv |dd |mkfs|>\s*\/(?!dev\/null)/);
  assert.match(BOOT_PROBE_COMMAND, /startup-ready/);
  assert.match(BOOT_PROBE_COMMAND, /setup-complete/);
});

test('the setup handoff matches install guide step 5', () => {
  assert.deepEqual([...SETUP_COMMANDS], ['adb wait-for-device', 'adb forward tcp:18080 tcp:8080']);
  assert.equal(SETUP_URL, 'http://127.0.0.1:18080/setup.html');
});

test('parse: a fresh install that has not been set up', () => {
  const p = parseBootProbe(out(base));
  assert.deepEqual(p, { serial: 'TESTSERIAL0001', ready: true, web: true, setupComplete: false, ip: null });
  assert.deepEqual(classifyBoot(p), { state: 'needs-setup' });
});

test('parse: hostile values are dropped, not passed through', () => {
  assert.equal(parseBootProbe(out({ ...base, ip: '127.0.0.1' })).ip, null);
  assert.equal(parseBootProbe(out({ ...base, ip: '999.1.1.1' })).ip, null);
  assert.equal(parseBootProbe(out({ ...base, ip: '10.0.0.5"><script>' })).ip, null);
  assert.equal(parseBootProbe(out({ ...base, ready: 'yes' })).ready, false);
});

test('classify: not started yet keeps waiting', () => {
  assert.equal(classifyBoot(parseBootProbe(out({ ...base, ready: 0 }))).state, 'booting');
  assert.equal(classifyBoot(parseBootProbe(out({ ...base, web: 0 }))).state, 'booting');
  assert.equal(classifyBoot(parseBootProbe('')).state, 'booting');
});

test('classify: already set up reports its address, or that it is not on Wi-Fi', () => {
  assert.deepEqual(classifyBoot(parseBootProbe(out({ ...base, setup: 1, ip: '192.168.0.50' }))),
    { state: 'done', ip: '192.168.0.50' });
  assert.deepEqual(classifyBoot(parseBootProbe(out({ ...base, setup: 1 }))), { state: 'offline' });
});

const clock = () => { let t = 0; return { now: () => t, sleep: async (ms) => { t += ms; } }; };

test('poll: waits through boot, then reports needs-setup', async () => {
  const replies = [out({ ...base, ready: 0 }), out({ ...base, ready: 0 }), out(base)];
  const client = { shell: async () => ({ stdout: replies.shift() }) };
  const r = await pollRunningEcho({ client, expectedSerial: base.serial, ...clock() });
  assert.equal(r.verdict.state, 'needs-setup');
  assert.equal(replies.length, 0);
});

test('poll: a different Echo is refused', async () => {
  const client = { shell: async () => ({ stdout: out({ ...base, serial: 'OTHERSERIAL0002' }) }) };
  await assert.rejects(pollRunningEcho({ client, expectedSerial: base.serial, ...clock() }), /different Echo/);
});

test('poll: bounded; reports timeout with the last state', async () => {
  const client = { shell: async () => ({ stdout: out({ ...base, ready: 0 }) }) };
  const r = await pollRunningEcho({ client, expectedSerial: base.serial, timeoutMs: 9000, intervalMs: 3000, ...clock() });
  assert.deepEqual(r.verdict, { state: 'timeout', last: 'booting' });
});

test('poll: stops when cancelled', async () => {
  const client = { shell: async () => ({ stdout: out(base) }) };
  await assert.rejects(pollRunningEcho({ client, isCancelled: () => true, ...clock() }), /stopped/);
});
