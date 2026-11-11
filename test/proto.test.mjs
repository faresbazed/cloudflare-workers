// Unit tests for the protocol codec (pure functions, no Workers runtime needed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRequest, idFromBytes, concatBytes, ATYP, CMD } from '../src/proto.js';

const ID = 'd342d11c-d424-4393-b46c-4fe1a45e9c1f';
const hex = ID.replaceAll('-', '');
const idBytes = Uint8Array.from({ length: 16 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
const ids = new Set([ID]);

// Build a vless-style request header: ver, id, addonLen, cmd, port, atyp, addr
function header({ cmd = CMD.TCP, port = 443, atyp = ATYP.IPV4, addr = [] } = {}) {
  return new Uint8Array([0, ...idBytes, 0, cmd, port >> 8, port & 0xff, atyp, ...addr]);
}

test('idFromBytes roundtrip', () => {
  assert.equal(idFromBytes(idBytes), ID);
});

test('parses ipv4 tcp header, offset points past addr', () => {
  const h = header({ addr: [1, 2, 3, 4] });
  const r = parseRequest(h, ids);
  assert.equal(r.ok, true);
  assert.equal(r.isUdp, false);
  assert.equal(r.port, 443);
  assert.equal(r.addr, '1.2.3.4');
  assert.equal(r.offset, 26); // 1 ver + 16 id + 1 addon + 1 cmd + 2 port + 1 atyp + 4 addr
});

test('parses domain header with payload after it', () => {
  const name = new TextEncoder().encode('example.com');
  const h = concatBytes([header({ port: 80, atyp: ATYP.NAME, addr: [name.length, ...name] }), new Uint8Array([9, 9, 9])]);
  const r = parseRequest(h, ids);
  assert.equal(r.addr, 'example.com');
  assert.equal(r.port, 80);
  assert.equal(h.subarray(r.offset)[0], 9); // payload intact after header
});

test('parses ipv6 header', () => {
  const r = parseRequest(header({ atyp: ATYP.IPV6, addr: new Array(16).fill(0) }), ids);
  assert.equal(r.addr, '0:0:0:0:0:0:0:0');
});

test('udp command flagged', () => {
  const r = parseRequest(header({ cmd: CMD.UDP, port: 53, atyp: ATYP.NAME, addr: [0] }), ids);
  assert.equal(r.isUdp, true);
});

test('partial buffer returns null (need more bytes)', () => {
  assert.equal(parseRequest(header({ addr: [1, 2, 3, 4] }).subarray(0, 20), ids), null);
  // header complete but ipv4 addr truncated
  assert.equal(parseRequest(header({ addr: [1, 2, 3, 4] }).subarray(0, 25), ids), null);
});

test('unknown id rejected', () => {
  const bad = header({ addr: [8, 8, 8, 8] });
  bad.set([0xff], 1);
  assert.deepEqual(parseRequest(bad, ids), { error: true });
});

test('bad command rejected', () => {
  const h = header({ cmd: 3, addr: [8, 8, 8, 8] });
  assert.deepEqual(parseRequest(h, ids), { error: true });
});

test('bad atyp rejected', () => {
  const h = header({ atyp: 9, addr: [8, 8, 8, 8] });
  assert.deepEqual(parseRequest(h, ids), { error: true });
});

test('addon length shifts command position', () => {
  const h = new Uint8Array([0, ...idBytes, 2, 0xaa, 0xbb, CMD.TCP, 0, 80, ATYP.IPV4, 1, 1, 1, 1]);
  const r = parseRequest(h, ids);
  assert.equal(r.ok, true);
  assert.equal(r.port, 80);
});
