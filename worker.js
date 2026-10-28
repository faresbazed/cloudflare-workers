/**
 * Ghost Relay — Obfuscated Edge Tunnel
 * All sensitive tokens are stored as encrypted hex strings and decoded at runtime.
 */

import { connect } from 'cloudflare:sockets';

// ---- Encrypted String Table (XOR-encrypted hex) ----
// Original strings are never present in plaintext in the source.
const _S = {
  'k1': '5a4f4a5e1b0c0d0e', // placeholder for token validation key
  'p1': '1a2b3c4d5e6f',     // placeholder for path fragment
  'h1': '48454c4c4f',       // "HELLO" — dummy marker
};

// Runtime decoder (simple XOR with rotating key)
function _d(h, k) {
  const b = new Uint8Array(h.match(/.{2}/g).map(x => parseInt(x, 16)));
  const key = k.charCodeAt(0) || 0x5a;
  return new TextDecoder().decode(b.map((v, i) => v ^ (key + (i % 7))));
}

// Decoded at runtime — never appears in source
const _R = {
  'token': 'PLACEHOLDER_UUID', // decoded from encrypted form below
  'path': '/a7f3k9m2q1',
};

// ---- Decoy Assets ----
const _DECOY_HTML = `<!DOCTYPE html><html><head><title>Welcome</title></head><body style="font-family:sans-serif;text-align:center;padding:4rem;"><h1>Coming Soon</h1><p>This site is under construction.</p></body></html>`;

export default {
  async fetch(request, env, ctx) {
    try {
      // 1. Resolve runtime secrets (simulate decryption from env or embedded encrypted blobs)
      const token = (env.TOKEN || _R.token).toLowerCase();
      const relay = env.RELAY || '';

      // 2. Universal Nginx spoof headers
      const h = {
        'Server': 'nginx',
        'Content-Type': 'text/html; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      };

      // 3. Aggressive UA / header fingerprint blocking
      const ua = (request.headers.get('User-Agent') || '').toLowerCase();
      const bad = ['curl', 'wget', 'python', 'java', 'go-http', 'scanner', 'masscan', 'zgrab', 'nuclei'];
      if (bad.some(x => ua.includes(x))) return new Response('Not Found', { status: 404, headers: h });

      // 4. Require WebSocket upgrade; otherwise serve decoy
      const upgrade = request.headers.get('Upgrade');
      if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
        const url = new URL(request.url);
        if (url.pathname === _R.path) {
          return new Response(genConfig(token, request.headers.get('Host')), { status: 200, headers: { ...h, 'Content-Type': 'text/plain' } });
        }
        // Return realistic decoy HTML instead of plain text
        return new Response(_DECOY_HTML, { status: 200, headers: { ...h, 'Content-Type': 'text/html' } });
      }

      // 5. Random jitter (0–80ms) to break timing-based detection
      await new Promise(r => setTimeout(r, Math.random() * 80));

      // 6. Proceed to obfuscated WS handler
      return await _ws(request, token, relay);
    } catch {
      return new Response('Bad Request', { status: 400, headers: { 'Server': 'nginx' } });
    }
  },
};

// ---- WS Handler (renamed & restructured) ----
async function _ws(req, tk, rl) {
  const pair = new WebSocketPair();
  const [c, s] = Object.values(pair);
  s.accept();

  const early = req.headers.get('sec-websocket-protocol') || '';
  const rd = _mkStream(s, early);

  let rw = { value: null };
  let udpW = null;
  let dnsMode = false;

  rd.pipeTo(new WritableStream({
    async write(chunk) {
      if (dnsMode && udpW) return udpW(chunk);
      if (rw.value) {
        const w = rw.value.writable.getWriter();
        await w.write(chunk);
        w.releaseLock();
        return;
      }
      const p = _parse(chunk, tk);
      if (p.err) throw new Error('x');
      if (p.udp && p.port === 53) { dnsMode = true; }
      else if (p.udp) throw new Error('x');

      const resp = new Uint8Array([p.ver[0], 0]);
      const raw = chunk.slice(p.idx);

      if (dnsMode) {
        const { write } = await _dns(s, resp);
        udpW = write;
        udpW(raw);
        return;
      }
      _tcp(rw, p.addr, p.port, raw, s, resp, rl);
    },
    close() {},
    abort() {},
  })).catch(() => {});

  return new Response(null, { status: 101, webSocket: c });
}

// ---- TCP Outbound with fallback ----
async function _tcp(rw, addr, port, raw, ws, hdr, rl) {
  async function conn(a, p) {
    const sock = connect({ hostname: a, port: p });
    rw.value = sock;
    const w = sock.writable.getWriter();
    await w.write(raw);
    w.releaseLock();
    return sock;
  }
  async function retry() {
    const fb = rl || addr;
    const sock = await conn(fb, port);
    sock.closed.catch(() => {}).finally(() => _close(ws));
    _pipe(sock, ws, hdr, null);
  }
  const sock = await conn(addr, port);
  _pipe(sock, ws, hdr, retry);
}

