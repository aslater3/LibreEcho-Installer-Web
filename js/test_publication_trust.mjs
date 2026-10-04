// Host-only regression tests: real app verification/controls, synthetic signed
// releases, fake USB only. No physical device is queried or mutated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { directFixture, combinedFixture } from './combined-fixture.mjs';

class Element {
  constructor() {
    this.children = []; this.listeners = new Map(); this.queryNodes = new Map();
    this.dataset = {}; this.style = {}; this.classList = { add() {}, remove() {} };
    this.scrollHeight = 0; this.scrollTop = 0; this.clientHeight = 0;
  }
  set innerHTML(value) { this.html = value; this.children = []; }
  get innerHTML() { return this.html ?? ''; }
  addEventListener(event, listener) { this.listeners.set(event, listener); }
  appendChild(child) { this.children.push(child); return child; }
  append(...children) { this.children.push(...children); }
  querySelector(selector) {
    if (!this.queryNodes.has(selector)) this.queryNodes.set(selector, new Element());
    return this.queryNodes.get(selector);
  }
  remove() {}
}
const elements = new Map();
globalThis.document = {
  getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); },
  createElement() { return new Element(); },
};
globalThis.window = { isSecureContext: false, location: { search: '' } };
const app = await import('./app.js');

async function verifiedFixture({ board = 'biscuit', accepted = true, protocol2 = true } = {}) {
  const fixture = protocol2 ? directFixture({ biscuitAccepted: accepted, radarAccepted: accepted })
    : combinedFixture({ biscuitAccepted: accepted, radarAccepted: accepted });
  app.state.running = false;
  app.state.release = { tag: fixture.tag, assets: fixture.assets };
  app.state.board = board;
  app.state.target = null; app.state.targetsJson = null;
  app.state.identity = null; app.state.fastboot = null; app.state.adb = null;
  app.state.recoverySerial = null; app.state.kaeruHeader = null;
  await app.verifyBundle(fixture.files);
  assert.equal(app.state.bundleReady, true, app.terminal.plainText());
  return fixture;
}
async function queryFake(board = 'biscuit', { fail = false, onRestart = null } = {}) {
  const forbidden = [];
  const restarts = [];
  const values = { product: board === 'biscuit' ? 'BISCUIT' : 'RADAR', unlock_status: 'true',
    lk_build_desc: '63cb91b-20221007_072309', serialno: 'TEST-PUBLICATION-TRUST',
    pl_build_desc: '531fa14-20170929_175430', secure: 'yes', rpmb_state: '1',
    'max-download-size': '0x6d00000' };
  await app.queryDevice({ open: async () => {
    if (fail) throw Error('synthetic chooser cancelled');
    return { device: { vendorId: 0x0bb4, productId: 0x0c01 }, client: {
      getVar: async key => values[key] ?? '',
      flash: async () => { forbidden.push('flash'); throw Error('physical writes prohibited'); },
      erase: async () => { forbidden.push('erase'); throw Error('physical writes prohibited'); },
      // The only restart an unlocked device may receive is the one into TWRP.
      reboot: async (target = null) => {
        if (target !== 'recovery') { forbidden.push(`reboot:${target}`); throw Error('physical writes prohibited'); }
        restarts.push(target);
        if (onRestart) return onRestart();
        return true;
      },
    } };
  } });
  assert.deepEqual(forbidden, []);
  forbidden.restarts = restarts;
  return forbidden;
}
function panelNext() {
  return elements.get('device-panel').children.find(row => row.querySelector('span').textContent === 'next step')
    ?.querySelector('strong').textContent;
}
function latestLog(before) { return app.terminal.lines.slice(before).map(line => line.textContent).join('\n'); }

for (const board of ['biscuit', 'radar_puffin']) {
  test(`${board}: verified target-matching publication enables Run without a manual image qualification flag`, async () => {
    await verifiedFixture({ board });
    await queryFake(board);
    assert.equal(elements.get('btn-run').disabled, false,
      'verified matching build still blocked by the permanently-false browser qualification flag');
    assert.equal(Object.hasOwn(app.state, 'markerSafe'), false, 'obsolete qualification state remains in production');
    assert.equal(panelNext(), 'recovery verification');
  });
}

