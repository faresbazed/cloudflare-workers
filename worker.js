/**
 * VLESS over WebSocket (WS + TLS 443) Cloudflare Worker
 * Uses the native `cloudflare:sockets` API for outbound TCP connections.
 */

import { connect } from 'cloudflare:sockets';

// Default configuration (override via Wrangler environment variables / secrets)
let defaultUUID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
let defaultProxyIP = '';

export default {
  async fetch(request, env, ctx) {
    try {
      const userID = (env.UUID || defaultUUID).toLowerCase();
      const proxyIP = env.PROXYIP || defaultProxyIP;
      const upgradeHeader = request.headers.get('Upgrade');

      if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
        const url = new URL(request.url);
        if (url.pathname === `/${userID}`) {
          const host = request.headers.get('Host') || url.hostname;
          const vlessConfig = getVLESSConfig(userID, host);
          return new Response(vlessConfig, {
            status: 200,
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          });
        }
        return new Response('VLESS Cloudflare Worker Node is active.', {
          status: 200,
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        });
      }

      return await handleVLESSWebSocket(request, userID, proxyIP);
    } catch (err) {
      return new Response(err.toString(), { status: 500 });
    }
  },
};

/**
 * Upgrades the incoming HTTP request to a WebSocket session and bridges it
 * to an outbound TCP socket using the VLESS wire protocol.
 */
async function handleVLESSWebSocket(request, userID, proxyIP) {
  const webSocketPair = new WebSocketPair();
  const [client, webSocket] = Object.values(webSocketPair);
  webSocket.accept();

  let address = '';
  let portWithRandomLog = '';
  const log = (info, event) => {
    console.log(`[${address}:${portWithRandomLog}] ${info}`, event || '');
  };

  const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
  const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader, log);

  let remoteSocketWrapper = { value: null };
  let udpStreamWrite = null;
  let isDns = false;

  readableWebSocketStream
    .pipeTo(
      new WritableStream({
        async write(chunk, controller) {
          if (isDns && udpStreamWrite) {
            return udpStreamWrite(chunk);
          }
          if (remoteSocketWrapper.value) {
            const writer = remoteSocketWrapper.value.writable.getWriter();
            await writer.write(chunk);
            writer.releaseLock();
            return;
          }

          const {
            hasError,
            message,
            portRemote = 443,
            addressRemote = '',
            rawDataIndex,
            vlessVersion = new Uint8Array([0, 0]),
            isUDP,
          } = processVLESSHeader(chunk, userID);

          address = addressRemote;
          portWithRandomLog = `${portRemote}--${Math.random()} ${isUDP ? 'udp ' : 'tcp '}`;

          if (hasError) {
            throw new Error(message);
          }

          if (isUDP) {
            if (portRemote === 53) {
              isDns = true;
            } else {
              throw new Error('UDP proxy is only enabled for DNS (port 53)');
            }
          }

          const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
          const rawClientData = chunk.slice(rawDataIndex);

          if (isDns) {
            const { write } = await handleDNSOutbound(webSocket, vlessResponseHeader, log);
            udpStreamWrite = write;
            udpStreamWrite(rawClientData);
            return;
          }

          handleTCPOutbound(
            remoteSocketWrapper,
            addressRemote,
            portRemote,
            rawClientData,
            webSocket,
            vlessResponseHeader,
            proxyIP,
            log
          );
        },
        close() {
          log('readableWebSocketStream closed');
        },
        abort(reason) {
          log('readableWebSocketStream aborted', JSON.stringify(reason));
        },
      })
    )
    .catch((err) => {
      log('readableWebSocketStream pipeTo error', err);
    });

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
}

/**
 * Establishes outbound TCP connection and retries via proxyIP if initial read fails.
 */
async function handleTCPOutbound(
  remoteSocket,
  addressRemote,
  portRemote,
  rawClientData,
  webSocket,
  vlessResponseHeader,
  proxyIP,
  log
) {
  async function connectAndWrite(address, port) {
    const tcpSocket = connect({
      hostname: address,
      port: port,
    });
    remoteSocket.value = tcpSocket;
    log(`connected to ${address}:${port}`);
    const writer = tcpSocket.writable.getWriter();
    await writer.write(rawClientData);
    writer.releaseLock();
    return tcpSocket;
  }

  async function retry() {
    const fallbackHost = proxyIP || addressRemote;
    const tcpSocket = await connectAndWrite(fallbackHost, portRemote);
    tcpSocket.closed
      .catch((error) => {
        console.log('retry tcpSocket closed error', error);
      })
      .finally(() => {
        safeCloseWebSocket(webSocket);
      });
    remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, null, log);
  }

  const tcpSocket = await connectAndWrite(addressRemote, portRemote);
  remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, retry, log);
}

