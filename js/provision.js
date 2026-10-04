// One-shot provisioning for the browser installer (contract v1).
//
// The page collects the device setup-page settings, derives the canonical
// credential representations itself, and delivers a single
// `/data/libreecho/config/provision.json` after the install is finalized and
// before the reboot. The device's own daemon applies it on first boot through
// its canonical code paths — this module never writes `web-config.json`,
// `users`, `wpa_supplicant.conf` or a `.setup-complete` marker.
//
// Everything here is a pure function except `deliverProvision`, which owns the
// only ADB calls this feature makes. Every validator mirrors the device's own
// rule (see SETUP-PARITY-REQUIREMENTS.md §2, §4 and §5, pinned at
// LibreEcho-UI 52edef3b131fb6ed51ff4a2bca751df76c7d83fc), so a value the page
// accepts is a value `api.c`/`auth_user_management.inc` accept.

import { StageError } from "./stages.js";

export const PROVISION_SCHEMA = "libreecho-provision/1";
export const PROVISION_DIR = "/data/libreecho/config";
export const PROVISION_PATH = `${PROVISION_DIR}/provision.json`;
export const PROVISION_TMP_PATH = `${PROVISION_DIR}/provision.json.tmp`;
export const PROVISION_MAX_BYTES = 4096;

/** Contract enum: `biscuit|radar-puffin` — the target slug, not the board id. */
export const PROVISION_TARGETS = ["biscuit", "radar-puffin"];
/** `valid_wifi_security`: exactly these two. No wpa3 option exists server-side. */
export const PROVISION_WIFI_SECURITY = ["open", "wpa2"];

// Byte limits mirror the device, which measures with strlen on the UTF-8 bytes
// it stores (auth_user_management.inc, api.c LE_TEXT buffers).
export const USERNAME_MAX_BYTES = 31; // LE_AUTH_USERNAME_MAX(32) - 1
export const PASSWORD_MIN_BYTES = 8;
export const PASSWORD_MAX_BYTES = 128; // LE_AUTH_PASSWORD_MAX
export const SSID_MAX_BYTES = 32; // contract: 1..32 bytes
export const WIFI_PASSWORD_MIN_BYTES = 8;
export const WIFI_PASSWORD_MAX_BYTES = 63; // WPA passphrase
export const HOSTNAME_MAX_BYTES = 63;
export const PERCENT_MAX = 100;
export const WAKE_WORD_MAX_BYTES = 63;

// The wake word is the release's bundled model. The published bundle manifest
// declares a `staging=wakeword:` feature but carries no model names in any
// verifiable field (the signed OTA manifest lists feature *ids* only), so the
// page cannot enumerate the models a given build actually contains. The pinned
// device setup page at 52edef3b offers exactly one option — "Alexa" — with the
// copy "This image currently includes the Alexa wake model", which is also the
// value the wizard and `config/defaults.json` ship. That fixed list is used
// here, documented rather than discovered, until a release publishes a signed
// model inventory this page can verify.
export const PROVISION_WAKE_WORDS = ["Alexa"];
export const PROVISION_DEFAULT_WAKE_WORD = PROVISION_WAKE_WORDS[0];

/** Wizard defaults (LibreEcho-UI web/js/setup.js at 52edef3b). */
export const PROVISION_DEFAULTS = Object.freeze({
  hostname: "libreecho",
  volume: 64,
  wake_word: PROVISION_DEFAULT_WAKE_WORD,
  wake_sensitivity: 68,
  security: "wpa2",
  local_only: true,
  privacy_telemetry: false,
});

/** Every contract key, and nothing else, may appear in the delivered document. */
export const PROVISION_KEYS = Object.freeze(["schema", "binding", "admin", "wifi", "settings"]);
export const PROVISION_ADMIN_KEYS = Object.freeze(["users_line"]);
export const PROVISION_BINDING_KEYS = Object.freeze(["release", "target"]);
export const PROVISION_WIFI_KEYS = Object.freeze(["ssid", "security", "password"]);
export const PROVISION_SETTINGS_KEYS = Object.freeze([
  "hostname", "volume", "wake_word", "wake_sensitivity", "privacy_local_only", "privacy_telemetry",
]);

const USERNAME_CHARS = /^[A-Za-z0-9._-]+$/;
const HOSTNAME_CHARS = /^[A-Za-z0-9-]+$/;
const HEX64 = /^[0-9a-f]{64}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** UTF-8 byte length, which is what every device-side limit measures. */
export function utf8Length(value) {
  return new TextEncoder().encode(String(value ?? "")).length;
}