test('the actual install advances to same-device recovery without an image qualification flag', async () => {
  await verifiedFixture();
  const forbidden = await queryFake();
  let recoveryProbes = 0;
  const before = app.terminal.lines.length;
  await app.runInstall({ recovery: { timeoutMs: 100, intervalMs: 1,
    grantedDevices: async () => [{ vendorId: 0x18d1, productId: 0x4ee1 }],
    openSession: async () => { recoveryProbes += 1; return null; } } });
  assert.ok(recoveryProbes > 0, 'verified matching build was rejected before the recovery boundary');
  assert.deepEqual([...forbidden], [], 'unlocked device received a flash, erase or non-recovery restart');
  assert.deepEqual(forbidden.restarts, ['recovery'], 'an unlocked device must be asked for TWRP exactly once');
  assert.match(latestLog(before), /already unlocked; skipping/i);
  assert.match(latestLog(before), /fastboot reboot-recovery/);
  assert.doesNotMatch(latestLog(before), /marker.safe|image qualification/i);
});

// Hardware, 2026-10-04: an already-unlocked Dot skipped the unlock stage and then
// sat in fastboot while the page said "Your Echo is restarting" — nothing had
// asked it to restart. The unlock payload is what restarts a locked device.
test('an already-unlocked Echo is asked for TWRP before the page starts waiting', async () => {
  await verifiedFixture();
  let probes = 0;
  let probesAtRestart = null;
  const forbidden = await queryFake('biscuit', { onRestart: () => { probesAtRestart = probes; return true; } });
  const before = app.terminal.lines.length;
  let bar = null;
  const peek = () => { if (app.state.recoveryWaiting) bar ??= elements.get('status-bar-message')?.textContent ?? ''; };
  await app.runInstall({ recovery: { timeoutMs: 100, intervalMs: 1,
    grantedDevices: async () => { peek(); return []; },
    openSession: async () => { probes += 1; peek(); return null; } } });
  assert.notEqual(bar, null, 'the page never entered the TWRP wait');
  assert.deepEqual(forbidden.restarts, ['recovery']);
  assert.equal(probesAtRestart, 0, 'the restart must be requested before the TWRP wait begins');
  assert.equal(app.state.recoveryRestartRequested, true);
  assert.deepEqual([...forbidden], []);
  assert.doesNotMatch(latestLog(before), /refused reboot-recovery/);
  assert.match(bar, /Your Echo is restarting/);
});

test('a restart that drops the reply is still a requested restart', async () => {
  await verifiedFixture();
  const forbidden = await queryFake('biscuit', { onRestart: () => {
    throw Object.assign(Error('USB transfer failed: device disconnected'), { name: 'FastbootTransportError' });
  } });
  const before = app.terminal.lines.length;
  await app.runInstall({ recovery: { timeoutMs: 50, intervalMs: 1, grantedDevices: async () => [], openSession: async () => null } });
  assert.deepEqual(forbidden.restarts, ['recovery']);
  assert.equal(app.state.recoveryRestartRequested, true);
  assert.match(latestLog(before), /closed while restarting.*expected/i);
});

test('a refused restart is reported honestly and never retried', async () => {
  await verifiedFixture();
  const forbidden = await queryFake('biscuit', { onRestart: () => {
    throw Object.assign(Error('fastboot: "reboot-recovery" failed: unknown command'), { name: 'FastbootFailError' });
  } });
  const before = app.terminal.lines.length;
  let bar = null;
  const peek = () => { if (app.state.recoveryWaiting) bar ??= elements.get('status-bar-message')?.textContent ?? ''; };
  await app.runInstall({ recovery: { timeoutMs: 50, intervalMs: 1,
    grantedDevices: async () => { peek(); return []; },
    openSession: async () => { peek(); return null; } } });
  assert.notEqual(bar, null, 'the page never entered the TWRP wait');
  assert.deepEqual(forbidden.restarts, ['recovery'], 'a refused restart must not be retried');
  assert.equal(app.state.recoveryRestartRequested, false);
  assert.match(latestLog(before), /refused reboot-recovery/);
  assert.match(latestLog(before), /start TWRP on the Echo yourself/);
  assert.doesNotMatch(bar, /Your Echo is restarting/);
  assert.match(bar, /did not accept the restart/);
});

