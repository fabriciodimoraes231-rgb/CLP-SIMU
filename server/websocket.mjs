// WebSocket mínimo (RFC 6455), só o necessário para a ponte navegador ↔ servidor:
// mensagens de texto curtas, sem fragmentação nem extensões. Sem dependências.

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 64 * 1024;

const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

export const acceptKey = (key) => createHash('sha1').update(key + GUID).digest('base64');

/** Cabeçalho + payload de um quadro do servidor (servidor nunca mascara). */
export function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

function reject(socket, status, text) {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/**
 * Conclui o handshake de um pedido 'upgrade'. Recusa origens e hosts fora da lista
 * (protege contra páginas de outros sites tentando falar com o servidor local).
 * Retorna uma WsConnection ou null.
 */
export function acceptWebSocket(req, socket, head, { origins, hosts }) {
  const key = req.headers['sec-websocket-key'];
  const upgrade = String(req.headers.upgrade ?? '').toLowerCase();
  if (req.method !== 'GET' || upgrade !== 'websocket' || !key || req.headers['sec-websocket-version'] !== '13') {
    reject(socket, 400, 'Bad Request');
    return null;
  }
  if (!origins.has(req.headers.origin) || !hosts.has(req.headers.host)) {
    reject(socket, 403, 'Forbidden');
    return null;
  }
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
    '', '',
  ].join('\r\n'));
  return new WsConnection(socket, head);
}

export class WsConnection extends EventEmitter {
  constructor(socket, head) {
    super();
    this.socket = socket;
    this.buf = head?.length ? Buffer.from(head) : Buffer.alloc(0);
    this.open = true;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => {
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
      this.parse();
    });
    socket.on('error', () => {});
    socket.on('close', () => this.markClosed());
    if (this.buf.length) queueMicrotask(() => this.parse());
  }

  parse() {
    while (this.open && this.buf.length >= 2) {
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      if (b0 & 0x70) return this.fail(1002);        // RSV sem extensão negociada
      if (!(b1 & 0x80)) return this.fail(1002);     // cliente deve mascarar
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_PAYLOAD)) return this.fail(1009);
        len = Number(big);
        off = 10;
      }
      if (len > MAX_PAYLOAD) return this.fail(1009);
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      const payload = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);

      switch (opcode) {
        case OP.TEXT:
          if (!fin) return this.fail(1003);         // fragmentação não suportada
          this.emit('message', payload.toString('utf8'));
          break;
        case OP.PING:
          this.socket.write(encodeFrame(OP.PONG, payload));
          break;
        case OP.PONG:
          break;
        case OP.CLOSE:
          this.close(1000);
          return undefined;
        default:                                    // binário e continuação: não usados
          return this.fail(1003);
      }
    }
    return undefined;
  }

  send(text) {
    if (!this.open) return;
    this.socket.write(encodeFrame(OP.TEXT, Buffer.from(String(text), 'utf8')));
  }

  close(code = 1000) {
    if (!this.open) return;
    this.open = false;
    const body = Buffer.alloc(2);
    body.writeUInt16BE(code, 0);
    this.socket.end(encodeFrame(OP.CLOSE, body));
    this.markClosed();
  }

  markClosed() {
    if (this.closedEmitted) return;
    this.closedEmitted = true;
    this.open = false;
    this.emit('close');
  }

  fail(code) {
    this.close(code);
  }
}