/**
 * Converts WebSocket events and optional 0-RTT early data into a ReadableStream.
 */
function makeReadableWebSocketStream(webSocketServer, earlyDataHeader, log) {
  let readableStreamCancel = false;
  return new ReadableStream({
    start(controller) {
      webSocketServer.addEventListener('message', (event) => {
        if (readableStreamCancel) return;
        controller.enqueue(event.data);
      });
      webSocketServer.addEventListener('close', () => {
        safeCloseWebSocket(webSocketServer);
        if (readableStreamCancel) return;
        controller.close();
      });
      webSocketServer.addEventListener('error', (err) => {
        log('webSocketServer error');
        controller.error(err);
      });
      const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
      if (error) {
        controller.error(error);
      } else if (earlyData) {
        controller.enqueue(earlyData);
      }
    },
    cancel(reason) {
      if (readableStreamCancel) return;
      log(`ReadableStream canceled: ${reason}`);
      readableStreamCancel = true;
      safeCloseWebSocket(webSocketServer);
    },
  });
}

/**
 * Parses the VLESS binary header:
 * [1B Version] [16B UUID] [1B Addon Length] [Addon] [1B Command] [2B Port] [1B AddrType] [Addr] [Payload]
 */
function processVLESSHeader(vlessBuffer, userID) {
  if (vlessBuffer.byteLength < 24) {
    return { hasError: true, message: 'Invalid VLESS header: buffer too short' };
  }

  const version = new Uint8Array(vlessBuffer.slice(0, 1));
  const incomingUUID = stringifyUUID(new Uint8Array(vlessBuffer.slice(1, 17)));

  if (incomingUUID !== userID.toLowerCase()) {
    return { hasError: true, message: 'Invalid VLESS user UUID' };
  }

  const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0];
  const command = new Uint8Array(vlessBuffer.slice(18 + optLength, 18 + optLength + 1))[0];

  let isUDP = false;
  if (command === 1) {
    isUDP = false;
  } else if (command === 2) {
    isUDP = true;
  } else {
    return { hasError: true, message: `Unsupported VLESS command: ${command}` };
  }

  const portIndex = 18 + optLength + 1;
  const portBuffer = vlessBuffer.slice(portIndex, portIndex + 2);
  const portRemote = new DataView(portBuffer).getUint16(0);

  let addressIndex = portIndex + 2;
  const addressBuffer = new Uint8Array(vlessBuffer.slice(addressIndex, addressIndex + 1));
  const addressType = addressBuffer[0];
  let addressLength = 0;
  let addressValueIndex = addressIndex + 1;
  let addressValue = '';

  switch (addressType) {
    case 1: // IPv4
      addressLength = 4;
      addressValue = new Uint8Array(
        vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
      ).join('.');
      break;
    case 2: // Domain name
      addressLength = new Uint8Array(
        vlessBuffer.slice(addressValueIndex, addressValueIndex + 1)
      )[0];
      addressValueIndex += 1;
      addressValue = new TextDecoder().decode(
        vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
      );
      break;
    case 3: // IPv6
      addressLength = 16;
      const dataView = new DataView(
        vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
      );
      const ipv6 = [];
      for (let i = 0; i < 8; i++) {
        ipv6.push(dataView.getUint16(i * 2).toString(16));
      }
      addressValue = ipv6.join(':');
      break;
    default:
      return { hasError: true, message: `Invalid addressType: ${addressType}` };
  }

  if (!addressValue) {
    return { hasError: true, message: `Empty addressValue for type ${addressType}` };
  }

  return {
    hasError: false,
    addressRemote: addressValue,
    addressType,
    portRemote,
    rawDataIndex: addressValueIndex + addressLength,
    vlessVersion: version,
    isUDP,
  };
}

/**
 * Pipes data from the outbound TCP socket back to the client WebSocket.
 */
async function remoteSocketToWS(remoteSocket, webSocket, vlessResponseHeader, retry, log) {
  let vlessHeader = vlessResponseHeader;
  let hasIncomingData = false;

  await remoteSocket.readable
    .pipeTo(
      new WritableStream({
        async write(chunk, controller) {
          hasIncomingData = true;
          if (webSocket.readyState !== 1) {
            controller.error('WebSocket is not open');
          }
          if (vlessHeader) {
            webSocket.send(await new Blob([vlessHeader, chunk]).arrayBuffer());
            vlessHeader = null;
          } else {
            webSocket.send(chunk);
          }
        },
        close() {
          log(`remoteSocket.readable closed, hasIncomingData: ${hasIncomingData}`);
        },
        abort(reason) {
          console.error('remoteSocket.readable abort', reason);
        },
      })
    )
    .catch((error) => {
      console.error('remoteSocketToWS exception', error);
      safeCloseWebSocket(webSocket);
    });

  if (hasIncomingData === false && retry) {
    log('No incoming data from target, retrying with fallback...');
    retry();
  }
}

