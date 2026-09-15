/**
 * cdp.mjs — a minimal, dependency-free Chrome DevTools Protocol client.
 * ---------------------------------------------------------------------------
 * Why hand-rolled: the harness has its own CDP tooling, but CI will not — and
 * a smoke test that depends on the dev machine's framework is not a smoke test.
 * This is ~100 lines of RFC 6455 client plus a JSON-RPC envelope, which is all
 * that is actually required to drive a browser.
 *
 * Deliberately supports only what we need: text frames, ping/pong, close,
 * fragmentation, and the 7/16/64-bit length forms (screenshots arrive as
 * multi-megabyte base64, so the 64-bit path is not theoretical).
 * ---------------------------------------------------------------------------
 */

import net from 'node:net';
import crypto from 'node:crypto';

const OP_TEXT = 0x1, OP_BINARY = 0x2, OP_CLOSE = 0x8, OP_PING = 0x9, OP_PONG = 0xa;

function frame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(6);
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = Buffer.alloc(8);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(14);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;          // FIN set: we never fragment outbound
  const mask = crypto.randomBytes(4);
  mask.copy(header, header.length - 4);
  const body = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, body]);
}

/** Open a CDP session over an existing WebSocket debugger URL. */
export async function connect(wsUrl) {
  const u = new URL(wsUrl);
  const sock = net.connect({ host: u.hostname, port: Number(u.port) });
  sock.setNoDelay(true);

  await new Promise((res, rej) => {
    sock.once('connect', res);
    sock.once('error', rej);
  });

  const key = crypto.randomBytes(16).toString('base64');
  sock.write(
    `GET ${u.pathname}${u.search} HTTP/1.1\r\n` +
    `Host: ${u.host}\r\n` +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Key: ${key}\r\n` +
    'Sec-WebSocket-Version: 13\r\n\r\n'
  );

  // consume the handshake response, keeping any frame bytes that came with it
  let backlog = Buffer.alloc(0);
  await new Promise((res, rej) => {
    const onData = (chunk) => {
      backlog = Buffer.concat([backlog, chunk]);
      const end = backlog.indexOf('\r\n\r\n');
      if (end === -1) return;
      const head = backlog.subarray(0, end).toString('latin1');
      if (!/^HTTP\/1\.1 101/.test(head)) {
        sock.off('data', onData);
        return rej(new Error('websocket upgrade failed: ' + head.split('\r\n')[0]));
      }
      sock.off('data', onData);
      backlog = backlog.subarray(end + 4);
      res();
    };
    sock.on('data', onData);
    sock.once('error', rej);
  });

  const pending = new Map();
  const frags = [];
  let id = 0;
  let closed = false;

  function drain() {
    for (;;) {
      if (backlog.length < 2) return;
      const b0 = backlog[0], b1 = backlog[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (backlog.length < 4) return;
        len = backlog.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (backlog.length < 10) return;
        len = Number(backlog.readBigUInt64BE(2)); off = 10;
      }
      let mask = null;
      if (masked) {
        if (backlog.length < off + 4) return;
        mask = backlog.subarray(off, off + 4); off += 4;
      }
      if (backlog.length < off + len) return;

      let payload = backlog.subarray(off, off + len);
      if (masked) {
        const copy = Buffer.from(payload);
        for (let i = 0; i < copy.length; i++) copy[i] ^= mask[i % 4];
        payload = copy;
      }
      backlog = backlog.subarray(off + len);

      if (opcode === OP_CLOSE) { closed = true; return; }
      if (opcode === OP_PING) { sock.write(frame(OP_PONG, payload)); continue; }
      if (opcode === OP_PONG) continue;

      frags.push(payload);
      if (!fin) continue;

      const text = Buffer.concat(frags).toString('utf8');
      frags.length = 0;
      let msg;
      try { msg = JSON.parse(text); } catch { continue; }   // ignore non-JSON events
      if (msg.id != null && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message || JSON.stringify(msg.error)));
        else res(msg.result);
      }
    }
  }

  sock.on('data', (chunk) => { backlog = Buffer.concat([backlog, chunk]); drain(); });
  sock.once('close', () => {
    closed = true;
    for (const { rej } of pending.values()) rej(new Error('cdp socket closed'));
    pending.clear();
  });

  const send = (method, params = {}) => new Promise((res, rej) => {
    if (closed) return rej(new Error('cdp session closed'));
    const msgId = ++id;
    pending.set(msgId, { res, rej });
    sock.write(frame(OP_TEXT, Buffer.from(JSON.stringify({ id: msgId, method, params }), 'utf8')));
    setTimeout(() => {
      if (pending.has(msgId)) { pending.delete(msgId); rej(new Error(`cdp timeout: ${method}`)); }
    }, 60_000);
  });

  return { send, close: () => { try { sock.end(); } catch {} } };
}

/** Poll the debugger's HTTP endpoint until a page target exists. */
export async function waitForPage(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* browser still booting */ }
    if (Date.now() > deadline) throw new Error(`no CDP page target on port ${port} after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Evaluate an expression in the page and return its value. */
export async function evaluate(session, expression) {
  const r = await session.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' — ' + expression);
  return r.result ? r.result.value : undefined;
}
