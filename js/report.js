// "Report a problem": turn the install log plus what the user typed into a
// prefilled GitHub bug report.
//
// Nothing is sent anywhere from here. The page opens github.com/.../issues/new
// with the fields filled in, and the user reviews and submits it themselves
// while signed in to GitHub. GitHub answers 500 above roughly 7.1 kB of query
// string (measured: 6,973 bytes is served, 7,184 is not), and edge proxies drop
// longer request lines outright, so the budget below stays well under that
// ceiling. The log is the first thing to give way: the description the user
// typed is worth more than the tail of a log they can paste anyway, and the
// full log is copied to the clipboard (and can be saved) when anything is cut.

// Fixed on purpose: the ?repository= override chooses where releases come
// from, and must not also redirect bug reports somewhere else.
export const ISSUE_REPOSITORY = "aslater3/LibreEcho";
export const ISSUE_TEMPLATE = "bug.yml";
// Measured against github.com/<repo>/issues/new: 6,973 bytes returns the form,
// 7,184 returns HTTP 500, and ~8 kB fails at the edge. One kilobyte of headroom
// also absorbs template and query-parameter growth.
export const MAX_URL_LENGTH = 6000;
// Bounds for what the reporter typed. A pasted 30 kB stack trace otherwise
// consumes the whole budget before a single log line can fit.
const MAX_STEPS = 1600;
const MAX_EXPECTED = 600;
const TEXT_CUT_NOTE = "\n\nThe description was shortened to fit the link; the full text is on your clipboard.";

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
 * Build the prefilled issue. `log` is the plain-text install log.
 *
 * Returns the URL, the redacted full log (for the clipboard), how many log
 * lines made it into the URL, and whether the user's own text had to be cut.
 * `url.length` is always at most MAX_URL_LENGTH, which is why callers can open
 * it without risking the HTTP 500 GitHub returns for oversized prefill links.
 */
export function buildIssueReport({ summary, whatHappened, expected, includeLog = true, log = "", context = {}, userAgent = "" } = {}) {
  const title = `[Bug]: Browser installer: ${clean(summary, 120) || "install problem"}`;
  const fullLog = redact(log);
  const environment = describeEnvironment({ userAgent, context });
  const whatFull = String(whatHappened ?? "");
  const expectedText = clean(expected, MAX_EXPECTED) || "The install completes.";
  const lines = includeLog ? fullLog.split("\n").filter((line) => line.length) : [];

  const observed = (shown) => {
    if (!includeLog) return "(The reporter chose not to include the installer log.)";
    if (!lines.length) return "(The log was empty.)";
    if (shown === 0) {
      return "The log was too long to include here. It was copied to the clipboard when this issue was opened — please paste or attach it below.";
    }
    return (shown < lines.length
      ? `Last ${shown} of ${lines.length} log lines. The full log was copied to the clipboard when this issue was opened — please paste or attach it below.`
      : `Full log (${lines.length} lines).`)
      + `\n\n${fence(lines.slice(lines.length - shown).join("\n"))}`;
  };

  const compose = (whatText, shown, cut = false) => issueUrl({
    title,
    component: "browser installer",
    version: redact(context.release || "unknown"),
    steps: `${whatText}${cut ? TEXT_CUT_NOTE : ""}\n\n${environment}`,
    expected: expectedText,
    observed: observed(shown),
  });

  let whatText = clean(whatFull, MAX_STEPS) || "(not given)";
  let textTruncated = redact(whatFull).trim().length > whatText.length;
  let shown = lines.length;
  let url = compose(whatText, shown, textTruncated);

  // Keep as much of the end of the log as fits: the log yields first.
  if (url.length > MAX_URL_LENGTH) {
    let low = 0;
    let high = lines.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (compose(whatText, mid, textTruncated).length <= MAX_URL_LENGTH) low = mid;
      else high = mid - 1;
    }
    shown = low;
    url = compose(whatText, shown, textTruncated);
  }

  // A very long description can overflow the budget on its own; shorten it in
  // steps rather than ship a link GitHub will reject.
  for (const limit of [700, 240]) {
    if (url.length <= MAX_URL_LENGTH) break;
    const shorter = clean(whatFull, limit) || "(not given)";
    if (shorter.length < whatText.length) textTruncated = true;
    whatText = shorter;
    shown = 0;
    url = compose(whatText, shown, true);
  }

  if (url.length > MAX_URL_LENGTH) {
    // Last resort: the template's required fields only, nothing of our own.
    url = issueUrl({
      title,
      component: "browser installer",
      version: redact(context.release || "unknown"),
      steps: "(The description was too long to prefill. It was copied to the clipboard — please paste it below.)",
      expected: expectedText,
      observed: observed(0),
    });
  }
  return { url, title, fullLog, shownLines: shown, totalLines: lines.length,
    truncated: includeLog && shown < lines.length, textTruncated };
}
