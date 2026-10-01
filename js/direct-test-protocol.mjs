// Recovery protocol fixture only; never imported by production code.
import { createHash } from 'node:crypto';
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function phaseReply(command, body, { rc = 0, changes = {} } = {}) {
  const arg = key => new RegExp(`--${key} ([^ ]+)`).exec(command)?.[1];
  const values = {
    protocol: '2', phase: arg('phase'), invocation_id: arg('invocation-id'),
    bundle_manifest_sha256: arg('bundle-manifest-sha256'),
    device_digest: 'd'.repeat(64), target: arg('target'), release: arg('release'),
  };
  values.invocation_sha256 = digest(Buffer.from(`2|${values.phase}|${values.bundle_manifest_sha256}|${values.device_digest}|${values.target}|${values.release}`));
  Object.assign(values, changes);
  return { stdout: `__HELPER_RC__${rc}\n__RECEIPT__${Object.entries(values).map(([k,v]) => `${k}=${v}`).join('\n')}\n${body}` };
}
export async function readbackReply(command, landed) {
  if (!command.startsWith('/sbin/sha256sum ')) return null;
  const path = command.split(' ')[1];
  const blob = landed.get(path);
  return { stdout: blob ? `${digest(Buffer.from(await blob.arrayBuffer()))}  ${path}\n` : '' };
}
