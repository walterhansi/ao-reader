// Minimaler ZIP-Leser und -Schreiber (ohne externe Bibliothek).
// Lesen: Stored + Deflate (über DecompressionStream). Schreiben: Stored (ohne Kompression).

const dec = new TextDecoder('utf-8');

// Prüfen, ob der Browser 'deflate-raw' selbst entpacken kann (Chrome 103+). Sonst eigener Entpacker.
let HAS_DS = false;
try { new DecompressionStream('deflate-raw'); HAS_DS = true; } catch { HAS_DS = false; }
export function _forceJsInflate(v) { HAS_DS = !v; }

// ---------- Kleiner DEFLATE-Entpacker (nach tinf, J. Ibsen, zlib-Lizenz) ----------
const LBASE = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
const LEXT = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
const DBASE = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
const DEXT = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
const CLORDER = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];
function buildTree(lengths, off, n) {
  const counts = new Uint16Array(16), offs = new Uint16Array(16), symbols = new Uint16Array(n);
  for (let i = 0; i < n; i++) counts[lengths[off + i]]++;
  counts[0] = 0;
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + counts[i - 1];
  for (let i = 0; i < n; i++) { const l = lengths[off + i]; if (l) symbols[offs[l]++] = i; }
  return { counts, symbols };
}
let FIXED = null;
function fixedTrees() {
  if (FIXED) return FIXED;
  const l = new Uint8Array(288);
  for (let i = 0; i < 144; i++) l[i] = 8;
  for (let i = 144; i < 256; i++) l[i] = 9;
  for (let i = 256; i < 280; i++) l[i] = 7;
  for (let i = 280; i < 288; i++) l[i] = 8;
  const d = new Uint8Array(30).fill(5);
  FIXED = { lt: buildTree(l, 0, 288), dt: buildTree(d, 0, 30) };
  return FIXED;
}
export function inflateRaw(src, size) {
  let out = new Uint8Array(size || src.length * 4 + 1024), op = 0;
  let pos = 0, tag = 0, cnt = 0;
  const ensure = (n) => { if (op + n > out.length) { const o = new Uint8Array(Math.max(out.length * 2, op + n)); o.set(out); out = o; } };
  const bit = () => { if (!cnt) { if (pos >= src.length) throw new Error('Defekte Daten'); tag = src[pos++]; cnt = 8; } const b = tag & 1; tag >>>= 1; cnt--; return b; };
  const bits = (n, base) => { let v = 0; for (let i = 0; i < n; i++) v |= bit() << i; return v + base; };
  const sym = (t) => { let sum = 0, cur = 0, len = 0; do { cur = 2 * cur + bit(); len++; if (len > 15) throw new Error('Defekte Daten'); sum += t.counts[len]; cur -= t.counts[len]; } while (cur >= 0); return t.symbols[sum + cur]; };
  let final = 0;
  while (!final) {
    final = bit();
    const type = bits(2, 0);
    if (type === 0) {
      cnt = 0;
      const len = src[pos] | (src[pos + 1] << 8);
      pos += 4;
      ensure(len); out.set(src.subarray(pos, pos + len), op); op += len; pos += len;
      continue;
    }
    let lt, dt;
    if (type === 1) ({ lt, dt } = fixedTrees());
    else if (type === 2) {
      const hlit = bits(5, 257), hdist = bits(5, 1), hclen = bits(4, 4);
      const cl = new Uint8Array(19);
      for (let i = 0; i < hclen; i++) cl[CLORDER[i]] = bits(3, 0);
      const ct = buildTree(cl, 0, 19);
      const lens = new Uint8Array(hlit + hdist);
      for (let n = 0; n < hlit + hdist;) {
        const s = sym(ct);
        if (s < 16) lens[n++] = s;
        else if (s === 16) { const p = lens[n - 1]; for (let k = bits(2, 3); k; k--) lens[n++] = p; }
        else if (s === 17) n += bits(3, 3);
        else n += bits(7, 11);
      }
      lt = buildTree(lens, 0, hlit); dt = buildTree(lens, hlit, hdist);
    } else throw new Error('Defekte Daten');
    for (;;) {
      let s = sym(lt);
      if (s === 256) break;
      if (s < 256) { ensure(1); out[op++] = s; continue; }
      s -= 257;
      const len = bits(LEXT[s], LBASE[s]);
      const ds = sym(dt);
      const dist = bits(DEXT[ds], DBASE[ds]);
      ensure(len);
      for (let i = 0; i < len; i++, op++) out[op] = out[op - dist];
    }
  }
  return op === out.length ? out : out.slice(0, op);
}

export async function openZip(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Datei ist kein gültiges ZIP/EPUB.');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries = new Map();
  const lower = new Map();
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || dv.getUint32(p, true) !== 0x02014b50) break;
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true);
    const elen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const nameBytes = buf.subarray(p + 46, p + 46 + nlen);
    const name = (flags & 0x800) ? dec.decode(nameBytes) : dec.decode(nameBytes);
    const e = { name, method, csize, usize, lho };
    entries.set(name, e);
    lower.set(name.toLowerCase(), e);
    p += 46 + nlen + elen + clen;
  }

  function find(name) {
    if (!name) return null;
    return entries.get(name) || lower.get(name.toLowerCase()) || null;
  }

  async function read(name) {
    const e = find(name);
    if (!e) throw new Error('Nicht im Archiv: ' + name);
    const lnl = dv.getUint16(e.lho + 26, true);
    const lel = dv.getUint16(e.lho + 28, true);
    const start = e.lho + 30 + lnl + lel;
    const data = buf.subarray(start, start + e.csize);
    if (e.method === 0) return data.slice();
    if (e.method === 8) {
      if (!HAS_DS) return inflateRaw(data, e.usize);
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    throw new Error('Nicht unterstützte Kompression in ' + name);
  }

  return {
    names: () => [...entries.keys()],
    has: (name) => !!find(name),
    read,
    text: async (name) => {
      const bytes = await read(name);
      // UTF-16 BOM erkennen
      if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
      if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
      return dec.decode(bytes);
    },
    blob: async (name, type) => new Blob([await read(name)], { type: type || '' }),
  };
}

// ---------- Schreiben (Stored) ----------
let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      crcTable[i] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// files: [{name, data: Uint8Array}] -> Blob
export function writeZip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = f.data;
    const crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x800, true);
    lh.setUint16(8, 0, true); lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
    lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(lh.buffer, name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x800, true); ch.setUint16(10, 0, true); ch.setUint16(12, dosTime, true);
    ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true);
    ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(ch.buffer, name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((s, b) => s + b.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}
