// Test fixture: a fake expdb that answers the two ADB reads `verifyKaeruChain`
// makes, the sysfs PARTNAME lookup and `od -j -N` byte ranges. Host tests only.

const LK_MAGIC = 0x58881688;
const LK_EXT_MAGIC = 0x58891689;

function header({ magic = LK_MAGIC, dataSize = 0, name = '', ext = 0 } = {}) {
  const bytes = new Uint8Array(80);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, magic, true);
  view.setUint32(4, dataSize, true);
  bytes.set(new TextEncoder().encode(name).subarray(0, 40), 8);
  view.setUint32(48, ext, true);
  return bytes;
}

/**
 * A sparse expdb image: LK at 0, then (unless `kaeru` is false) Kaeru at
 * round8(512 + lkSize). `lkSize` matches the 16-byte HEADER the existing tests
 * use (0x03b270). `kaeruName`/`kaeruExt` alter the second header for refusals.
 */
export function expdbImage({ lkSize = 0x03b270, kaeru = true, kaeruName = 'kaeru', kaeruExt = LK_EXT_MAGIC,
  lkName = 'LK' } = {}) {
  const chunks = new Map([[0, header({ dataSize: lkSize, name: lkName })]]);
  let offset = 512 + lkSize;
  offset += (8 - (offset % 8)) % 8;
  if (kaeru) chunks.set(offset, header({ dataSize: 0x1000, name: kaeruName, ext: kaeruExt }));
  return {
    kaeruOffset: offset,
    read(start, count) {
      const out = new Uint8Array(count);
      for (const [base, bytes] of chunks) {
        for (let i = 0; i < bytes.length; i += 1) {
          const at = base + i - start;
          if (at >= 0 && at < count) out[at] = bytes[i];
        }
      }
      return out;
    },
  };
}

/**
 * Answers a shell command when it is one of the chain reads, else returns null.
 * `nodes` is what the sysfs PARTNAME lookup reports (exactly one is required).
 */
export function expdbChainReply(command, { image = expdbImage(), nodes = ['mmcblk0p7'] } = {}) {
  if (command.startsWith("grep -l '^PARTNAME=expdb$'")) {
    return { stdout: nodes.map((node) => `/sys/class/block/${node}/uevent`).join('\n') + '\n' };
  }
  const match = /^od -v -An -tx1 -j (\d+) -N (\d+) \/dev\/block\/(\w+)$/.exec(command);
  if (!match) return null;
  if (!nodes.includes(match[3])) return { stdout: '' };
  const bytes = image.read(Number(match[1]), Number(match[2]));
  return { stdout: ` ${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ')}\n` };
}
