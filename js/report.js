// "Report a problem": turn the install log plus what the user typed into a
// prefilled GitHub bug report.
//
// Nothing is sent anywhere from here. The page opens github.com/.../issues/new
// with the fields filled in, and the user reviews and submits it themselves
// while signed in to GitHub. A GitHub URL is limited to about 8 KB, so the
// issue carries the end of the log and the full log is copied to the clipboard
// (and can be saved) for the user to paste or attach.

// Fixed on purpose: the ?repository= override chooses where releases come
// from, and must not also redirect bug reports somewhere else.
export const ISSUE_REPOSITORY = "aslater3/LibreEcho";
export const ISSUE_TEMPLATE = "bug.yml";
export const MAX_URL_LENGTH = 7500;

const REDACTIONS = [
  // MAC addresses.
  [/\b[0-9a-f]{2}(?:[:-][0-9a-f]{2}){5}\b/gi, "[mac]"],
  // Amazon device serials (G0…, 16 characters) in case one ever reaches the log.
  [/\bG0[0-9A-Z]{14}\b/g, "[serial]"],
  // Private IPv4 addresses.
  [/\b(?:10|127)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "[ip]"],
  [/\b192\.168\.\d{1,3}\.\d{1,3}\b/g, "[ip]"],
  [/\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/g, "[ip]"],
  // Anything shaped like key=secret.
  [/\b(psk|password|passwd|token|secret)\s*[=:]\s*\S+/gi, "$1=[redacted]"],
];

export function redact(text) {
  let out = String(text ?? "");
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}

function clean(text, limit = 4000) {
  return redact(String(text ?? "").trim()).slice(0, limit);
}

function fence(text) {
  // A log line could itself contain ``` and close the block early.
  return `\`\`\`text\n${text.replace(/```/g, "'''")}\n\`\`\``;
}

export function describeEnvironment({ userAgent = "", context = {} } = {}) {
  const rows = [
    ["Installer", context.installer || "browser installer (install.dev.libreecho.org)"],
    ["Device", context.device || "not identified yet"],
    ["Release", context.release || "none chosen"],
    ["Step", context.step || "unknown"],
    ["Browser", userAgent || "unknown"],
  ];
  return rows.map(([name, value]) => `- ${name}: ${redact(value)}`).join("\n");
}

function issueUrl(fields) {
  const params = new URLSearchParams({ template: ISSUE_TEMPLATE, ...fields });
  return `https://github.com/${ISSUE_REPOSITORY}/issues/new?${params.toString()}`;
}

/**
 * Build the prefilled issue. `log` is the plain-text install log. Returns the
 * URL, the redacted full log (for the clipboard), and how many log lines made
 * it into the URL.
 */
export function buildIssueReport({ summary, whatHappened, expected, includeLog = true, log = "", context = {}, userAgent = "" } = {}) {
  const title = `[Bug]: Browser installer: ${clean(summary, 120) || "install problem"}`;
  const fullLog = redact(log);
  const environment = describeEnvironment({ userAgent, context });
  const base = {
    title,
    component: "browser installer",
    version: redact(context.release || "unknown"),
    steps: `${clean(whatHappened) || "(not given)"}\n\n${environment}`,
    expected: clean(expected) || "The install completes.",
  };
  const lines = includeLog ? fullLog.split("\n").filter((line) => line.length) : [];
  const note = (shown) => (shown < lines.length
    ? `Last ${shown} of ${lines.length} log lines. The full log was copied to the clipboard when this issue was opened — please paste or attach it below.`
    : `Full log (${lines.length} lines).`);
  const observed = (shown) => {
    if (!includeLog) return "(The reporter chose not to include the installer log.)";
    if (!lines.length) return "(The log was empty.)";
    return `${note(shown)}\n\n${fence(lines.slice(lines.length - shown).join("\n"))}`;
  };

  // Keep as much of the end of the log as fits under the URL limit.
  let shown = lines.length;
  let url = issueUrl({ ...base, observed: observed(shown) });
  if (url.length > MAX_URL_LENGTH) {
    let low = 0;
    let high = lines.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (issueUrl({ ...base, observed: observed(mid) }).length <= MAX_URL_LENGTH) low = mid;
      else high = mid - 1;
    }
    shown = low;
    url = issueUrl({ ...base, observed: observed(shown) });
  }
  // If not even one line fits (very long user text or a huge line), send the
  // user's text only and rely on the clipboard copy.
  if (url.length > MAX_URL_LENGTH || (includeLog && lines.length && shown === 0)) {
    shown = 0;
    url = issueUrl({ ...base, observed: includeLog
      ? "The log was too long to include here. It was copied to the clipboard when this issue was opened — please paste or attach it below."
      : observed(0) });
  }
  return { url, title, fullLog, shownLines: shown, totalLines: lines.length, truncated: includeLog && shown < lines.length };
}
