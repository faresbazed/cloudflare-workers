// Protocol codec: request-header decoding and shared byte helpers.
// Kept dependency-free and pure so it can be unit-tested with plain Node.

const HEX = Array.from({ length: 256 }, (_, i) => (i + 256).toString(16).slice(1));
const T = new TextDecoder();

export const ATYP = { IPV4: 1, NAME: 2, IPV6: 3 };
export const CMD = { TCP: 1, UDP: 2 };

// Hex id string <-> 16 bytes.
export function idFromBytes(a) {
  return (
    HEX[a[0]] + HEX[a[1]] + HEX[a[2]] + HEX[a[3]] + '-' +
    HEX[a[4]] + HEX[a[5]] + '-' +
    HEX[a[6]] + HEX[a[7]] + '-' +
    HEX[a[8]] + HEX[a[9]] + '-' +
    HEX[a[10]] + HEX[a[11]] + HEX[a[12]] + HEX[a[13]] + HEX[a[14]] + HEX[a[15]]
  );
}

export const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Parse a request header out of `buf` against the accepted id set.
//   null                    -> not enough bytes yet
//   { error: true }         -> malformed / unauthorized; caller must drop
//   { ok, isUdp, port, addr, offset, version }
export function parseRequest(buf, ids) {
  if (buf.byteLength < 18) return null; // need ver+id+addonLen to make progress
  const version = buf[0];
  const id = idFromBytes(buf.subarray(1, 17));
  if (!ids.has(id)) return { error: true };

  const cmdAt = 18 + buf[17]; // 1 version + 16 id + 1 optLen
  if (buf.byteLength < cmdAt + 4) return null;
  const command = buf[cmdAt];
  if (command !== CMD.TCP && command !== CMD.UDP) return { error: true };

  const port = (buf[cmdAt + 1] << 8) | buf[cmdAt + 2];
  const at = cmdAt + 3;
  const addrType = buf[at];
  let p = at + 1;
  let addr = '';

  if (addrType === ATYP.IPV4) {
    if (buf.byteLength < p + 4) return null;
    addr = `${buf[p]}.${buf[p + 1]}.${buf[p + 2]}.${buf[p + 3]}`;
    p += 4;
  } else if (addrType === ATYP.NAME) {
    if (buf.byteLength < p + 1) return null;
    const len = buf[p];
    p += 1;
    if (buf.byteLength < p + len) return null;
    addr = T.decode(buf.subarray(p, p + len));
    p += len;
  } else if (addrType === ATYP.IPV6) {
    if (buf.byteLength < p + 16) return null;
    const parts = [];
    for (let i = 0; i < 8; i++) parts.push(((buf[p + i * 2] << 8) | buf[p + i * 2 + 1]).toString(16));
    addr = parts.join(':');
    p += 16;
  } else {
    return { error: true };
  }

  return { ok: true, version, isUdp: command === CMD.UDP, port, addr, offset: p };
}

export function concatBytes(parts, total) {
  let length = total;
  if (length === undefined) length = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part instanceof Uint8Array ? part : new Uint8Array(part), at);
    at += part.byteLength;
  }
  return out;
}

export function base64UrlToBytes(text) {
  try {
    const raw = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}
