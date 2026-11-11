// A live WebSocket session: buffers until the request header parses,
// then relays TCP via outbound sockets, or answers DNS (UDP/53) via encrypted resolvers.

import { connect } from 'cloudflare:sockets';
import { CMD, parseRequest, concatBytes, base64UrlToBytes } from './proto.js';

export function openSession(request, ids, env) {
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

const MODE = { HEAD: 0, TCP: 1, DNS: 2 };

export class Session {
  constructor(ws, ids, env) {
    this.ws = ws;
    this.ids = ids;          // Set of accepted id strings
    this.env = env;
    this.pending = [];       // chunks buffered while awaiting the header
    this.pendingBytes = 0;
    this.writer = null;      // socket writer once relaying
    this.mode = MODE.HEAD;
    this.closed = false;
    this.dnsBuffer = new Uint8Array(0);
  }

  feed(chunk) {
    if (this.closed) return;
    if (this.mode === MODE.TCP) {
      if (this.writer) {
        this.writer.write(chunk).catch(() => this.end());
      } else {
        // Socket still connecting: keep the payload until the writer exists.
        this.pending.push(chunk);
        this.pendingBytes += chunk.byteLength;
      }
      return;
    }
    if (this.mode === MODE.DNS) {
      this.feedDns(chunk).catch(() => this.end());
      return;
    }
    this.pending.push(chunk);
    this.pendingBytes += chunk.byteLength;
    this.tryHeader().catch(() => this.end());
  }

  async tryHeader() {
    if (this.mode !== MODE.HEAD || this.closed) return;
    const buf = concatBytes(this.pending, this.pendingBytes);
    const head = parseRequest(buf, this.ids);
    if (head === null) return;              // need more bytes
    if (head.error) throw new Error('bad header');
    this.pending = [];
    this.pendingBytes = 0;
    const rest = buf.subarray(head.offset);
    const responseHead = new Uint8Array([head.version, 0]);

    if (head.isUdp) {
      if (head.port !== 53) throw new Error('udp limited to dns');
      this.mode = MODE.DNS;
      this.dnsHead = responseHead;
      if (rest.byteLength) await this.feedDns(rest);
      return;
    }

    this.mode = MODE.TCP;
    await this.relayTcp(head, rest, responseHead);
  }

  async relayTcp(head, firstPayload, responseHead) {
    const relay = String(this.env.R || '').trim();
    const attempt = async (hostname) => {
      const socket = connect({ hostname, port: head.port });
      const writer = socket.writable.getWriter();
      if (firstPayload.byteLength) await writer.write(firstPayload);
      return { socket, writer };
    };

    let current = await attempt(head.addr);
    this.writer = current.writer;
    this.flushPending();
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
    } catch { /* fall through to relay/close logic */ }

    // If nothing ever arrived, the destination is likely behind the same
    // edge; retry once through the optional relay host.
    if (!received && relay && !this.closed) {
      try {
        current = await attempt(relay);
        this.writer = current.writer;
        this.flushPending();
        headPending = responseHead;
        await pump(current.socket);
      } catch { /* give up */ }
    }
    this.end();
  }

  flushPending() {
    if (this.pending.length === 0) return;
    const buf = concatBytes(this.pending, this.pendingBytes);
    this.pending = [];
    this.pendingBytes = 0;
    if (this.writer) this.writer.write(buf).catch(() => this.end());
  }

  async feedDns(chunk) {
    // Frames: 2-byte big-endian length + DNS message; may span chunks.
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
    const endpoint = String(this.env.N || 'https://cloudflare-dns.com/dns-query').trim();
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

export { CMD };