export function validUsername(value) {
  const text = typeof value === "string" ? value : "";
  const bytes = utf8Length(text);
  return bytes >= 1 && bytes <= USERNAME_MAX_BYTES && USERNAME_CHARS.test(text);
}

export function validPassword(value) {
  const bytes = utf8Length(typeof value === "string" ? value : "");
  return bytes >= PASSWORD_MIN_BYTES && bytes <= PASSWORD_MAX_BYTES;
}

export function validSsid(value) {
  const text = typeof value === "string" ? value : "";
  const bytes = utf8Length(text);
  return bytes >= 1 && bytes <= SSID_MAX_BYTES && !CONTROL_CHARS.test(text);
}

export function validSecurity(value) {
  return PROVISION_WIFI_SECURITY.includes(value);
}

export function validWifiPassword(value, security) {
  if (security === "open") return typeof value === "string" && value === "";
  const bytes = utf8Length(typeof value === "string" ? value : "");
  return bytes >= WIFI_PASSWORD_MIN_BYTES && bytes <= WIFI_PASSWORD_MAX_BYTES;
}

/** `valid_hostname` in api.c: 1..63 bytes, [A-Za-z0-9-], no leading/trailing `-`. */
export function validHostname(value) {
  const text = typeof value === "string" ? value : "";
  const bytes = utf8Length(text);
  return bytes >= 1 && bytes <= HOSTNAME_MAX_BYTES && HOSTNAME_CHARS.test(text)
    && text[0] !== "-" && text[text.length - 1] !== "-";
}

export function validPercent(value) {
  return Number.isInteger(value) && value >= 0 && value <= PERCENT_MAX;
}

export function validWakeWord(value) {
  if (typeof value !== "string") return false;
  return PROVISION_WAKE_WORDS.includes(value) && utf8Length(value) <= WAKE_WORD_MAX_BYTES;
}

function percentOf(value) {
  if (typeof value === "number") return value;
  if (value === "" || value === null || value === undefined) return NaN;
  return Number(value);
}

/**
 * Every reason the form is not deliverable, as `[{field, message}]`.
 *
 * An empty SSID is legal and means "no wifi block": the contract makes `wifi`
 * optional and the device then runs its own network setup on first boot.
 */
export function validateProvision(form = {}) {
  const errors = [];
  const fail = (field, message) => errors.push({ field, message });

  if (!validUsername(form.username)) {
    fail("username", `Choose an admin username of 1–${USERNAME_MAX_BYTES} characters using only letters, numbers, dot, underscore and hyphen.`);
  }
  if (!validPassword(form.password)) {
    fail("password", `The admin password must be ${PASSWORD_MIN_BYTES}–${PASSWORD_MAX_BYTES} characters.`);
  }
  if (form.password !== form.passwordConfirm) {
    fail("passwordConfirm", "The two admin passwords do not match.");
  }

  const security = form.security;
  const hasWifi = typeof form.ssid === "string" && form.ssid !== "";
  if (hasWifi) {
    if (!validSsid(form.ssid)) {
      fail("ssid", `The network name must be 1–${SSID_MAX_BYTES} characters with no control characters.`);
    }
    if (!validSecurity(security)) {
      fail("security", "Choose WPA2 or open. There is no other security type this device accepts.");
    }
    if (!validWifiPassword(form.wifiPassword, security)) {
      fail("wifiPassword", security === "open"
        ? "An open network must not carry a Wi-Fi password — clear the password box."
        : `A WPA2 passphrase must be ${WIFI_PASSWORD_MIN_BYTES}–${WIFI_PASSWORD_MAX_BYTES} characters.`);
    }
  }

  if (!validHostname(form.hostname)) {
    fail("hostname", `The hostname must be 1–${HOSTNAME_MAX_BYTES} letters, numbers or hyphens, and cannot start or end with a hyphen.`);
  }
  const volume = percentOf(form.volume);
  if (!validPercent(volume)) fail("volume", `Volume must be a whole number from 0 to ${PERCENT_MAX}.`);
  const sensitivity = percentOf(form.wakeSensitivity);
  if (!validPercent(sensitivity)) {
    fail("wakeSensitivity", `Wake sensitivity must be a whole number from 0 to ${PERCENT_MAX}.`);
  }
  if (!validWakeWord(form.wakeWord)) {
    fail("wakeWord", `Choose a wake word this build ships (${PROVISION_WAKE_WORDS.join(", ")}).`);
  }
  if (typeof form.localOnly !== "boolean") fail("localOnly", "Local-only processing must be chosen.");
  if (typeof form.telemetry !== "boolean") fail("telemetry", "Diagnostic telemetry must be chosen.");
  return errors;
}

