import { createHash } from 'node:crypto';
import { requiredBundleMembers } from './profiles.js';
export const hash = b => createHash('sha256').update(b).digest('hex');
export function tar(entries) {
  const parts = [];
  for (const [name, value] of entries) {
    const b = Buffer.from(value); const h = Buffer.alloc(512);
    h.write(name); h.write('0000644\0',100); h.write('0000000\0',108); h.write('0000000\0',116);
    h.write(b.length.toString(8).padStart(11,'0')+'\0',124); h.write('00000000000\0',136);
    h.fill(32,148,156); h[156]=48; h.write('ustar\0',257);
    const checksum = h.reduce((n,x)=>n+x,0); h.write(checksum.toString(8).padStart(6,'0')+'\0 ',148);
    parts.push(h,b,Buffer.alloc((512-b.length%512)%512));
  }
  return Buffer.concat([...parts,Buffer.alloc(1024)]);
}
/**
 * A minimal stored-only (method 0) ZIP writer for fixtures. The browser reader
 * (`amonet.js`) intentionally supports stored and deflate-raw members; fixtures
 * use stored bytes so the archive is deterministic and byte-exact.
 */
export function zipBuffer(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const body = Buffer.from(data);
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 14); // CRC-32 is not validated by the reader.
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}

export function completeFixture(tag = 'radar-puffin-v0.14.0') {
  const prefix = `libreecho-${tag}`;
  const metadata = new Map([['manifest.json', '{}'],['manifest','signed bytes'],['manifest.sig','signature bytes']]);
  const bytes = new Map(requiredBundleMembers(tag).filter(n=>!n.endsWith('SHA256SUMS')).map(n=>[n,n.endsWith('-build.json') ? JSON.stringify({board:'radar_puffin', hardware_accepted:true}) : `bytes ${n}`]));
  bytes.set(`${prefix}-initial-install.tar`,tar([['manifest.json',metadata.get('manifest.json')]]));
  bytes.set(`${prefix}.ota.tar`,tar([['manifest',metadata.get('manifest')],['manifest.sig',metadata.get('manifest.sig')]]));
  bytes.set('bundle.manifest',[...metadata].map(([n,b])=>`${n==='manifest.json'?'install_manifest':'payload'}=${n}:${hash(b)}`).join('\n'));
  bytes.set(`${prefix}-SHA256SUMS`,[...bytes].filter(([n])=>!['bundle.manifest','libreecho-install.zip'].includes(n)).map(([n,b])=>`${hash(b)}  ${n}`).join('\n'));
  bytes.set(`${prefix}-TWRPINSTALL-SHA256SUMS`,['bundle.manifest','libreecho-install.zip'].map(n=>`${hash(bytes.get(n))}  ${n}`).join('\n'));
  const files = [...bytes].map(([name,b])=>{const file = new Blob([b]);file.name=name;return file;});
  const assets = [...bytes].map(([name,b])=>({name,size:Buffer.byteLength(b),digest:`sha256:${hash(b)}`}));
  return { tag, files, assets, bytes, metadata };
}