test('a locked device is never sent the TWRP restart (the unlock payload restarts it)', async () => {
  const stages = await import('./stages.js');
  const src = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const call = src.indexOf('requestRecoveryReboot({');
  const skip = src.indexOf('device is already unlocked; skipping the unlock stage');
  const unlock = src.indexOf('submitUnlockPayload({');
  assert.ok(call > skip && skip > unlock, 'the TWRP restart must live only in the already-unlocked branch');
  assert.equal(typeof stages.requestRecoveryReboot, 'function');
});

test('a verified publication for the wrong board is disabled and refused before recovery', async () => {
  await verifiedFixture({ board: 'radar_puffin' });
  await queryFake('biscuit');
  assert.equal(elements.get('btn-run').disabled, true, 'wrong-board publication enabled Run');
  assert.match(panelNext(), /board mismatch/i);
  const before = app.terminal.lines.length;
  let recoveryProbes = 0;
  await app.runInstall({ recovery: { openSession: async () => { recoveryProbes += 1; return null; } } });
  assert.equal(recoveryProbes, 0);
  assert.match(latestLog(before), /release board mismatch/i);
});

test('a verified publication still requires identified hardware before Run is enabled', async () => {
  await verifiedFixture();
  assert.equal(elements.get('btn-run').disabled, true, 'unidentified hardware enabled Run');
  await queryFake();
  await assert.rejects(queryFake('biscuit', { fail: true }), /chooser cancelled/);
  assert.equal(elements.get('btn-run').disabled, true, 'failed query kept an earlier device eligibility');
});

test('removing the image qualification flag does not bypass hardware-acceptance metadata', async () => {
  await verifiedFixture({ accepted: false });
  await queryFake();
  assert.equal(elements.get('btn-run').disabled, true);
  assert.match(panelNext(), /not marked hardware-accepted/i);
  const before = app.terminal.lines.length;
  await app.runInstall();
  assert.match(latestLog(before), /no hardware-accepted board/i);
  assert.doesNotMatch(latestLog(before), /marker.safe|image qualification/i);
});

test('removing the image qualification flag does not permit a legacy recovery package', async () => {
  await verifiedFixture({ protocol2: false });
  await queryFake();
  assert.equal(elements.get('btn-run').disabled, true, 'legacy recovery metadata enabled Run');
  assert.match(panelNext(), /protocol v2/i);
  const before = app.terminal.lines.length;
  await app.runInstall();
  assert.match(latestLog(before), /does not publish direct-userdata protocol v2/i);
});

test('tampering after a ready bundle invalidates controls before any further install', async () => {
  const fixture = await verifiedFixture();
  await queryFake();
  const files = fixture.files.map(file => {
    if (!file.name.endsWith('-boot.img')) return file;
    const bad = new Blob(['x'.repeat(file.size)]); bad.name = file.name; return bad;
  });
  await app.verifyBundle(files);
  assert.equal(app.state.bundleReady, false, 'tampered bytes earned readiness');
  assert.equal(app.state.sums, null);
  assert.equal(elements.get('btn-run').disabled, true, 'failed re-verification left Run enabled');
  assert.match(app.terminal.plainText(), /not complete|did not match/i);
});

test('release changes invalidate ready publication state', async () => {
  await verifiedFixture(); await queryFake();
  const next = { tag: 'radar-puffin-v0.14.1', assets: [] };
  app.state.releases = [app.state.release, next];
  const select = elements.get('release-select'); select.value = next.tag;
  select.listeners.get('change')();
  assert.equal(app.state.bundleReady, false);
  assert.equal(app.state.sums, null);
  assert.equal(elements.get('btn-run').disabled, true);
});

test('operator pages no longer advertise an unimplemented marker qualification gate', async () => {
  for (const name of ['index.html', 'NOTES.html', 'README.md']) {
    const text = await readFile(new URL(`../${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /marker.safe|pending marker|positive proof that it cannot write/i,
      `${name}: stale browser qualification requirement`);
  }
});
