// End-to-end tests: boots `worker.js` (the OBFUSCATED artifact) in a local
// workerd runtime via `wrangler dev`, then drives it with a real WebSocket
// VLESS client implementation. Requires network access for DoH/DNS tests.
//
// Prereq: worker.js must be built (npm run build) and .dev.vars present.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { once } from 'node:events';
import net from 'node:net';

const PORT = 8787;
const BASE = `http://127.0.0.1:${PORT}`;
const ID = 'd342d11c-d424-4393-b46c-4fe1a45e9c1f';
const OTHER_ID = '0f0e0d0c-0b0a-4909-8080-706050403020';

if (!existsSync('worker.js')) {
  console.error('worker.js missing — run `npm run build` first');
  process.exit(1);
}
if (!existsSync('.dev.vars')) {
  // Generate a local-only one so the dev server has credentials.
  execSync(`printf 'K=${ID},${OTHER_ID}\\n' > .dev.vars`);
}

// ---------------------------------------------------------------- VLESS client
const ATYP = { IPV4: 1, NAME: 2, IPV6: 3 };
const hexID = ID.replaceAll('-', '');
const idBytes = Uint8Array.from({ length: 16 }, (_, i) => parseInt(hexID.slice(i * 2, i * 2 + 2), 16));

function buildHeader(addr, port, { udp = false } = {}) {
  const isName = /[a-z]/i.test(addr);
  const addrPart = isName
    ? [ATYP.NAME, ...new TextEncoder().encode(addr)]
    : [ATYP.IPV4, ...addr.split('.').map(Number)];
  return new Uint8Array([0, ...idBytes, 0, udp ? 2 : 1, port >> 8, port & 0xff, ...addrPart]);
}

function toB64url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

async function vlessConnect(addr, port, { udp = false } = {}) {
  const ws = new WebSocket(`${BASE}/`, { headers: { 'sec-websocket-protocol': toB64url(buildHeader(addr, port, { udp })) } });
  ws.binaryType = 'arraybuffer';
  await once(ws, 'open');
  return ws;
}

