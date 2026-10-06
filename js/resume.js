// The durable resume journal.
//
// A reload used to end the page: the identity, the chosen release and the
// verified bundle were all in-memory, and the device had usually already moved
// on to TWRP — where there is no fastboot identity to query, so the only button
// that could have continued the page refused. That is how a reload stranded the
// operator in TWRP.
//
// This module persists exactly one thing: a non-secret description of the
// transaction that was in progress, so a reloaded page can say "this was about
// THIS device, THIS board and THIS release" and offer one obvious Resume. It is
// deliberately the weakest possible artefact:
//
//   * It is a HINT, not an authority. Nothing in here says a phase may run, that
//     unlock may be re-sent, or that userdata may be formatted. Every one of
//     those is decided by reading the device again, which only the caller can do.
//   * It never contains a secret, and never a digest OF a secret. The raw serial
//     is stored only as a sha256 digest, because a serial is not a secret but it
//     is the operator's hardware id and it has no business in a shared store.
//   * It is fail-closed. Absent, unreadable, corrupt, wrong-version or
//     storage-denied all produce the same safe answer: no journal, start over.
//     A damaged record must never be repaired by guessing.
//   * It is namespaced under `libreecho.resume.` so it can never collide with,
//     and can never be mistaken for, the durable `libreecho.unlock.*`,
//     `libreecho.recovery.*` and `libreecho.direct.*` attempt guards. Nothing
//     here ever removes a key other than its own.

export const RESUME_JOURNAL_VERSION = 1;
export const RESUME_JOURNAL_KEY = "libreecho.resume.transaction/1";

/** Boards this installer can identify, as a resume journal may only name one. */
const KNOWN_BOARDS = new Set(["radar_puffin", "biscuit"]);

/**
 * The only phases worth recording. `fresh` means the transaction existed but no
 * device-mutating phase had started; the rest name the protocol 2 phases.
 * `provisioning` is recorded separately because configuration is delivered only
 * after `installed`, and its own delivery is re-verified from the device.
 */
const KNOWN_PHASES = new Set([
  "fresh", "prepare", "initialize", "transfer", "finalize", "provisioning",
]);

const PHASE_ORDER = ["prepare", "initialize", "transfer", "finalize", "provisioning"];

/**
 * Field names that must never be persisted, in any casing, with or without
 * separators. Matched case-insensitively after stripping `_`/`-`, so
 * `wifi_password`, `wifiPassword` and `WIFI-PASSWORD` are all caught.
 *
 * `ssid` is here because a network name identifies a person's home network;
 * `hostname` alone is not secret but is not needed either.
 */
export const SECRET_FIELD_NAMES = Object.freeze([
  "password", "passwordconfirm", "passphrase", "secret", "token", "psk",
  "pre-shared-key", "presharedkey", "wifiPassword", "ssid", "provisionForm",
  "privatekey", "keymaterial", "credential", "apikey",
]);

const HEX64 = /^[0-9a-f]{64}$/;
const RELEASE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

function normaliseName(name) {
  return String(name).toLowerCase().replace(/[-_\s]/g, "");
}

/** True when a field name looks like it carries a secret in any spelling. */
export function isSecretFieldName(name) {
  const flat = normaliseName(name);
  if (!flat) return true; // an unnamed field is not something to persist
  return SECRET_FIELD_NAMES.some((candidate) => {
    const needle = normaliseName(candidate);
    return flat === needle || flat.includes(needle);
  });
}

/**
 * Rejects a body that carries a secret field, a secret-shaped key, or a value
 * that is not a plain JSON scalar. Returns the offending field name, or null.
 */
function secretOffender(body) {
  for (const key of Object.keys(body)) {
    if (key.startsWith("__")) return `${key} (reserved)`;
    if (isSecretFieldName(key)) return key;
    const value = body[key];
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) continue;
    return `${key} (not a plain scalar)`;
  }
  return null;
}

/**
 * Validates a body and returns a normalised copy with ONLY the fields this
 * module understands. Unknown-but-safe fields are dropped rather than trusted,
 * so a newer writer's extra field cannot make an older reader proceed.
 */
function normalise(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "the journal is not an object" };
  // `JSON.parse` keeps a "__proto__" key as an OWN property, so a stored record
  // carrying one was not written by this module — or was tampered with. Refusing
  // is the fail-closed reading. The rebuilt journal below would drop the key
  // anyway, but silently proceeding would mean trusting an unknown writer.
  for (const key of Object.keys(body)) {
    if (key.startsWith("__")) return { error: `the journal carries a reserved key ${key}` };
  }
  if (body.version !== RESUME_JOURNAL_VERSION) {
    return { error: `unsupported journal version ${JSON.stringify(body.version)}` };
  }
  if (typeof body.serialSha256 !== "string" || !HEX64.test(body.serialSha256.toLowerCase())) {
    return { error: "the journal has no valid serial digest" };
  }
  if (typeof body.board !== "string" || !KNOWN_BOARDS.has(body.board)) {
    return { error: `the journal names an unknown board ${JSON.stringify(body.board ?? null)}` };
  }
  const releaseTag = body.releaseTag ?? body.release ?? null;
  if (typeof releaseTag !== "string" || !RELEASE_TOKEN.test(releaseTag)) {
    return { error: "the journal has no valid release tag" };
  }
  const phase = body.phase ?? "fresh";
  if (typeof phase !== "string" || !KNOWN_PHASES.has(phase)) {
    return { error: `the journal names an unknown phase ${JSON.stringify(phase)}` };
  }
  const unlockState = body.unlockState ?? "none";
  if (!["none", "submitted", "read-back-unlocked"].includes(unlockState)) {
    return { error: `the journal names an unknown unlock state ${JSON.stringify(unlockState)}` };
  }
  const journal = {
    version: RESUME_JOURNAL_VERSION,
    serialSha256: body.serialSha256.toLowerCase(),
    board: body.board,
    releaseTag,
    phase,
    provisionMode: body.provisionMode === "fill" ? "fill" : "skip",
    unlockState,
    updatedAt: Number.isSafeInteger(body.updatedAt) ? body.updatedAt : 0,
  };
  for (const field of ["bundleManifestSha256", "deviceDigest", "kaeruHeader", "target"]) {
    const value = body[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" || value.length > 200 || /[\s\u0000-\u001f]/.test(value)) {
      return { error: `the journal field ${field} is not a plain token` };
    }
    journal[field] = value;
  }
  return { journal };
}

