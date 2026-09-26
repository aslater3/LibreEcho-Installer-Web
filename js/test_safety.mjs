import test from 'node:test';
import assert from 'node:assert/strict';
import { PROFILES, payloadForProfile } from './profiles.js';
import { assessIdentity, pushBundle, readFastbootIdentity, rebootAndWait, runRecoveryPhase, submitUnlockPayload, waitForRecovery } from './stages.js';
import * as stages from './stages.js';
import { reattachAdb } from './transports.js';

test('fastboot identity retains serial for continuity but logs only masked form', async () => {
  const lines = [];
  const terminal = { line: (line) => lines.push(line), warn: (line) => lines.push(line) };
  const values = { product: 'BISCUIT', unlock_status: 'false', lk_build_desc: '63cb91b-20221007_072309',
    pl_build_desc: 'bd7ae89-20221003_215949', serialno: 'DOT-12345678', 'max-download-size': '0x6d00000' };
  const identity = await readFastbootIdentity({ getVar: async (name) => values[name] ?? '' }, terminal);
  assert.equal(identity.serialRaw, 'DOT-12345678');
  assert.equal(identity.plBuild, 'bd7ae89-20221003_215949');
  assert.equal(lines.join('\n').includes('DOT-12345678'), false, 'serial leaked into the terminal log');
});

test('an ambiguous unlock submission cannot be re-sent in the same browser session', async () => {
  const previous = globalThis.localStorage;
  const entries = new Map();
  globalThis.localStorage = { getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value) };
  const calls = [];
  const bytes = new Uint8Array([1, 2, 3]);
  const digest = (await import('./sha256.js')).sha256Bytes(bytes);
  const pinned = { ...biscuit, lkBuildMap: { '63cb91b-20221007_072309': {
    payload: 'test.img', size: bytes.length, sha256: await digest } } };
  const args = { client: { flash: async () => { calls.push('brick'); throw new Error('timeout after write'); } },
    profile: pinned, lkBuild: '63cb91b-20221007_072309', payloadBytes: bytes,
    payloadName: 'test.img', serialRaw: 'TEST-DOT', terminal: quiet };
  try {
    assert.equal((await submitUnlockPayload(args)).outcome, 'unknown');
    await assert.rejects(submitUnlockPayload(args), /already submitted|do not re-submit|attempt.*recorded/i);
    assert.deepEqual(calls, ['brick']);
  } finally { globalThis.localStorage = previous; }
});

test('ADB reattachment skips another granted device and selects the matching serial', async () => {
  const wrong = { vendorId: 1, productId: 2, serialNumber: 'OTHER' };
  const target = { vendorId: 1, productId: 3, serialNumber: 'TARGET' };
  const closed = [];
  class FakeTransport {
    static async getDevices() { return [wrong, target]; }
    constructor(device) { this.device = device; }
    async open() { return this; }
    async close() { closed.push(this.device); }
  }
  class FakeAdb {
    constructor(transport) { this.transport = transport; }
    async connect() {}
    async shell() { return { stdout: `${this.transport.device.serialNumber}\n` }; }
    async close() { await this.transport.close(); }
  }
  const session = await reattachAdb({ expectedSerial: 'TARGET', timeoutMs: 25,
    TransportClass: FakeTransport, ClientClass: FakeAdb });
  assert.equal(session.device, target);
  assert.ok(closed.includes(wrong));
});

test('recovery reboot uses TWRP tool rather than a bare shell reboot', async () => {
  const commands = [];
  const adb = { shell: async (command) => { commands.push(command); return { stdout: '' }; } };
  await rebootAndWait({ adb, target: 'recovery', terminal: quiet, settleMs: 0 });
  assert.deepEqual(commands, ['/sbin/twrp reboot recovery']);
});

