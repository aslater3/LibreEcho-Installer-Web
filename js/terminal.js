// Terminal-style install monitor.
//
// Deliberately plain DOM: one <ol> of lines, one optional progress row that is
// rewritten in place, and a bounded backlog so a multi-hundred-megabyte push
// cannot grow the page without limit.

const MAX_LINES = 2000;

export class Terminal {
  constructor(root, { onLine } = {}) {
    this.root = root;
    this.onLine = onLine;
    this.lines = [];
    this.progressRow = null;
    this.progressBar = null;
    this.pinned = true;
    this.root.addEventListener("scroll", () => {
      const distance = this.root.scrollHeight - this.root.scrollTop - this.root.clientHeight;
      this.pinned = distance < 40;
    });
  }

  #row(kind) {
    const line = document.createElement("li");
    line.className = `term-line term-${kind}`;
    return line;
  }

  #append(node) {
    this.root.appendChild(node);
    this.lines.push(node);
    while (this.lines.length > MAX_LINES) {
      this.lines.shift().remove();
    }
    if (this.pinned) this.root.scrollTop = this.root.scrollHeight;
  }

  #text(kind, message) {
    const line = this.#row(kind);
    line.textContent = message;
    this.#append(line);
    if (this.onLine) this.onLine({ kind, message });
    return line;
  }

  line(message) {
    return this.#text("out", message);
  }

  info(message) {
    return this.#text("info", message);
  }

  ok(message) {
    return this.#text("ok", `✓ ${message}`);
  }

  warn(message) {
    return this.#text("warn", `! ${message}`);
  }

  error(message) {
    return this.#text("error", `✗ ${message}`);
  }

  /** Big banner used for phase changes, mirroring the host installer's [n/8] rows. */
  phase(index, total, title) {
    const line = this.#row("phase");
    line.textContent = `[${index}/${total}] ${title.toUpperCase()}`;
    this.#append(line);
    return line;
  }

  command(message) {
    return this.#text("command", `$ ${message}`);
  }

  /** Progress row: created on first use, rewritten afterwards, cleared at 100%. */
  progress(label, fraction, detail = "") {
    const percent = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
    if (!this.progressRow) {
      this.progressRow = this.#row("progress");
      const name = document.createElement("span");
      name.className = "term-progress-label";
      const track = document.createElement("span");
      track.className = "term-progress-track";
      this.progressBar = document.createElement("span");
      this.progressBar.className = "term-progress-bar";
      track.appendChild(this.progressBar);
      const detailNode = document.createElement("span");
      detailNode.className = "term-progress-detail";
      this.progressRow.append(name, track, detailNode);
      this.progressLabel = name;
      this.progressDetail = detailNode;
      this.#append(this.progressRow);
    }
    this.progressLabel.textContent = label;
    this.progressBar.style.width = `${(percent * 100).toFixed(1)}%`;
    this.progressDetail.textContent = detail;
    if (this.pinned) this.root.scrollTop = this.root.scrollHeight;
  }

  /** Ends the current progress row so later output appears below it. */
  endProgress() {
    this.progressRow = null;
    this.progressBar = null;
    this.progressLabel = null;
    this.progressDetail = null;
  }

  plainText() {
    return this.lines.map((node) => node.textContent).join("\n");
  }
}