/**
 * Resolves UDP port 53 DNS queries over HTTPS (Cloudflare 1.1.1.1 DoH).
 */
async function handleDNSOutbound(webSocket, vlessResponseHeader, log) {
  let isVlessHeaderSent = false;
  const transformStream = new TransformStream({
    transform(chunk, controller) {
      for (let index = 0; index < chunk.byteLength; ) {
        const lengthBuffer = chunk.slice(index, index + 2);
        const udpPacketLength = new DataView(lengthBuffer).getUint16(0);
        const udpData = new Uint8Array(chunk.slice(index + 2, index + 2 + udpPacketLength));
        index = index + 2 + udpPacketLength;
        controller.enqueue(udpData);
      }
    },
  });

  transformStream.readable
    .pipeTo(
      new WritableStream({
        async write(chunk) {
          const resp = await fetch('https://1.1.1.1/dns-query', {
            method: 'POST',
            headers: { 'content-type': 'application/dns-message' },
            body: chunk,
          });
          const dnsQueryResult = await resp.arrayBuffer();
          const udpSize = dnsQueryResult.byteLength;
          const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);

          if (webSocket.readyState === 1) {
            if (isVlessHeaderSent) {
              webSocket.send(await new Blob([udpSizeBuffer, dnsQueryResult]).arrayBuffer());
            } else {
              webSocket.send(
                await new Blob([vlessResponseHeader, udpSizeBuffer, dnsQueryResult]).arrayBuffer()
              );
              isVlessHeaderSent = true;
            }
          }
        },
      })
    )
    .catch((error) => {
      log('DNS DoH error: ' + error);
    });

  const writer = transformStream.writable.getWriter();
  return {
    write(chunk) {
      writer.write(chunk);
    },
  };
}

function base64ToArrayBuffer(base64Str) {
  if (!base64Str) {
    return { error: null };
  }
  try {
    base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
    const decode = atob(base64Str);
    const arryBuffer = Uint8Array.from(decode, (c) => c.charCodeAt(0));
    return { earlyData: arryBuffer.buffer, error: null };
  } catch (error) {
    return { error };
  }
}

const byteToHex = [];
for (let i = 0; i < 256; ++i) {
  byteToHex.push((i + 256).toString(16).slice(1));
}

function stringifyUUID(arr, offset = 0) {
  return (
    byteToHex[arr[offset + 0]] +
    byteToHex[arr[offset + 1]] +
    byteToHex[arr[offset + 2]] +
    byteToHex[arr[offset + 3]] +
    '-' +
    byteToHex[arr[offset + 4]] +
    byteToHex[arr[offset + 5]] +
    '-' +
    byteToHex[arr[offset + 6]] +
    byteToHex[arr[offset + 7]] +
    '-' +
    byteToHex[arr[offset + 8]] +
    byteToHex[arr[offset + 9]] +
    '-' +
    byteToHex[arr[offset + 10]] +
    byteToHex[arr[offset + 11]] +
    byteToHex[arr[offset + 12]] +
    byteToHex[arr[offset + 13]] +
    byteToHex[arr[offset + 14]] +
    byteToHex[arr[offset + 15]]
  ).toLowerCase();
}

function safeCloseWebSocket(socket) {
  try {
    if (socket.readyState === 1 || socket.readyState === 2) {
      socket.close();
    }
  } catch (error) {
    console.error('safeCloseWebSocket error', error);
  }
}

/**
 * Generates standard VLESS WS+TLS 443 URI and client configuration snippet.
 */
function getVLESSConfig(userID, hostName) {
  const vlessMain =
    `vless://${userID}@${hostName}:443` +
    `?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2048#${hostName}`;

  return [
    '=== VLESS WS + TLS (Port 443) Node Configuration ===',
    '',
    'Share URI:',
    vlessMain,
    '',
    'Client Parameters:',
    `- Address: ${hostName}`,
    '- Port: 443',
    `- UUID: ${userID}`,
    '- Encryption: none',
    '- Transport (Network): ws (WebSocket)',
    `- WebSocket Host: ${hostName}`,
    '- WebSocket Path: /?ed=2048',
    '- TLS: tls',
    `- SNI: ${hostName}`,
    '- ALPN: h2, http/1.1 (or http/1.1)',
  ].join('\n');
}