test('a valid push reports its file count after writing, without throwing', async () => {
  const file = new Blob(['verified bytes']);
  const name = 'libreecho-test-boot.img';
  const expected = await (await import('./sha256.js')).sha256Blob(file);
  const commands = [];
  const adb = { shell: async (command) => { commands.push(command); return { stdout: '' }; },
    push: async (path) => { commands.push(`push ${path}`); } };
  const result = await pushBundle({ adb, files: new Map([[name, file]]), sums: new Map([[name, expected]]), terminal: quiet });
  assert.equal(result.fileCount, 1);
  assert.equal(result.pushedBytes, file.size);
  assert.equal(commands.filter((command) => command.startsWith('push ')).length, 1);
});

test('an unqualified LK build suffix never selects a privileged payload', () => {
  const profile = PROFILES.find((entry) => entry.id === 'radar');
  assert.equal(payloadForProfile(profile, '59779ca-20220524_183401-unqualified-rebuild'), null);
  assert.ok(payloadForProfile(profile, '59779ca-20220524_183401'));
});

test('unlock attempt persists across tabs without storing the raw serial', async () => {
  const previousLocal = globalThis.localStorage;
  const previousSession = globalThis.sessionStorage;
  const entries = new Map();
  globalThis.localStorage = { getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value) };
  const bytes = new Uint8Array([1, 2, 3]);
  const pinned = { ...biscuit, lkBuildMap: { '63cb91b-20221007_072309': {
    payload: 'test.img', size: bytes.length,
    sha256: await (await import('./sha256.js')).sha256Bytes(bytes) } } };
  const writes = [];
  const args = { client: { flash: async () => { writes.push('brick'); throw new Error('timeout'); } },
    profile: pinned, lkBuild: '63cb91b-20221007_072309', payloadBytes: bytes,
    payloadName: 'test.img', serialRaw: 'TEST-DOT', terminal: quiet };
  try {
    globalThis.sessionStorage = { getItem() { return null; }, setItem() {} };
    assert.equal((await submitUnlockPayload(args)).outcome, 'unknown');
    globalThis.sessionStorage = { getItem() { return null; }, setItem() {} }; // a second tab
    await assert.rejects(submitUnlockPayload(args), /already submitted|do not re-submit/i);
    assert.deepEqual(writes, ['brick']);
    assert.equal(JSON.stringify([...entries]).includes('TEST-DOT'), false);
  } finally { globalThis.localStorage = previousLocal; globalThis.sessionStorage = previousSession; }
});

test('a recovery ZIP phase never silently repeats after a receipt or unknown outcome', async () => {
  const prior = globalThis.localStorage;
  const entries = new Map();
  globalThis.localStorage = { getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value) };
  const commands = [];
  const adb = { shell: async (command) => { commands.push(command);
    return { stdout: command.startsWith('twrp install') ? '__RECEIPT__result=installed\n' : '' }; } };
  const args = { adb, tag: 'radar-puffin-v0.14.0', serialRaw: 'TEST-DOT', phase: 'prepare' };
  try {
    assert.equal((await runRecoveryPhase(args, { terminal: quiet })).result, 'installed');
    const count = commands.length;
    await assert.rejects(runRecoveryPhase(args, { terminal: quiet }), /already attempted|pending|classif/i);
    assert.equal(commands.length, count, 'a second ZIP attempt reached ADB');
  } finally { globalThis.localStorage = prior; }
});

test('a disconnected recovery ZIP remains pending and cannot be retried', async () => {
  const prior = globalThis.localStorage;
  const entries = new Map();
  globalThis.localStorage = { getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value) };
  const commands = [];
  const adb = { shell: async (command) => { commands.push(command);
    if (command.startsWith('twrp install')) throw new Error('USB disconnected');
    return { stdout: '' };
  } };
  const args = { adb, tag: 'radar-puffin-v0.14.1', serialRaw: 'TEST-DOT', phase: 'prepare' };
  try {
    await assert.rejects(runRecoveryPhase(args, { terminal: quiet }), /USB disconnected/);
    const count = commands.length;
    await assert.rejects(runRecoveryPhase(args, { terminal: quiet }), /already attempted|pending|classif/i);
    assert.equal(commands.length, count);
  } finally { globalThis.localStorage = prior; }
});

const biscuit = PROFILES.find((profile) => profile.id === 'biscuit');
const quiet = { line() {}, info() {}, ok() {}, warn() {}, error() {}, command() {}, endProgress() {} };