function defaultRandomBytes(size) {
  if (!globalThis.crypto?.getRandomValues) {
    throw new StageError("configure", "this browser cannot generate secure randomness, so no account credential can be derived");
  }
  return globalThis.crypto.getRandomValues(new Uint8Array(size));
}

function toHex(bytes) {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/**
 * The canonical users-file line for one admin account:
 * `folded_username + ":sha256:" + salt + ":" + sha256(salt + ":" + password)`.
 *
 * The salt is 32 random bytes as 64 lowercase hex, exactly as the daemon's
 * `random_hex(salt, 32)` writes; the digest is plain salted SHA-256, not
 * PBKDF2 and not bcrypt (auth.c `hash_password`). The trailing newline is NOT
 * included: the device writes the line with the canonical users-file writer,
 * which appends it, so a newline here would produce an empty second record.
 *
 * The password is never returned, stored, or logged — only this line is.
 */
export async function buildUsersLine(username, password, { randomBytes = defaultRandomBytes, subtle = globalThis.crypto?.subtle } = {}) {
  if (!validUsername(username)) throw new StageError("configure", "the admin username is not accepted by the device's own rule");
  if (!validPassword(password)) throw new StageError("configure", "the admin password is not accepted by the device's own rule");
  if (!subtle?.digest) throw new StageError("configure", "this browser cannot compute SHA-256, so no account credential can be derived");
  const salt = toHex(randomBytes(32)).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(salt)) throw new StageError("configure", "the credential salt is not 64 lowercase hex characters");
  const message = new TextEncoder().encode(`${salt}:${password}`);
  const digest = toHex(new Uint8Array(await subtle.digest("SHA-256", message))).toLowerCase();
  if (!HEX64.test(digest)) throw new StageError("configure", "the credential digest is not 64 lowercase hex characters");
  return `${username.toLowerCase()}:sha256:${salt}:${digest}`;
}

/** The exact contract document, with exactly the contract keys. */
export async function buildProvisionJson(form, { release, target, usersLine = null, randomBytes } = {}) {
  const errors = validateProvision(form);
  if (errors.length) throw new StageError("configure", `fix the configuration first: ${errors[0].message}`);
  if (typeof release !== "string" || release.trim() === "") {
    throw new StageError("configure", "the release tag is required to bind the provision file");
  }
  if (!PROVISION_TARGETS.includes(target)) {
    throw new StageError("configure", `the provision target must be one of ${PROVISION_TARGETS.join("|")}, not ${target ?? "(none)"}`);
  }
  const line = usersLine ?? await buildUsersLine(form.username, form.password, { randomBytes });
  if (!validUsersLine(line)) throw new StageError("configure", "the derived account line is not in the canonical users-file format");

  const document = {
    schema: PROVISION_SCHEMA,
    binding: { release: String(release).trim(), target },
    admin: { users_line: line },
  };
  // `wifi` is optional in the contract: a blank SSID means the device keeps its
  // normal first-boot network flow.
  if (typeof form.ssid === "string" && form.ssid !== "") {
    document.wifi = {
      ssid: form.ssid,
      security: form.security,
      password: form.security === "open" ? "" : String(form.wifiPassword ?? ""),
    };
  }
  document.settings = {
    hostname: form.hostname,
    volume: percentOf(form.volume),
    wake_word: form.wakeWord,
    wake_sensitivity: percentOf(form.wakeSensitivity),
    privacy_local_only: form.localOnly === true,
    privacy_telemetry: form.telemetry === true,
  };
  return document;
}

/** `folded:sha256:<32..64 hex salt>:<64 hex digest>` — the loader's own shape. */
export function validUsersLine(line) {
  if (typeof line !== "string") return false;
  const parts = line.split(":");
  if (parts.length !== 4 || parts[0] !== parts[0].toLowerCase() || !validUsername(parts[0])) return false;
  if (parts[1] !== "sha256") return false;
  return /^[0-9a-f]{32,64}$/.test(parts[2]) && HEX64.test(parts[3]);
}

