// Reload/resume and the single Connect/Resume entry.
//
// The failure this pins is the one an operator actually hit: the page was
// reloaded after a reboot, the device had already moved into TWRP, and every
// continuation path refused because a fastboot identity no longer existed. Five
// connection buttons asked for five different things, none of which was "pick up
// where you were", and the reload lost the chosen device, board and release.
//
// What has to be true now, in order:
//   * a reload restores non-secret transaction/release/board/device-digest state
//   * continuing REVERIFIES the immutable release assets and the actual on-device
//     state — the journal is a hint, never the authority
//   * a reload never redoes unlock and never reformats
//   * durable libreecho.unlock.* guards, including the legacy keys, all survive
//   * a previously granted matching device may be identified READ-ONLY on load,
//     but page load alone never starts destructive work
//   * an ambiguous device set requires an explicit choice
//   * USB-busy is one actionable explanation, not repeated log noise
//   * changed device or changed release fails safe rather than continuing
//   * secrets are never stored or logged, so provisioning is re-entered

import test from 'node:test';
import assert from 'node:assert/strict';

class Element {
  constructor() {
    this.children = []; this.listeners = new Map(); this.queryNodes = new Map();
    this.dataset = {}; this.style = {}; this.classList = { add() {}, remove() {} };
    this.scrollHeight = 0; this.scrollTop = 0; this.clientHeight = 0;
    this.textContent = ''; this.value = ''; this.disabled = false; this.hidden = false;
  }
  set innerHTML(value) { this._html = value; this.children = []; }
  get innerHTML() { return this._html ?? ''; }
  addEventListener(event, listener) { this.listeners.set(event, listener); }
  appendChild(child) { this.children.push(child); return child; }
  append(...children) { this.children.push(...children); }
  querySelector(selector) {
    if (!this.queryNodes.has(selector)) this.queryNodes.set(selector, new Element());
    return this.queryNodes.get(selector);
  }
  setAttribute(key, value) { this[key] = value; }
  focus() {} scrollIntoView() {} remove() {}
}
const elements = new Map();
globalThis.document = {
  getElementById: (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  },
  createElement: () => new Element(),
};
globalThis.window = { isSecureContext: false, location: { search: '', origin: 'https://localhost' } };

/** A shared storage double; survives across "reloads" inside one test. */
const store = new Map();
const writes = [];
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => { writes.push(key); store.set(key, String(value)); },
  removeItem: (key) => { store.delete(key); },
};

const app = await import('./app.js');
const { RESUME_JOURNAL_KEY } = await import('./resume.js');
const { sha256Bytes } = await import('./sha256.js');

const SERIAL = 'G090L90964010665';
const OTHER_SERIAL = 'G090L99999999999';
const DIGEST_SERIAL = await sha256Bytes(new TextEncoder().encode(SERIAL));
const DIGEST_OTHER = await sha256Bytes(new TextEncoder().encode(OTHER_SERIAL));
// `dd ... | od -An -tx1` returns 16 space-separated bytes; HEADER_HEX is what
// readKaeruHeader joins them into.
const HEADER_BYTES = '88 16 88 58 70 b2 03 00 4c 4b 00 00 00 00 00 00';
const HEADER_HEX = HEADER_BYTES.replace(/ /g, '');

const el = (id) => elements.get(id);
const latest = (before) => app.terminal.lines.slice(before).map((l) => l.textContent).join('\n');
const flashCalls = [];
const rebootCalls = [];
const pushes = [];
const shells = [];

/** A fake TWRP device: probes report facts, writes are recorded, never done. */
function twrp({ serial = SERIAL, board = 'radar_puffin', twrpVersion = '3.7.0_9-0',
  header = HEADER_BYTES, expdb = 'PARTNAME=expdb', sectors = '20480' } = {}) {
  const client = {
    shell: async (command) => {
      shells.push(command);
      if (command.includes('ro.twrp.version')) {
        return { stdout: `${twrpVersion}\n${board}\n${serial}\n` };
      }
      if (command.includes('uevent')) return { stdout: `${expdb}\n` };
      if (command.includes('/size')) return { stdout: `${sectors}\n` };
      if (command.includes('od -An')) return { stdout: `${header}\n` };
      if (command.startsWith('df ')) {
        return { stdout: 'Filesystem     1K-blocks      Used Available Use% Mounted on\n'
          + '/dev/block/mmcblk0p11  1048576 100000 948576  10% /cache\n' };
      }
      return { stdout: '' };
    },
    flash: async (...args) => { flashCalls.push(args); },
    reboot: async (target) => { rebootCalls.push(target); return true; },
    push: async (path) => { pushes.push(path); },
    close: async () => {},
  };
  const device = { vendorId: 0x18d1, productId: 0x4ee2, serialNumber: serial };
  return { device, client };
}

const USB_BUSY = 'another part of this page already has this USB device open';