function failure(reason) {
  return { ok: false, reason, journal: null };
}

/**
 * The storage seam: `{ get(key), set(key, value), remove(key) }`. Passing it in
 * keeps this module testable without a browser and keeps `localStorage` access
 * in one auditable place.
 */
export function browserStorage(store) {
  try { if (store === undefined) store = globalThis.localStorage; } catch { return null; }
  if (!store || typeof store.getItem !== "function") return null;
  return {
    get: (key) => store.getItem(key),
    set: (key, value) => store.setItem(key, value),
    remove: (key) => store.removeItem(key),
  };
}

/**
 * Reads the journal. Never throws: every failure mode returns
 * `{ ok: false, reason, journal: null }` so the caller can treat a damaged
 * record exactly like no record at all.
 */
export function readResumeJournal(storage = browserStorage()) {
  if (!storage) return failure("durable resume storage is unavailable");
  let raw;
  try {
    raw = storage.get(RESUME_JOURNAL_KEY);
  } catch (error) {
    return failure(`cannot read the resume journal (${error.message})`);
  }
  if (raw === null || raw === undefined || raw === "") return failure("there is no resume journal");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return failure("the resume journal is corrupt");
  }
  const result = normalise(parsed);
  if (result.error) return failure(`the resume journal is unusable: ${result.error}`);
  return { ok: true, journal: result.journal, reason: null };
}

/**
 * Writes the journal. Never throws. A body carrying a secret is refused
 * outright and nothing is written, because a half-written record that leaked a
 * password would be worse than no record at all.
 */
export function writeResumeJournal(storage = browserStorage(), body = null) {
  if (!storage) return failure("durable resume storage is unavailable");
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return failure("a journal body is required");
  }
  const offender = secretOffender(body);
  if (offender) return failure(`refusing to persist a secret field: ${offender}`);
  const result = normalise(body);
  if (result.error) return failure(`refusing to persist an unusable journal: ${result.error}`);
  let text;
  try {
    text = JSON.stringify(result.journal);
  } catch (error) {
    return failure(`cannot serialise the resume journal (${error.message})`);
  }
  try {
    storage.set(RESUME_JOURNAL_KEY, text);
  } catch (error) {
    return failure(`cannot persist the resume journal (${error.message})`);
  }
  return { ok: true, journal: result.journal, reason: null };
}

/**
 * Removes ONLY this module's own key. The durable attempt guards under
 * `libreecho.unlock.*`, `libreecho.recovery.*` and `libreecho.direct.*` are the
 * record of what may never be repeated, and clearing a finished transaction must
 * never be a way to erase them.
 */
export function clearResumeJournal(storage = browserStorage()) {
  if (!storage) return failure("durable resume storage is unavailable");
  try {
    storage.remove(RESUME_JOURNAL_KEY);
    return { ok: true, journal: null, reason: null };
  } catch (error) {
    return failure(`cannot clear the resume journal (${error.message})`);
  }
}

/**
 * What the page should offer after a reload.
 *
 * Every field here is deliberately conservative, and two of them are hard `false`
 * regardless of what the journal says: `mayReunUnlock` and `mayReformat`. A
 * journal is written by a browser tab, on a shared origin, from a run that may
 * have been interrupted at any point; it can therefore never be what authorises
 * re-sending `flash:brick` or re-formatting userdata. `requiresDeviceReverification`
 * is `true` for every resumable state, which is the actual contract: the journal
 * says what the page was doing, the device says whether it happened.
 */
export function classifyResumeState(read = { ok: false, journal: null }) {
  const base = {
    fresh: false,
    resumable: false,
    journal: null,
    unlockSubmitted: false,
    mayReunUnlock: false,
    mayReformat: false,
    requiresDeviceReverification: true,
    phase: null,
    board: null,
    releaseTag: null,
  };
  if (!read?.ok || !read.journal) return { ...base, fresh: true };
  const journal = read.journal;
  const phase = journal.phase ?? "fresh";
  const phasesStarted = PHASE_ORDER.indexOf(phase) > 0 || journal.unlockState !== "none";
  return {
    ...base,
    fresh: false,
    // A journal alone is not enough to resume: the caller must also re-verify
    // the immutable release assets and the device itself before continuing.
    resumable: true,
    journal,
    unlockSubmitted: journal.unlockState !== "none",
    phase,
    board: journal.board,
    releaseTag: journal.releaseTag,
  };
}