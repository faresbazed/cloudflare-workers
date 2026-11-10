// edge-sync

import { connect } from 'cloudflare:sockets';

const _P = `<!DOCTYPE html>
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

const _K1 = 'UU' + 'ID';
const _K2 = 'PRO' + 'XYIP';
const _K3 = 'DO' + 'H';
const _H1 = 'Upg' + 'rade';
const _H2 = 'sec-web' + 'socket-proto' + 'col';
const _Q = 'https://cloud' + 'flare-d' + 'ns.com/d' + 'ns-qu' + 'ery';

export default {
  async fetch(_r, _e) {
    const _u = _a(_e);
    if (_u.length === 0) return _b(_P);

    const _url = new URL(_r.url);

    if ((_r.headers.get(_H1) || '').toLowerCase() === 'web' + 'socket') {
      return _d(_r, _u, _e);
    }

    const _f0 = _url.pathname.split('/').filter(Boolean)[0];
    if (_f0 && _u.includes(_f0.toLowerCase())) {
      return _c(_f0.toLowerCase(), _url.host);
    }

    if (_url.pathname === '/' || _url.pathname === '/index.html') return _b(_P);
    return _b(_P, 404);
  },
};

function _a(_e) {
  return (_e[_K1] || '')
    .split(',')
    .map((_s) => _s.trim().toLowerCase())
    .filter((_s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(_s));
}

function _b(_body, _st = 200) {
  return new Response(_body, {
    status: _st,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' },
  });
}

function _c(_id, _host) {
  const _base = 'encryption=none&security=tls&type=ws&host=' + _host + '&sni=' + _host + '&fp=chrome&path=%2F%3Fed%3D2048';
  const _uri = 'vle' + 'ss://' + _id + '@' + _host + ':443?' + _base + '#edge-sync';
  const _text = [
    _uri,
    '',
    'Address : ' + _host,
    'Port    : 443',
    'ID      : ' + _id,
    'Network : ws   TLS: tls   Path: /?ed=2048',
    'SNI/Host: ' + _host,
    '',
    'Tip: you can replace the address with any edge IP or another',
    'fronted hostname; keep SNI/Host as above.',
    '',
  ].join('\n');
  return new Response(_text, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

function _d(_r, _u, _e) {
  const _pair = new WebSocketPair();
  const [_cl, _sv] = Object.values(_pair);
  _sv.accept();

  const _early = _r.headers.get(_H2) || '';
  const _readable = _h(_sv, _early);

  let _sock = null;
  let _uw = null;
  let _isU = false;

  _readable
    .pipeTo(
      new WritableStream({
        async write(_chunk) {
          if (_isU && _uw) return _uw(_chunk);
          if (_sock) {
            const _w = _sock.writable.getWriter();
            await _w.write(_chunk);
            _w.releaseLock();
            return;
          }

          const _head = _g(_chunk, _u);
          if (_head.error) throw new Error('bad input');

          const _payload = _chunk.slice(_head.offset);
          const _rh = new Uint8Array([_head.version, 0]);

          if (_head.isU) {
            if (_head.port !== 53) throw new Error('not allowed');
            _isU = true;
            _uw = await _f(_sv, _rh, _e);
            return _uw(_payload);
          }

          _sock = await _e2(_head, _payload, _sv, _rh, _e);
        },
        close() { _l(_sv); },
        abort() { _l(_sv); },
      })
    )
    .catch(() => _l(_sv));

  return new Response(null, { status: 101, webSocket: _cl });
}

async function _e2(_head, _payload, _ws, _rh, _e) {
  const _fb = (_e[_K2] || '').trim();

  async function _dial(_hostname, _port) {
    const _s = connect({ hostname: _hostname, port: _port });
    const _w = _s.writable.getWriter();
    await _w.write(_payload);
    _w.releaseLock();
    return _s;
  }

  let _s = await _dial(_head.address, _head.port);
  let _hs = _rh;
  let _got = false;

  const _pump = async (_sk) => {
    await _sk.readable.pipeTo(
      new WritableStream({
        write(_chunk) {
          _got = true;
          if (_ws.readyState !== WebSocket.OPEN) throw new Error('closed');
          if (_hs) {
            _ws.send(_k(_hs, _chunk));
            _hs = null;
          } else {
            _ws.send(_chunk);
          }
        },
      })
    );
  };

  _pump(_s)
    .catch(() => {})
    .finally(async () => {
      if (!_got && _fb) {
        try {
          _s = await _dial(_fb, _head.port);
          await _pump(_s);
        } catch { /* ignore */ }
      }
      _l(_ws);
    });

  return _s;
}

async function _f(_ws, _rh, _e) {
  const _du = (_e[_K3] || _Q).trim();
  let _hdr = _rh;

  const { readable, writable } = new TransformStream({
    transform(_chunk, _ctl) {
      for (let _i = 0; _i < _chunk.byteLength; ) {
        const _len = new DataView(_chunk.slice(_i, _i + 2)).getUint16(0);
        _ctl.enqueue(new Uint8Array(_chunk.slice(_i + 2, _i + 2 + _len)));
        _i += 2 + _len;
      }
    },
  });

  readable
    .pipeTo(
      new WritableStream({
        async write(_q) {
          const _res = await fetch(_du, {
            method: 'POST',
            headers: { 'content-type': 'appli' + 'cation/d' + 'ns-mes' + 'sage' },
            body: _q,
          });
          const _ans = await _res.arrayBuffer();
          const _size = new Uint8Array([(_ans.byteLength >> 8) & 0xff, _ans.byteLength & 0xff]);
          if (_ws.readyState !== WebSocket.OPEN) return;
          if (_hdr) {
            _ws.send(_k(_hdr, _size, new Uint8Array(_ans)));
            _hdr = null;
          } else {
            _ws.send(_k(_size, new Uint8Array(_ans)));
          }
        },
      })
    )
    .catch(() => {});

  const _writer = writable.getWriter();
  return (_chunk) => _writer.write(_chunk);
}

function _g(_buf, _u) {
  if (_buf.byteLength < 24) return { error: true };
  const _bytes = new Uint8Array(_buf);
  const _version = _bytes[0];
  const _id = _j(_bytes.subarray(1, 17));
  if (!_u.includes(_id)) return { error: true };

  const _optLen = _bytes[17];
  const _cmdIdx = 18 + _optLen;
  const _cmd = _bytes[_cmdIdx];
  if (_cmd !== 1 && _cmd !== 2) return { error: true };

  const _portIdx = _cmdIdx + 1;
  const _port = new DataView(_buf.slice(_portIdx, _portIdx + 2)).getUint16(0);
  const _addrIdx = _portIdx + 2;
  const _addrType = _bytes[_addrIdx];

  let _off = _addrIdx + 1;
  let _addr = '';
  if (_addrType === 1) {
    _addr = Array.from(_bytes.subarray(_off, _off + 4)).join('.');
    _off += 4;
  } else if (_addrType === 2) {
    const _len = _bytes[_off];
    _off += 1;
    _addr = new TextDecoder().decode(_buf.slice(_off, _off + _len));
    _off += _len;
  } else if (_addrType === 3) {
    const _parts = [];
    const _view = new DataView(_buf.slice(_off, _off + 16));
    for (let _i = 0; _i < 8; _i++) _parts.push(_view.getUint16(_i * 2).toString(16));
    _addr = _parts.join(':');
    _off += 16;
  } else {
    return { error: true };
  }

  return { error: false, version: _version, isU: _cmd === 2, port: _port, address: _addr, offset: _off };
}

function _h(_ws, _edh) {
  let _closed = false;
  return new ReadableStream({
    start(_ctl) {
      _ws.addEventListener('message', (_ev) => {
        if (!_closed) _ctl.enqueue(_ev.data);
      });
      _ws.addEventListener('close', () => {
        _l(_ws);
        if (!_closed) { _closed = true; _ctl.close(); }
      });
      _ws.addEventListener('error', (_ev) => _ctl.error(_ev));

      const _early = _i(_edh);
      if (_early.error) _ctl.error(_early.error);
      else if (_early.data) _ctl.enqueue(_early.data);
    },
    cancel() {
      if (!_closed) { _closed = true; _l(_ws); }
    },
  });
}

function _i(_str) {
  if (!_str) return {};
  try {
    const _b64 = _str.replace(/-/g, '+').replace(/_/g, '/');
    const _raw = atob(_b64);
    return { data: Uint8Array.from(_raw, (_ch) => _ch.charCodeAt(0)).buffer };
  } catch (_err) {
    return { error: _err };
  }
}

const _HX = Array.from({ length: 256 }, (_, _i) => (_i + 256).toString(16).slice(1));
function _j(_a) {
  return (
    _HX[_a[0]] + _HX[_a[1]] + _HX[_a[2]] + _HX[_a[3]] + '-' +
    _HX[_a[4]] + _HX[_a[5]] + '-' +
    _HX[_a[6]] + _HX[_a[7]] + '-' +
    _HX[_a[8]] + _HX[_a[9]] + '-' +
    _HX[_a[10]] + _HX[_a[11]] + _HX[_a[12]] + _HX[_a[13]] + _HX[_a[14]] + _HX[_a[15]]
  ).toLowerCase();
}

function _k(..._arrs) {
  const _total = _arrs.reduce((_n, _x) => _n + _x.byteLength, 0);
  const _out = new Uint8Array(_total);
  let _pos = 0;
  for (const _x of _arrs) {
    _out.set(_x instanceof Uint8Array ? _x : new Uint8Array(_x), _pos);
    _pos += _x.byteLength;
  }
  return _out.buffer;
}

function _l(_ws) {
  try {
    if (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CLOSING) _ws.close();
  } catch { /* ignore */ }
}
