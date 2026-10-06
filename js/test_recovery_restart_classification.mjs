// Restart-into-TWRP classification.
//
// `requestRecoveryReboot` treats every non-FAIL error as "the device reset and
// dropped the link", which is the expected way `reboot-recovery` ends. That is
// true for exactly one shape of error. A transport that failed to WRITE the
// command never reached the device at all; a protocol error means the device
// answered something that was not OKAY, so it did not reset; and a client with
// no `reboot` is a programming error, not a device state.
//
// Classifying those as a successful restart is what produced the 2026-10-04
// strand: the page claimed "Your Echo is restarting" while nothing had been
// asked, and then waited ten minutes for a TWRP that was never coming. Each of
// these must instead be reported as NOT requested, so the page tells the
// operator to start TWRP by hand.

import test from 'node:test';
import assert from 'node:assert/strict';
import { requestRecoveryReboot } from './stages.js';

/** A terminal double recording exactly what reached the operator's log. */
function recorder() {
  const lines = [];
  return {
    lines,
    terminal: {
      command: (line) => lines.push(['command', line]),
      ok: (line) => lines.push(['ok', line]),
      warn: (line) => lines.push(['warn', line]),
      line: (line) => lines.push(['line', line]),
      error: (line) => lines.push(['error', line]),
      info: (line) => lines.push(['info', line]),
    },
    /** Every line the operator would read, joined. */
    text: () => lines.map(([, text]) => text).join('\n'),
  };
}

/** A fastboot error of the given class, as lib/fastboot/fastboot.js throws it. */
function fastbootError(name, message) {
  return Object.assign(new Error(message), { name });
}

// ---------------------------------------------------------------------------
// Success-shaped outcomes
// ---------------------------------------------------------------------------

test('an acknowledged reboot is a requested restart', async () => {
  const log = recorder();
  const result = await requestRecoveryReboot({
    client: { reboot: async () => true }, terminal: log.terminal,
  });
  assert.deepEqual(result, { requested: true });
  assert.match(log.text(), /restart into TWRP requested/);
});

test('a silent reboot (tolerated noReply) is still a requested restart', async () => {
  const log = recorder();
  const result = await requestRecoveryReboot({
    client: { reboot: async () => false }, terminal: log.terminal,
  });
  assert.deepEqual(result, { requested: true });
});

// ---------------------------------------------------------------------------
// The expected disconnect: the device really did reset
// ---------------------------------------------------------------------------

const EXPECTED_DISCONNECTS = [
  {
    name: 'a plain unnamed read-side stall (the link dropped mid-reply)',
    error: fastbootError('Error', 'WebUSB: transferIn failed on endpoint 2 (stalled)'),
  },
  { name: 'a transport error while reading the reply', error: fastbootError('FastbootError', 'fastboot: transport failed while reading the reply to "reboot-recovery": device disconnected') },
  { name: 'a timeout', error: fastbootError('FastbootTimeoutError', 'fastboot: timed out after 20000ms waiting for a device reply to "reboot-recovery"') },
];

for (const { name, error } of EXPECTED_DISCONNECTS) {
  test(`${name} is the expected disconnect, not a failure`, async () => {
    const log = recorder();
    const result = await requestRecoveryReboot({
      client: { reboot: async () => { throw error; } }, terminal: log.terminal,
    });
    assert.deepEqual(result, { requested: true }, `${name} was not read as a requested restart`);
    assert.match(log.text(), /this is expected/);
    assert.match(log.text(), /restart into TWRP requested/);
    assert.doesNotMatch(log.text(), /could not restart|start TWRP on the Echo yourself/i);
  });
}

// ---------------------------------------------------------------------------
// Failures that are NOT the expected disconnect
// ---------------------------------------------------------------------------

const REFUSALS = [
  {
    name: 'a transport error while SENDING the command',
    error: fastbootError('FastbootError', 'fastboot: transport failed to send "reboot-recovery": WebUSB: transferOut failed on endpoint 1 (network error)'),
    pattern: /never reached the device|did not leave/i,
  },
  {
    name: 'a protocol error (the device answered something that was not OKAY)',
    error: fastbootError('FastbootProtocolError', 'fastboot: expected OKAY from the device, received INFO'),
    pattern: /never reached the device|did not leave/i,
  },
  {
    // webusb-fastboot-transport.js throws plain unnamed Errors, so the WRITE side
    // has to be recognised from its wording. transferOut is the write: the
    // command provably never left the host.
    name: 'a plain unnamed write-side transport failure',
    error: fastbootError('Error', 'WebUSB: transferOut failed on endpoint 1 (network error)'),
    pattern: /never reached the device|did not leave/i,
  },
  {
    name: 'a plain unnamed open-side failure',
    error: fastbootError('Error', 'WebUSB: could not open the device (NotFoundError). Unplug and replug it, then retry.'),
    pattern: /never reached the device|did not leave/i,
  },
];

for (const { name, error, pattern } of REFUSALS) {
  test(`${name} is reported as NOT requested`, async () => {
    const log = recorder();
    const result = await requestRecoveryReboot({
      client: { reboot: async () => { throw error; } }, terminal: log.terminal,
    });
    assert.equal(result.requested, false, `${name} was reported as a requested restart`);
    assert.equal(typeof result.reason, 'string');
    assert.match(result.reason, pattern, `${name} did not say the command never arrived`);
    assert.doesNotMatch(log.text(), /this is expected/,
      `${name} was described as the expected disconnect`);
    assert.doesNotMatch(log.text(), /restart into TWRP requested/,
      `${name} claimed a successful restart`);
  });
}

test('an explicit FAIL is a refusal, reported as such', async () => {
  const log = recorder();
  const result = await requestRecoveryReboot({
    client: { reboot: async () => { throw fastbootError('FastbootFailError', 'fastboot: "reboot-recovery" failed: unknown command'); } },
    terminal: log.terminal,
  });
  assert.equal(result.requested, false);
  assert.match(result.reason, /unknown command/);
  assert.match(log.text(), /refused reboot-recovery/);
});

test('no connection at all is not a requested restart', async () => {
  const log = recorder();
  for (const client of [null, undefined, {}, { reboot: 'not a function' }]) {
    const result = await requestRecoveryReboot({ client, terminal: log.terminal });
    assert.equal(result.requested, false, `${JSON.stringify(client ?? null)} was read as a restart`);
    assert.match(result.reason, /no fastboot connection/i);
  }
  assert.doesNotMatch(log.text(), /fastboot reboot-recovery/, 'a command was logged with no client');
});

test('a refusal is never retried and never re-asked for', async () => {
  const log = recorder();
  let attempts = 0;
  const client = { reboot: async () => { attempts += 1; throw fastbootError('FastbootProtocolError', 'not OKAY'); } };
  await requestRecoveryReboot({ client, terminal: log.terminal });
  await requestRecoveryReboot({ client, terminal: log.terminal });
  assert.equal(attempts, 2, 'each call made exactly one attempt, so no internal retry exists');
  assert.equal(log.lines.filter(([kind]) => kind === 'command').length, 2);
});