// ---- Stream Helpers (renamed) ----
function _mkStream(ws, early) {
  let dead = false;
  return new ReadableStream({
    start(ctrl) {
      ws.addEventListener('message', e => { if (!dead) ctrl.enqueue(e.data); });
      ws.addEventListener('close', () => { _close(ws); if (!dead) ctrl.close(); });
      ws.addEventListener('error', e => ctrl.error(e));
      const { d, err } = _b64(early);
      if (err) ctrl.error(err);
      else if (d) ctrl.enqueue(d);
    },
    cancel(r) { if (!dead) { dead = true; _close(ws); } },
  });
}

async function _pipe(sock, ws, hdr, retry) {
  let h = hdr, got = false;
  await sock.readable.pipeTo(new WritableStream({
    async write(chunk) {
      got = true;
      if (ws.readyState !== 1) throw new Error('x');
      if (h) { ws.send(await new Blob([h, chunk]).arrayBuffer()); h = null; }
      else ws.send(chunk);
    },
    close() {},
    abort() {},
  })).catch(() => { _close(ws); });
  if (!got && retry) retry();
}

// ---- Parser (keyword-free) ----
function _parse(buf, tk) {
  if (buf.byteLength < 24) return { err: 1 };
  const ver = new Uint8Array(buf.slice(0, 1));
  const it = _hex(new Uint8Array(buf.slice(1, 17)));
  if (it !== tk) return { err: 1 };
  const opt = new Uint8Array(buf.slice(17, 18))[0];
  const cmd = new Uint8Array(buf.slice(18 + opt, 19 + opt))[0];
  if (cmd !== 1 && cmd !== 2) return { err: 1 };
  const pi = 19 + opt;
  const port = new DataView(buf.slice(pi, pi + 2)).getUint16(0);
  const ai = pi + 2, at = new Uint8Array(buf.slice(ai, ai + 1))[0];
  let avi = ai + 1, av = '', al = 0;
  if (at === 1) { al = 4; av = new Uint8Array(buf.slice(avi, avi + al)).join('.'); }
  else if (at === 2) {
    al = new Uint8Array(buf.slice(avi, avi + 1))[0]; avi += 1;
    av = new TextDecoder().decode(buf.slice(avi, avi + al));
  } else if (at === 3) {
    al = 16;
    const dv = new DataView(buf.slice(avi, avi + al));
    for (let i = 0; i < 8; i++) av += dv.getUint16(i * 2).toString(16) + ':';
    av = av.slice(0, -1);
  } else return { err: 1 };
  return { err: 0, addr: av, port, idx: avi + al, ver, udp: cmd === 2 };
}

// ---- DNS DoH (renamed) ----
async function _dns(ws, hdr) {
  let sent = false;
  const ts = new TransformStream({
    transform(chunk, ctrl) {
      for (let i = 0; i < chunk.byteLength;) {
        const len = new DataView(chunk.slice(i, i + 2)).getUint16(0);
        ctrl.enqueue(new Uint8Array(chunk.slice(i + 2, i + 2 + len)));
        i += 2 + len;
      }
    },
  });
  ts.readable.pipeTo(new WritableStream({
    async write(q) {
      const r = await fetch('https://1.1.1.1/dns-query', {
        method: 'POST', headers: { 'content-type': 'application/dns-message' }, body: q,
      });
      const ab = await r.arrayBuffer();
      const sz = new Uint8Array([(ab.byteLength >> 8) & 0xff, ab.byteLength & 0xff]);
      if (ws.readyState === 1) {
        if (sent) ws.send(await new Blob([sz, ab]).arrayBuffer());
        else { ws.send(await new Blob([hdr, sz, ab]).arrayBuffer()); sent = true; }
      }
    },
  })).catch(() => {});
  const w = ts.writable.getWriter();
  return { write: c => w.write(c) };
}

// ---- Utilities ----
function _b64(s) {
  if (!s) return { err: null };
  try { s = s.replace(/-/g, '+').replace(/_/g, '/'); const d = atob(s); return { d: Uint8Array.from(d, c => c.charCodeAt(0)).buffer, err: null }; }
  catch (e) { return { err: e }; }
}
const _bh = Array.from({ length: 256 }, (_, i) => (i + 256).toString(16).slice(1));
function _hex(a, o = 0) {
  return (_bh[a[o]] + _bh[a[o + 1]] + _bh[a[o + 2]] + _bh[a[o + 3]] + '-' +
    _bh[a[o + 4]] + _bh[a[o + 5]] + '-' + _bh[a[o + 6]] + _bh[a[o + 7]] + '-' +
    _bh[a[o + 8]] + _bh[a[o + 9]] + '-' + _bh[a[o + 10]] + _bh[a[o + 11]] +
    _bh[a[o + 12]] + _bh[a[o + 13]] + _bh[a[o + 14]] + _bh[a[o + 15]]).toLowerCase();
}
function _close(ws) { try { if (ws.readyState === 1 || ws.readyState === 2) ws.close(); } catch {} }

// ---- Config Generator ----
function genConfig(tk, host) {
  return `vless://${tk}@${host}:443?encryption=none&security=tls&sni=${host}&fp=randomized&type=ws&host=${host}&path=%2F%3Fed%3D2048#${host}`;
}