/** Puts the page in the state a reload leaves it in: nothing but the journal. */
function reloadedPage() {
  Object.assign(app.state, {
    releases: [], release: null, board: null, target: null, targetsJson: null,
    sums: null, files: new Map(), bundleReady: false, bundleBoard: null,
    bundleHardwareAccepted: false, installProtocol: null,
    directRelease: null, directHelper: null, directManifestText: null,
    directManifestSha: null, directRoles: null, directTransferTotal: null,
    identity: null, fastboot: null, payloadBytes: null, payloadName: '',
    running: false, abort: false, fetchingBundle: false, downloadedBundle: null,
    recoveryWaiting: false, recoveryDeadline: null, recoveryAbort: null,
    recoveryGrantInFlight: false, recoveryChooserWide: false, recoveryAlreadyGranted: false,
    recoverySession: null, recoverySerial: null, recoveryAcceptedEpoch: 0, recoveryEpoch: 0,
    kaeruHeader: null, adb: null, unlockSubmitted: null, receipts: [], stageProgress: {},
    resumeBoard: null, resumeReleaseTag: null, resumeSerialSha256: null, resumePhase: null,
    resumeUnlockSubmitted: false, resumeMayReunUnlock: false, resumeMayFormat: false,
    autoIdentifiedSerial: null, resumeDeviceAmbiguous: false, usbBusyReportedFor: null,
  });
}

/** The journal a mid-transfer run would have left behind. */
function journal(overrides = {}) {
  return {
    version: 1,
    serialSha256: DIGEST_SERIAL,
    board: 'radar_puffin',
    releaseTag: 'radar-puffin-v0.14.0',
    phase: 'transfer',
    unlockState: 'submitted',
    updatedAt: 1750000000000,
    ...overrides,
  };
}

function seedJournal(overrides = {}) {
  store.set(RESUME_JOURNAL_KEY, JSON.stringify(journal(overrides)));
}

test('recording progress while secrets are filled preserves resumability without persisting the form', async () => {
  reloadedPage(); store.clear();
  app.state.identity = {serialRaw: SERIAL, profile: {board:'radar_puffin'}};
  app.state.release = {tag:'radar-puffin-v0.14.0'};
  app.state.provisionMode='fill';
  el('provision-password').value='SYNTHETIC-ADMIN-DO-NOT-STORE';
  el('provision-wifi-password').value='SYNTHETIC-WIFI-DO-NOT-STORE';
  const r=await app.recordResumeProgress({phase:'transfer'});
  assert.equal(r.ok,true,r.reason);
  const text=store.get(RESUME_JOURNAL_KEY);
  assert.doesNotMatch(text,/SYNTHETIC/);
  assert.equal(JSON.parse(text).provisionMode,'fill');
  el('provision-password').value=''; el('provision-wifi-password').value='';
});

test('prepare and fresh journals restore context rather than stranding an unlocked device',async()=>{
  for (const phase of ['fresh','prepare']) {
    reloadedPage(); seedJournal({phase,unlockState:'none'});
    const r=await app.restoreResumeState({announce:false});
    assert.equal(r.ok,true,phase);
    assert.equal(app.state.resumePhase,phase);
  }
});

test('one Connect chooser routes a fastboot interface to the fastboot probe',async()=>{
  reloadedPage(); store.clear(); let picked=0,fb=0,adb=0;
  const device={vendorId:0x0bb4,productId:0x0c01,serialNumber:SERIAL,
    configurations:[{interfaces:[{alternates:[{interfaceClass:255,interfaceSubclass:66,interfaceProtocol:3}]}]}]};
  const vars={product:'RADAR',unlock_status:'true',serialno:SERIAL,lk_build_desc:'59779ca-20220524_183401'};
  await app.connectDevice({request:async()=>{picked++;return device;},open:async()=>{adb++;throw Error('wrong protocol');},
    openBoot:async({device:d})=>{fb++;assert.equal(d,device);return {device,client:{getVar:async k=>vars[k]??''}};}});
  assert.equal(picked,1); assert.equal(fb,1); assert.equal(adb,0);
  assert.equal(app.state.identity.serialRaw,SERIAL);
});

test('auto-identification binds a usable TWRP session, rather than leaking an untracked open handle',async()=>{
  reloadedPage(); store.clear(); const s=twrp();
  const r=await app.autoIdentifyGrantedDevice({grantedDevices:async()=>[s.device],open:async()=>s});
  assert.equal(r.identified,true,r.reason);
  assert.equal(app.state.adb,s.client);
  assert.equal(app.state.recoverySession,s);
  app.invalidateRecovery();
});

test('install awaits an exclusive grant and releases it after an early stage failure', async () => {
  reloadedPage(); store.clear(); app.state.writerLock = null;
  let held = false, freed = false, requests = 0;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: {
    request: async (name, options, callback) => {
      requests++; assert.equal(options.ifAvailable, true);
      assert.equal(options.mode, 'exclusive'); assert.equal(options.steal, undefined);
      held = true;
      await callback({name});
      held = false; freed = true;
    },
  } } });
  try {
    // Missing release deliberately fails after acquisition but before USB work.
    await app.runInstall();
    assert.equal(requests, 1);
    assert.equal(held, false);
    assert.equal(freed, true, 'runInstall must await actual browser lock release');
    assert.equal(app.state.writerLock, null);
    assert.equal(app.state.running, false);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
    else delete globalThis.navigator;
  }
});

test('cancelled connect does not leave the page permanently chooser-busy',async()=>{
  reloadedPage(); store.clear();
  await app.connectDevice({request:async()=>{throw Object.assign(Error('No device selected'),{name:'NotFoundError'});}});
  assert.equal(app.state.recoveryGrantInFlight,false);
});
