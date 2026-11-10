// Edge sync worker: WebSocket relay with per-user token auth.
// Configuration is via environment variables only — see README.md.

import { connect } from 'cloudflare:sockets';

const PAGE = `<!DOCTYPE html>
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

export default {
  async fetch(request, env) {
    const users = parseUsers(env);
    if (users.length === 0) {
      // Misconfigured deployment: behave like a plain static site.
      return html(PAGE);
    }

    const url = new URL(request.url);

    if ((request.headers.get('Upgrade') || '').toLowerCase() === 'websocket') {
      return handleSocket(request, users, env);
    }

    // Client-info page: the token itself is the credential, so the link
    // lives behind it. /<uuid> returns that user's ready-to-copy URIs.
    const first = url.pathname.split('/').filter(Boolean)[0];
    if (first && users.includes(first.toLowerCase())) {
      return clientInfo(first.toLowerCase(), url.host);
    }

    if (url.pathname === '/' || url.pathname === '/index.html') return html(PAGE);
    return html(PAGE, 404);
  },
};

function parseUsers(env) {
  return (env.UUID || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s));
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' },
  });
}

function clientInfo(uuid, host) {
  const base = `encryption=none&security=tls&type=ws&host=${host}&sni=${host}&fp=chrome&path=%2F%3Fed%3D2048`;
  const uri = `vless://${uuid}@${host}:443?${base}#edge-sync`;
  const text = [
    uri,
    '',
    `Address : ${host}`,
    'Port    : 443',
    `UUID    : ${uuid}`,
    'Network : ws   TLS: tls   Path: /?ed=2048',
    `SNI/Host: ${host}`,
    '',
    'Tip: you can replace the address with any Cloudflare edge IP or',
    'another Cloudflare-fronted hostname; keep SNI/Host as above.',
    '',
  ].join('\n');
  return new Response(text, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

// ---------------------------------------------------------------- sockets

function handleSocket(request, users, env) {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();

  const earlyData = request.headers.get('sec-websocket-protocol') || '';
  const readable = socketToReadable(server, earlyData);

  let tcpSocket = null;
  let udpWriter = null;
  let isDns = false;

  readable
    .pipeTo(
      new WritableStream({
        async write(chunk) {
          if (isDns && udpWriter) return udpWriter(chunk);
          if (tcpSocket) {
            const w = tcpSocket.writable.getWriter();
            await w.write(chunk);
            w.releaseLock();
            return;
          }

          const head = parseHeader(chunk, users);
          if (head.error) throw new Error('bad header');

          const payload = chunk.slice(head.offset);
          const responseHead = new Uint8Array([head.version, 0]);

          if (head.isUDP) {
            if (head.port !== 53) throw new Error('udp: dns only');
            isDns = true;
            udpWriter = await dnsRelay(server, responseHead, env);
            return udpWriter(payload);
          }

          tcpSocket = await openTcp(head, payload, server, responseHead, env);
        },
        close() { safeClose(server); },
        abort() { safeClose(server); },
      })
    )
    .catch(() => safeClose(server));

  return new Response(null, { status: 101, webSocket: client });
}

async function openTcp(head, payload, ws, responseHead, env) {
  const proxyIp = (env.PROXYIP || '').trim();

  async function dial(hostname, port) {
    const socket = connect({ hostname, port });
    const w = socket.writable.getWriter();
    await w.write(payload);
    w.releaseLock();
    return socket;
  }

  let socket = await dial(head.address, head.port);
  let headerSent = responseHead;
  let gotData = false;

  const pump = async (sock) => {
    await sock.readable.pipeTo(
      new WritableStream({
        write(chunk) {
          gotData = true;
          if (ws.readyState !== WebSocket.OPEN) throw new Error('ws closed');
          if (headerSent) {
            ws.send(concat(headerSent, chunk));
            headerSent = null;
          } else {
            ws.send(chunk);
          }
        },
      })
    );
  };

  pump(socket)
    .catch(() => {})
    .finally(async () => {
      // Nothing came back and a fallback relay is configured: retry once
      // through it (needed for destinations hosted on Cloudflare itself).
      if (!gotData && proxyIp) {
        try {
          socket = await dial(proxyIp, head.port);
          await pump(socket);
        } catch { /* fall through */ }
      }
      safeClose(ws);
    });

  return socket;
}

// ------------------------------------------------------------------- dns

async function dnsRelay(ws, responseHead, env) {
  const doh = (env.DOH || 'https://cloudflare-dns.com/dns-query').trim();
  let header = responseHead;

  const { readable, writable } = new TransformStream({
    transform(chunk, controller) {
      for (let i = 0; i < chunk.byteLength; ) {
        const len = new DataView(chunk.slice(i, i + 2)).getUint16(0);
        controller.enqueue(new Uint8Array(chunk.slice(i + 2, i + 2 + len)));
        i += 2 + len;
      }
    },
  });

  readable
    .pipeTo(
      new WritableStream({
        async write(query) {
          const res = await fetch(doh, {
            method: 'POST',
            headers: { 'content-type': 'application/dns-message' },
            body: query,
          });
          const answer = await res.arrayBuffer();
          const size = new Uint8Array([(answer.byteLength >> 8) & 0xff, answer.byteLength & 0xff]);
          if (ws.readyState !== WebSocket.OPEN) return;
          if (header) {
            ws.send(concat(header, size, new Uint8Array(answer)));
            header = null;
          } else {
            ws.send(concat(size, new Uint8Array(answer)));
          }
        },
      })
    )
    .catch(() => {});

  const writer = writable.getWriter();
  return (chunk) => writer.write(chunk);
}

// ---------------------------------------------------------------- parsing

function parseHeader(buf, users) {
  if (buf.byteLength < 24) return { error: true };
  const bytes = new Uint8Array(buf);
  const version = bytes[0];
  const id = stringifyUuid(bytes.subarray(1, 17));
  if (!users.includes(id)) return { error: true };

  const optLen = bytes[17];
  const cmdIndex = 18 + optLen;
  const command = bytes[cmdIndex];
  if (command !== 1 && command !== 2) return { error: true };

  const portIndex = cmdIndex + 1;
  const port = new DataView(buf.slice(portIndex, portIndex + 2)).getUint16(0);
  const addrIndex = portIndex + 2;
  const addrType = bytes[addrIndex];

  let offset = addrIndex + 1;
  let address = '';
  if (addrType === 1) {
    address = Array.from(bytes.subarray(offset, offset + 4)).join('.');
    offset += 4;
  } else if (addrType === 2) {
    const len = bytes[offset];
    offset += 1;
    address = new TextDecoder().decode(buf.slice(offset, offset + len));
    offset += len;
  } else if (addrType === 3) {
    const parts = [];
    const view = new DataView(buf.slice(offset, offset + 16));
    for (let i = 0; i < 8; i++) parts.push(view.getUint16(i * 2).toString(16));
    address = parts.join(':');
    offset += 16;
  } else {
    return { error: true };
  }

  return { error: false, version, isUDP: command === 2, port, address, offset };
}

function socketToReadable(ws, earlyDataHeader) {
  let closed = false;
  return new ReadableStream({
    start(controller) {
      ws.addEventListener('message', (event) => {
        if (!closed) controller.enqueue(event.data);
      });
      ws.addEventListener('close', () => {
        safeClose(ws);
        if (!closed) { closed = true; controller.close(); }
      });
      ws.addEventListener('error', (event) => controller.error(event));

      const early = decodeBase64Url(earlyDataHeader);
      if (early.error) controller.error(early.error);
      else if (early.data) controller.enqueue(early.data);
    },
    cancel() {
      if (!closed) { closed = true; safeClose(ws); }
    },
  });
}

function decodeBase64Url(str) {
  if (!str) return {};
  try {
    const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(b64);
    return { data: Uint8Array.from(raw, (c) => c.charCodeAt(0)).buffer };
  } catch (e) {
    return { error: e };
  }
}

const HEX = Array.from({ length: 256 }, (_, i) => (i + 256).toString(16).slice(1));
function stringifyUuid(a) {
  return (
    HEX[a[0]] + HEX[a[1]] + HEX[a[2]] + HEX[a[3]] + '-' +
    HEX[a[4]] + HEX[a[5]] + '-' +
    HEX[a[6]] + HEX[a[7]] + '-' +
    HEX[a[8]] + HEX[a[9]] + '-' +
    HEX[a[10]] + HEX[a[11]] + HEX[a[12]] + HEX[a[13]] + HEX[a[14]] + HEX[a[15]]
  ).toLowerCase();
}

function concat(...arrays) {
  const total = arrays.reduce((n, a) => n + a.byteLength, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const a of arrays) {
    out.set(a instanceof Uint8Array ? a : new Uint8Array(a), pos);
    pos += a.byteLength;
  }
  return out.buffer;
}

function safeClose(ws) {
  try {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CLOSING) ws.close();
  } catch { /* already closed */ }
}