test('rehearsal never sends a recovery command or creates a device flag', async () => {
  const commands = [];
  const adb = { shell: async (command) => {
    commands.push(command);
    return { stdout: '__RECEIPT__result=installed\n' };
  } };
  await runRecoveryPhase({ adb, tag: 'radar-puffin-v0.14.0' }, { dryRun: true, terminal: quiet });
  assert.deepEqual(commands, [], `rehearsal wrote to the device: ${commands.join(' | ')}`);
});

test('incorrect Biscuit payload cannot reach flash:brick', async () => {
  const calls = [];
  const client = { flash: async (...args) => { calls.push(args); } };
  await assert.rejects(
    submitUnlockPayload({ client, profile: biscuit, lkBuild: '63cb91b-20221007_072309',
      payloadBytes: new Uint8Array([1, 2, 3]), payloadName: 'fastbrick-20221007.img', terminal: quiet }),
    /digest|size|payload/i,
  );
  assert.deepEqual(calls, [], 'invalid payload was sent to flash:brick');
});

test('a bundle digest mismatch is refused before mkdir or push', async () => {
  const calls = [];
  const adb = {
    shell: async (...args) => { calls.push(['shell', ...args]); return { stdout: '' }; },
    push: async (...args) => { calls.push(['push', ...args]); },
  };
  const filename = 'libreecho-test-boot.img';
  const files = new Map([[filename, new Blob(['incorrect'])]]);
  const sums = new Map([[filename, '0'.repeat(64)]]);
  await assert.rejects(pushBundle({ adb, files, sums, terminal: quiet }), /digest|hash|verified|mismatch/i);
  assert.deepEqual(calls, [], 'unverified bytes reached ADB');
});

test('missing unlock_status is not classified as a locked device', () => {
  const assessment = assessIdentity({ product: 'BISCUIT', profile: biscuit, unlockStatus: '' }, quiet);
  assert.ok(assessment.findings.some((finding) => /unlock_status|lock state/i.test(finding)),
    'missing lock status must block unlock');
});

test('Kaeru preflight reads expdb header and refuses FASTBOOT_PLEASE without writing', async () => {
  assert.equal(typeof stages.readKaeruHeader, 'function', 'Kaeru reader is required before recovery writes');
  const calls = [];
  const adb = { shell: async (command) => {
    calls.push(command);
    if (command.includes('uevent')) return { stdout: 'PARTNAME=expdb\n' };
    if (command.includes('/size')) return { stdout: '20480\n' };
    return { stdout: '46 41 53 54 42 4f 4f 54 5f 50 4c 45 41 53 45 00\n' };
  } };
  await assert.rejects(stages.readKaeruHeader(adb), /FASTBOOT_PLEASE|Kaeru|expdb/i);
  assert.ok(calls.length >= 3, 'the partition identity and its bytes were not inspected');
  assert.ok(calls.every((command) => !/of=|rm -|erase|printf FASTBOOT/.test(command)), 'the guard wrote to the device');
});

test('Kaeru preflight returns an exact header for before/after comparison', async () => {
  assert.equal(typeof stages.readKaeruHeader, 'function');
  const adb = { shell: async (command) => ({ stdout: command.includes('uevent') ? 'PARTNAME=expdb\n'
    : command.includes('/size') ? '20480\n'
      : '88 16 88 58 70 b2 03 00 4c 4b 00 00 00 00 00 00\n' }) };
  assert.equal(await stages.readKaeruHeader(adb), '8816885870b203004c4b000000000000');
});

test('recovery wait rejects another granted USB device even when it says TWRP', async () => {
  let closed = 0;
  const session = { client: { shell: async () => ({ stdout: '3.7.0_9-0\nbiscuit\nOTHER-DEVICE\n' }), close: async () => { closed += 1; } } };
  await assert.rejects(waitForRecovery({ timeoutMs: 8, intervalMs: 1, expectedSerial: 'TARGET-DOT',
    openSession: async () => session, terminal: quiet }), /timed out|different device|serial/i);
  assert.ok(closed > 0, 'wrong TWRP session was never inspected/closed');
});
