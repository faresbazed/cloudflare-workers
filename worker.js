// Edge Sync — single-file worker.
// Accepts VLESS connections over WebSocket, forwards TCP via outbound
// sockets and DNS (UDP/53) via DNS-over-HTTPS. Configuration is only
// through environment variables: UUID (required), PROXYIP, DOH.

import { connect } from 'cloudflare:sockets';

const STATUS_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Edge Sync — Status</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; margin: 0; color: #1a1d21; background: #f6f7f9; }
  main { max-width: 640px; margin: 12vh auto; padding: 2rem; background: #fff; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,.06); }
  h1 { font-size: 1.35rem; margin: 0 0 .5rem; }
  p { color: #5b6470; line-height: 1.55; }
  .ok { display: inline-block; width: .6rem; height: .6rem; border-radius: 50%; background: #2ea44f; margin-right: .45rem; }
  footer { color: #8a94a3; font-size: .85rem; margin-top: 1.5rem; }
</style>
</head>
<body>
<main>
  <h1><span class="ok"></span>All systems normal</h1>
  <p>Edge Sync is a small content synchronisation service. Assets are replicated across regions automatically; there is nothing to configure here.</p>
  <footer>© 2026 Edge Sync</footer>
</main>
</body>
</html>`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export default {
  async fetch(request, env) {
    const ids = configuredIds(env);
    if (ids.length === 0) return page(STATUS_PAGE);

    const url = new URL(request.url);
    if ((request.headers.get('Upgrade') || '').toLowerCase() === 'websocket') {
      return openSession(request, ids, env);
    }

    const first = url.pathname.split('/').filter(Boolean)[0];
    if (first && ids.includes(first.toLowerCase())) {
      return infoPage(first.toLowerCase(), url.host);
    }
    return page(STATUS_PAGE, url.pathname === '/' || url.pathname === '/index.html' ? 200 : 404);
  },
};

function configuredIds(env) {
  return String(env.UUID || '')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter((v) => UUID_RE.test(v));
}

function page(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' },
  });
}

function infoPage(id, host) {
  const query = `encryption=none&security=tls&type=ws&host=${host}&sni=${host}&fp=chrome&path=%2F%3Fed%3D2048`;
  const lines = [
    `vless://${id}@${host}:443?${query}#edge-sync`,
    '',
    `Address : ${host}`,
    'Port    : 443',
    `UUID    : ${id}`,
    'Network : ws   TLS: tls   Path: /?ed=2048',
    `SNI/Host: ${host}`,
    '',
  ];
  return new Response(lines.join('\n'), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

// ------------------------------------------------------------- session

function openSession(request, ids, env) {
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();

  const session = new Session(server, ids, env);
  const early = request.headers.get('sec-websocket-protocol') || '';
  if (early) {
    const decoded = base64UrlToBytes(early);
    if (decoded) session.feed(decoded);
  }
  server.addEventListener('message', (event) => {
    const data = event.data;
    if (data instanceof ArrayBuffer) session.feed(new Uint8Array(data));
    else if (ArrayBuffer.isView(data)) session.feed(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  });
  server.addEventListener('close', () => session.end());
  server.addEventListener('error', () => session.end());

  return new Response(null, { status: 101, webSocket: client });
}

class Session {
  constructor(ws, ids, env) {
    this.ws = ws;
    this.ids = ids;
    this.env = env;
    this.pending = [];        // buffered chunks before the header is parsed
    this.pendingBytes = 0;
    this.writer = null;       // writable writer once connected
    this.mode = 0;            // 0 = awaiting header, 1 = tcp, 2 = dns
    this.closed = false;
    this.dnsBuffer = new Uint8Array(0);
  }

  feed(chunk) {
    if (this.closed) return;
    if (this.mode === 1 && this.writer) {
      this.writer.write(chunk).catch(() => this.end());
      return;
    }
    if (this.mode === 2) {
      this.feedDns(chunk).catch(() => this.end());
      return;
    }
    // Awaiting the header: buffer until it can be parsed completely.
    this.pending.push(chunk);
    this.pendingBytes += chunk.byteLength;
    this.tryHeader().catch(() => this.end());
  }

  async tryHeader() {
    if (this.mode !== 0 || this.closed) return;
    const buf = concatBytes(this.pending, this.pendingBytes);
    const head = parseHead(buf, this.ids);
    if (head === null) return; // need more bytes
    if (head.error) throw new Error('invalid header');
    this.pending = [];
    this.pendingBytes = 0;
    const rest = buf.subarray(head.offset);
    const responseHead = new Uint8Array([head.version, 0]);

    if (head.isUdp) {
      if (head.port !== 53) throw new Error('udp limited to dns');
      this.mode = 2;
      this.dnsHead = responseHead;
      if (rest.byteLength) await this.feedDns(rest);
      return;
    }

    this.mode = 1;
    await this.openTcp(head, rest, responseHead);
  }

  async openTcp(head, firstPayload, responseHead) {
    const relay = String(this.env.PROXYIP || '').trim();
    const attempt = async (hostname) => {
      const socket = connect({ hostname, port: head.port });
      const writer = socket.writable.getWriter();
      if (firstPayload.byteLength) await writer.write(firstPayload);
      return { socket, writer };
    };

    let current = await attempt(head.address);
    this.writer = current.writer;
    let headPending = responseHead;
    let received = false;

    const pump = (socket) =>
      socket.readable.pipeTo(
        new WritableStream({
          write: (chunk) => {
            received = true;
            if (this.ws.readyState !== WebSocket.OPEN) throw new Error('client gone');
            if (headPending) {
              this.ws.send(concatBytes([headPending, new Uint8Array(chunk)]));
              headPending = null;
            } else {
              this.ws.send(chunk);
            }
          },
        })
      );

    try {
      await pump(current.socket);
    } catch { /* stream error: fall through to close/retry logic */ }

    if (!received && relay && !this.closed) {
      try {
        current = await attempt(relay);
        this.writer = current.writer;
        await pump(current.socket);
      } catch { /* give up */ }
    }
    this.end();
  }

  async feedDns(chunk) {
    // Frames are: 2-byte length + DNS message. Buffer across chunks.
    this.dnsBuffer = concatBytes([this.dnsBuffer, chunk]);
    for (;;) {
      if (this.dnsBuffer.byteLength < 2) return;
      const len = (this.dnsBuffer[0] << 8) | this.dnsBuffer[1];
      if (this.dnsBuffer.byteLength < 2 + len) return;
      const query = this.dnsBuffer.subarray(2, 2 + len);
      this.dnsBuffer = this.dnsBuffer.subarray(2 + len);
      await this.answerDns(query);
    }
  }

  async answerDns(query) {
    const endpoint = String(this.env.DOH || 'https://cloudflare-dns.com/dns-query').trim();
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/dns-message' },
      body: query,
    });
    const answer = new Uint8Array(await res.arrayBuffer());
    const framed = new Uint8Array(2 + answer.byteLength);
    framed[0] = (answer.byteLength >> 8) & 0xff;
    framed[1] = answer.byteLength & 0xff;
    framed.set(answer, 2);
    if (this.ws.readyState !== WebSocket.OPEN) return;
    if (this.dnsHead) {
      this.ws.send(concatBytes([this.dnsHead, framed]));
      this.dnsHead = null;
    } else {
      this.ws.send(framed);
    }
  }

  end() {
    if (this.closed) return;
    this.closed = true;
    try { this.ws.close(); } catch { /* already closed */ }
    if (this.writer) {
      try { this.writer.close(); } catch { /* ignore */ }
      this.writer = null;
    }
  }
}

// -------------------------------------------------------------- parsing

// Returns null when more bytes are needed, {error:true} when invalid,
// otherwise {version, isUdp, port, address, offset}.
function parseHead(buf, ids) {
  if (buf.byteLength < 18) return null;
  const version = buf[0];
  const id = uuidToString(buf.subarray(1, 17));
  if (!ids.includes(id)) return { error: true };

  const cmdAt = 18 + buf[17];
  if (buf.byteLength < cmdAt + 4) return null;
  const command = buf[cmdAt];
  if (command !== 1 && command !== 2) return { error: true };

  const port = (buf[cmdAt + 1] << 8) | buf[cmdAt + 2];
  const addrAt = cmdAt + 3;
  const addrType = buf[addrAt];
  let at = addrAt + 1;
  let address = '';

  if (addrType === 1) {
    if (buf.byteLength < at + 4) return null;
    address = `${buf[at]}.${buf[at + 1]}.${buf[at + 2]}.${buf[at + 3]}`;
    at += 4;
  } else if (addrType === 2) {
    if (buf.byteLength < at + 1) return null;
    const len = buf[at];
    at += 1;
    if (buf.byteLength < at + len) return null;
    address = new TextDecoder().decode(buf.subarray(at, at + len));
    at += len;
  } else if (addrType === 3) {
    if (buf.byteLength < at + 16) return null;
    const parts = [];
    for (let i = 0; i < 8; i++) parts.push(((buf[at + i * 2] << 8) | buf[at + i * 2 + 1]).toString(16));
    address = parts.join(':');
    at += 16;
  } else {
    return { error: true };
  }

  return { version, isUdp: command === 2, port, address, offset: at };
}

const HEX = Array.from({ length: 256 }, (_, i) => (i + 256).toString(16).slice(1));
function uuidToString(a) {
  return (
    HEX[a[0]] + HEX[a[1]] + HEX[a[2]] + HEX[a[3]] + '-' +
    HEX[a[4]] + HEX[a[5]] + '-' +
    HEX[a[6]] + HEX[a[7]] + '-' +
    HEX[a[8]] + HEX[a[9]] + '-' +
    HEX[a[10]] + HEX[a[11]] + HEX[a[12]] + HEX[a[13]] + HEX[a[14]] + HEX[a[15]]
  );
}

function base64UrlToBytes(text) {
  try {
    const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(b64);
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function concatBytes(parts, total) {
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