/** The secrets that must never reach the log, the URL, or browser storage. */
export function provisionSecrets(form, usersLine = null) {
  const secrets = [];
  for (const value of [form?.password, form?.passwordConfirm, form?.wifiPassword]) {
    if (typeof value === "string" && value !== "") secrets.push(value);
  }
  if (usersLine) {
    const parts = usersLine.split(":");
    if (parts.length === 4) secrets.push(parts[2], parts[3]);
  }
  return secrets;
}

/** Replaces any live secret (and any salt/digest) with a fixed mask. */
export function redactProvisionText(text, secrets) {
  let out = String(text ?? "");
  for (const secret of secrets ?? []) {
    if (typeof secret === "string" && secret.length >= 8) out = out.split(secret).join("[masked]");
  }
  return out;
}

/** True when `/data` really is mounted — `mount` lists it as a mount point. */
export function isDataMounted(stdout) {
  return / on \/data(?:\s|$)/m.test(String(stdout ?? ""));
}

/** The size reported by a `wc -c` readback, or null when it is not a number. */
export function parseByteCount(stdout) {
  const match = /(\d+)/.exec(String(stdout ?? "").trim());
  if (!match) return null;
  const size = Number(match[1]);
  return Number.isSafeInteger(size) && size >= 0 ? size : null;
}

const check = (isCancelled) => { if (isCancelled?.()) throw new StageError("configure", "aborted by the operator"); };

/**
 * Writes the provision file, once, after finalize and before the reboot.
 *
 * Order is the contract's: prove `/data` is mounted, push `provision.json.tmp`,
 * `chmod 600`, `mv -f` onto `provision.json` (so the rename is atomic and the
 * device never reads a half-written file), then read the size back. The bytes
 * are never logged, and nothing here can format or re-format userdata.
 *
 * Any failure throws: the caller reports "configuration NOT delivered" and the
 * install itself still stands.
 */
export async function deliverProvision({ adb, form, release, target, terminal = null, isCancelled = null, randomBytes } = {}) {
  if (!adb?.shell || !adb?.push) throw new StageError("configure", "a recovery ADB session is required to deliver the configuration");
  const document = await buildProvisionJson(form, { release, target, randomBytes });
  const text = JSON.stringify(document);
  const bytes = new TextEncoder().encode(text);
  if (bytes.length === 0 || bytes.length > PROVISION_MAX_BYTES) {
    throw new StageError("configure", `the provision document is ${bytes.length} bytes; the device accepts at most ${PROVISION_MAX_BYTES}`);
  }
  const secrets = provisionSecrets(form, document.admin.users_line);
  const say = (fn, message) => terminal?.[fn]?.(redactProvisionText(message, secrets));

  check(isCancelled);
  let mount;
  try {
    mount = await adb.shell("mount | grep ' /data '");
  } catch (error) {
    throw new StageError("configure", `/data could not be checked before delivery (${error.message}); nothing was written`);
  }
  check(isCancelled);
  if (!isDataMounted(mount?.stdout)) {
    throw new StageError("configure", "/data is not mounted, so the configuration was not written; the install itself is complete");
  }
  say("ok", `/data is mounted; delivering the one-shot configuration (${bytes.length} bytes, contents not shown)`);

  check(isCancelled);
  await adb.shell(`mkdir -p ${PROVISION_DIR}`);
  check(isCancelled);
  // The pushed bytes are never printed: they carry the WPA passphrase.
  say("command", `adb push provision.json → ${PROVISION_TMP_PATH} (${bytes.length} bytes)`);
  await adb.push(PROVISION_TMP_PATH, new Blob([bytes]));
  check(isCancelled);
  await adb.shell(`chmod 600 ${PROVISION_TMP_PATH}`);
  check(isCancelled);
  await adb.shell(`mv -f ${PROVISION_TMP_PATH} ${PROVISION_PATH}`);
  check(isCancelled);
  const readback = await adb.shell(`wc -c ${PROVISION_PATH}`);
  const size = parseByteCount(readback?.stdout);
  if (size !== bytes.length) {
    throw new StageError("configure", `the delivered configuration reads back as ${size ?? "no"} bytes instead of ${bytes.length}; treat it as NOT delivered`);
  }
  say("ok", `configuration delivered atomically to ${PROVISION_PATH} (${size} bytes, mode 0600)`);
  return { path: PROVISION_PATH, bytes: size };
}
