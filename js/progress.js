// Progress arithmetic for the browser installer, kept pure so it can be
// unit-tested without a DOM.
//
// Sizes are shown in binary megabytes but labelled "MB" to match the release
// sizes the operator sees; durations are coarse and only ever an estimate.

export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const mb = bytes / 1048576;
  if (mb >= 1) return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** Estimated milliseconds remaining from bytes done, total and elapsed time. */
export function computeEta({ done = 0, total = 0, elapsedMs = 0 } = {}) {
  if (![done, total, elapsedMs].every(Number.isFinite)) return null;
  if (done <= 0 || total <= 0 || elapsedMs <= 0) return null;
  const rate = done / elapsedMs;
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return Math.max(0, total - done) / rate;
}

/**
 * Folds a stream of download events (as emitted by fetchReleaseBundle) into the
 * numbers the progress bar shows: percent, bytes done/total and file X of Y.
 */
export function summariseProgress(events = []) {
  let done = 0, total = 0, index = 0, count = 0, phase = "pending";
  for (const event of events) {
    if (!event) continue;
    if (event.phase) phase = event.phase;
    if (Number.isFinite(event.done)) done = Math.max(done, event.done);
    if (Number.isFinite(event.total)) total = Math.max(total, event.total);
    if (Number.isFinite(event.index)) index = Math.max(index, event.index);
    if (Number.isFinite(event.count)) count = Math.max(count, event.count);
  }
  const percent = total > 0 ? Math.min(100, (done / total) * 100) : 0;
  return { phase, done, total, index, count, percent };
}