function wsCollect(ws, { timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const timer = setTimeout(() => resolve(chunks), timeout);
    ws.addEventListener('message', (e) => chunks.push(new Uint8Array(e.data)));
    ws.addEventListener('close', () => { clearTimeout(timer); resolve(chunks); });
    ws.addEventListener('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

function firstReply(chunks) {
  // First server message: [version, addonLen=0, ...payload]
  assert.ok(chunks.length > 0, 'no reply from server');
  assert.equal(chunks[0][0], 0, 'response version');
  assert.equal(chunks[0][1], 0, 'response addon length');
  return chunks.map((c) => c.subarray(c[0][0] === 0 && chunks[0] === c ? 2 : 0));
}

// ---------------------------------------------------------------- dev server
let devProc;
let echoServer;
let ECHO_PORT;
test.before(async () => {
  // Local TCP echo server on an ephemeral port: hermetic relay target
  // (the sandbox blocks raw outbound TCP to the internet, so real-website
  // targets can't be used here) and immune to port collisions.
  echoServer = net.createServer((sock) => {
    sock.on('data', (d) => sock.write(d));
  });
  await new Promise((res) => echoServer.listen(0, '127.0.0.1', res));
  ECHO_PORT = echoServer.address().port;

  devProc = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--local', '--ip', '127.0.0.1'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
  devProc.stdout.on('data', (d) => process.env.DEBUG_E2E && process.stderr.write(d));
  devProc.stderr.on('data', (d) => process.env.DEBUG_E2E && process.stderr.write(d));
  // Wait until the server answers.
  const deadline = Date.now() + 90000;
  for (;;) {
    try {
      const r = await fetch(BASE);
      if (r.status) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('wrangler dev did not start');
    await new Promise((r) => setTimeout(r, 1000));
  }
});

test.after(() => {
  if (devProc) devProc.kill('SIGKILL');
  if (echoServer) echoServer.close();
});

// ---------------------------------------------------------------- HTTP tests
test('status page for anonymous visitors', async () => {
  const r = await fetch(BASE);
  assert.equal(r.status, 200);
  const body = await r.text();
  assert.match(body, /All systems normal/);
  assert.doesNotMatch(body.toLowerCase(), /vless|uuid|proxy/);
});

test('info page behind credential path', async () => {
  const r = await fetch(`${BASE}/${ID}`);
  assert.equal(r.status, 200);
  const body = await r.text();
  assert.ok(body.includes(`${ID}@`), 'contains id');
  assert.ok(body.includes('security=tls') && body.includes('type=ws'), 'transport params');
  // the scheme link is shown to the credential holder by design;
  // keyword hiding applies to the artifact, verified separately
  assert.ok(body.includes('://'), 'scheme link present');
  assert.doesNotMatch(body.toLowerCase(), /uuid/);
});

test('unknown path gets 404 status page', async () => {
  const r = await fetch(`${BASE}/nope`);
  assert.equal(r.status, 404);
  assert.match(await r.text(), /All systems normal/);
});

test('wrong id path returns status page, not info', async () => {
  const r = await fetch(`${BASE}/11111111-2222-4333-8444-555555555555`);
  assert.equal(r.status, 404);
});

// ---------------------------------------------------------------- WS relay tests
test('TCP relay: echo round-trip through the tunnel', async () => {
  const ws = await vlessConnect('127.0.0.1', ECHO_PORT);
  const collect = wsCollect(ws, { timeout: 8000 });
  const payload = new TextEncoder().encode('ping-through-the-tunnel');
  ws.send(payload);
  const chunks = await collect;
  assert.ok(chunks.length > 0, 'echo server replied through tunnel');
  const text = new TextDecoder().decode(chunks[0].subarray(2)); // skip [ver, addon]
  assert.equal(text, 'ping-through-the-tunnel', 'payload echoed intact');
  ws.close();
});

test('TCP relay: header split across frames still works', async () => {
  // Send a partial header first (split mid-address), then the rest plus
  // payload in a separate frame, to exercise the buffering path.
  const head = buildHeader('127.0.0.1', ECHO_PORT);
  const ws = new WebSocket(`${BASE}/`);
  ws.binaryType = 'arraybuffer';
  await once(ws, 'open');
  const collect = wsCollect(ws, { timeout: 8000 });
  ws.send(head.subarray(0, 20));
  ws.send(head.subarray(20));
  ws.send(new TextEncoder().encode('split-header-payload'));
  const chunks = await collect;
  const text = new TextDecoder().decode(chunks[0].subarray(2));
  assert.equal(text, 'split-header-payload', 'relay works with split header');
  ws.close();
});

test('invalid id: server closes without relaying', async () => {
  const bad = buildHeader('127.0.0.1', ECHO_PORT);
  bad.set([0xff], 1); // corrupt the id
  const ws = new WebSocket(`${BASE}/`, { headers: { 'sec-websocket-protocol': toB64url(bad) } });
  ws.binaryType = 'arraybuffer';
  await once(ws, 'open');
  const [closeEv] = await once(ws, 'close');
  assert.ok(closeEv, 'socket closed after bad id');
});

test('UDP DNS: resolves example.com via DoH', async () => {
  const ws = await vlessConnect('1.1.1.1', 53, { udp: true });
  const collect = wsCollect(ws, { timeout: 8000 });
  // DNS query for example.com A (well-formed wire format)
  const q = Buffer.from('120401000001000000000000076578616d706c6503636f6d0000010001', 'hex');
  const framed = Buffer.concat([Buffer.from([0, q.length]), q]);
  ws.send(framed);
  const chunks = await collect;
  assert.ok(chunks.length > 0, 'DNS reply arrived');
  const first = chunks[0];
  // [ver, addon, lenHi, lenLo, ...dns]
  assert.equal(first[0], 0);
  assert.equal(first[1], 0);
  const len = (first[2] << 8) | first[3];
  assert.ok(len > 0, 'framed DNS answer length');
  assert.ok(first.byteLength >= 4 + len, 'answer fully framed');
  ws.close();
});

test('second configured id also authenticates (info page)', async () => {
  const r = await fetch(`${BASE}/${OTHER_ID}`);
  assert.equal(r.status, 200);
  assert.ok((await r.text()).includes(OTHER_ID));
});
