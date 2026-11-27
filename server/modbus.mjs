// Modbus TCP (servidor e cliente) sem dependências.
// Implementa as funções 1, 2, 3, 4, 5, 6, 15 e 16 da especificação
// "MODBUS Application Protocol Specification V1.1b3" e o cabeçalho MBAP de
// "MODBUS Messaging on TCP/IP Implementation Guide V1.0b".
//
// O modelo de dados é um objeto com tabelas tipadas:
//   { coils: Uint8Array, discreteInputs: Uint8Array,
//     inputRegisters: Uint16Array, holdingRegisters: Uint16Array,
//     isAvailable?(): boolean, writable?(table): boolean, onWrite?(table, start, qty, conn), onRequest?(conn) }
// writable('coils') = false responde às escritas de coils (FC 5, 15) com a exceção 0x01.
// conn identifica a conexão TCP que fez a requisição (o mesmo objeto enquanto ela estiver aberta).

import { createServer, connect } from 'node:net';

export const EX = {
  ILLEGAL_FUNCTION: 0x01,
  ILLEGAL_ADDRESS: 0x02,
  ILLEGAL_VALUE: 0x03,
  DEVICE_FAILURE: 0x04,
  GATEWAY_TARGET_FAILED: 0x0b,
};

export const EXCEPTION_TEXT = {
  [EX.ILLEGAL_FUNCTION]: 'função não suportada',
  [EX.ILLEGAL_ADDRESS]: 'endereço fora do mapa',
  [EX.ILLEGAL_VALUE]: 'quantidade ou valor inválido',
  [EX.DEVICE_FAILURE]: 'falha no dispositivo',
  [EX.GATEWAY_TARGET_FAILED]: 'simulador não conectado (abra a página e escolha um modo de Controle com Modbus)',
};

const MAX_ADU = 260;   // 7 (MBAP) + 253 (PDU)
const MAX_PDU = 253;

const exception = (fc, code) => Buffer.from([fc | 0x80, code]);

function readBits(fc, pdu, table, maxQty) {
  if (pdu.length !== 5) return exception(fc, EX.ILLEGAL_VALUE);
  const start = pdu.readUInt16BE(1);
  const qty = pdu.readUInt16BE(3);
  if (qty < 1 || qty > maxQty) return exception(fc, EX.ILLEGAL_VALUE);
  if (start + qty > table.length) return exception(fc, EX.ILLEGAL_ADDRESS);
  const n = Math.ceil(qty / 8);
  const out = Buffer.alloc(2 + n);
  out[0] = fc;
  out[1] = n;
  for (let i = 0; i < qty; i++) if (table[start + i]) out[2 + (i >> 3)] |= 1 << (i & 7);
  return out;
}

function readRegisters(fc, pdu, table) {
  if (pdu.length !== 5) return exception(fc, EX.ILLEGAL_VALUE);
  const start = pdu.readUInt16BE(1);
  const qty = pdu.readUInt16BE(3);
  if (qty < 1 || qty > 125) return exception(fc, EX.ILLEGAL_VALUE);
  if (start + qty > table.length) return exception(fc, EX.ILLEGAL_ADDRESS);
  const out = Buffer.alloc(2 + 2 * qty);
  out[0] = fc;
  out[1] = 2 * qty;
  for (let i = 0; i < qty; i++) out.writeUInt16BE(table[start + i], 2 + 2 * i);
  return out;
}

/**
 * Processa uma PDU de requisição e devolve a PDU de resposta (ou de exceção).
 * Ordem das verificações conforme a especificação: função → quantidade/valor → endereço → execução.
 * conn (opcional) é repassado a onRequest/onWrite para o modelo saber qual cliente fez a requisição.
 */
export function handlePdu(pdu, model, conn = null) {
  if (!pdu?.length) return exception(0, EX.ILLEGAL_FUNCTION);
  const fc = pdu[0];
  model.onRequest?.(conn);
  const available = () => model.isAvailable?.() ?? true;
  const unavailable = () => exception(fc, EX.GATEWAY_TARGET_FAILED);
  const readOnly = (table) => available() && model.writable?.(table) === false;

  switch (fc) {
    case 0x01: case 0x02: {
      const table = fc === 0x01 ? model.coils : model.discreteInputs;
      const res = readBits(fc, pdu, table, 2000);
      return res[0] === fc && !available() ? unavailable() : res;
    }
    case 0x03: case 0x04: {
      const table = fc === 0x03 ? model.holdingRegisters : model.inputRegisters;
      const res = readRegisters(fc, pdu, table);
      return res[0] === fc && !available() ? unavailable() : res;
    }
    case 0x05: {
      if (readOnly('coils')) return exception(fc, EX.ILLEGAL_FUNCTION);
      if (pdu.length !== 5) return exception(fc, EX.ILLEGAL_VALUE);
      const addr = pdu.readUInt16BE(1);
      const value = pdu.readUInt16BE(3);
      if (value !== 0xff00 && value !== 0x0000) return exception(fc, EX.ILLEGAL_VALUE);
      if (addr >= model.coils.length) return exception(fc, EX.ILLEGAL_ADDRESS);
      if (!available()) return unavailable();
      model.coils[addr] = value ? 1 : 0;
      model.onWrite?.('coils', addr, 1, conn);
      return Buffer.from(pdu);
    }
    case 0x06: {
      if (pdu.length !== 5) return exception(fc, EX.ILLEGAL_VALUE);
      const addr = pdu.readUInt16BE(1);
      if (addr >= model.holdingRegisters.length) return exception(fc, EX.ILLEGAL_ADDRESS);
      if (!available()) return unavailable();
      model.holdingRegisters[addr] = pdu.readUInt16BE(3);
      model.onWrite?.('holdingRegisters', addr, 1, conn);
      return Buffer.from(pdu);
    }
    case 0x0f: {
      if (readOnly('coils')) return exception(fc, EX.ILLEGAL_FUNCTION);
      if (pdu.length < 7) return exception(fc, EX.ILLEGAL_VALUE);
      const start = pdu.readUInt16BE(1);
      const qty = pdu.readUInt16BE(3);
      const count = pdu[5];
      if (qty < 1 || qty > 0x07b0 || count !== Math.ceil(qty / 8) || pdu.length !== 6 + count) {
        return exception(fc, EX.ILLEGAL_VALUE);
      }
      if (start + qty > model.coils.length) return exception(fc, EX.ILLEGAL_ADDRESS);
      if (!available()) return unavailable();
      for (let i = 0; i < qty; i++) model.coils[start + i] = (pdu[6 + (i >> 3)] >> (i & 7)) & 1;
      model.onWrite?.('coils', start, qty, conn);
      return pdu.subarray(0, 5);
    }
    case 0x10: {
      if (pdu.length < 8) return exception(fc, EX.ILLEGAL_VALUE);
      const start = pdu.readUInt16BE(1);
      const qty = pdu.readUInt16BE(3);
      const count = pdu[5];
      if (qty < 1 || qty > 0x7b || count !== 2 * qty || pdu.length !== 6 + count) {
        return exception(fc, EX.ILLEGAL_VALUE);
      }
      if (start + qty > model.holdingRegisters.length) return exception(fc, EX.ILLEGAL_ADDRESS);
      if (!available()) return unavailable();
      for (let i = 0; i < qty; i++) model.holdingRegisters[start + i] = pdu.readUInt16BE(6 + 2 * i);
      model.onWrite?.('holdingRegisters', start, qty, conn);
      return Buffer.from(pdu.subarray(0, 5));
    }
    default:
      return exception(fc, EX.ILLEGAL_FUNCTION);
  }
}

/** Monta um ADU (MBAP + PDU). */
export function encodeAdu(transactionId, unitId, pdu) {
  const adu = Buffer.alloc(7 + pdu.length);
  adu.writeUInt16BE(transactionId & 0xffff, 0);
  adu.writeUInt16BE(0, 2);
  adu.writeUInt16BE(pdu.length + 1, 4);
  adu[6] = unitId & 0xff;
  pdu.copy(adu, 7);
  return adu;
}

/**
 * Separa os ADUs completos de um buffer TCP (que pode trazer quadros parciais ou vários juntos).
 * Retorna { frames, rest, error }. error = true indica fluxo inválido (a conexão deve ser fechada).
 */
export function extractFrames(buffer) {
  const frames = [];
  let off = 0;
  while (buffer.length - off >= 7) {
    const protocol = buffer.readUInt16BE(off + 2);
    const length = buffer.readUInt16BE(off + 4);
    if (protocol !== 0 || length < 2 || length > MAX_PDU + 1) return { frames, rest: Buffer.alloc(0), error: true };
    if (buffer.length - off < 6 + length) break;
    frames.push({
      transactionId: buffer.readUInt16BE(off),
      unitId: buffer[off + 6],
      pdu: Buffer.from(buffer.subarray(off + 7, off + 6 + length)),
    });
    off += 6 + length;
  }
  return { frames, rest: buffer.subarray(off), error: false };
}

/**
 * Servidor Modbus TCP. Aceita qualquer unit id (responde com o mesmo).
 * hooks: onConnect(info), onDisconnect(info), onReject(info)
 */
/** Endereço IPv4 do cliente, sem o prefixo IPv6 de mapeamento (::ffff:192.168.1.10 → 192.168.1.10). */
export const clientIp = (addr) => String(addr ?? '').replace(/^::ffff:/i, '');

/**
 * Servidor Modbus TCP. allow(ip) = false recusa a conexão (lista de IPs permitidos): o protocolo não tem
 * autenticação, então quem alcança a porta pode ler e escrever.
 */
export function createModbusServer(model, { maxClients = 8, hooks = {}, allow = null } = {}) {
  const sockets = new Set();
  const server = createServer((socket) => {
    const info = { remote: `${clientIp(socket.remoteAddress)}:${socket.remotePort}`, requests: 0, connectedAt: Date.now() };
    if (allow && !allow(clientIp(socket.remoteAddress))) {
      hooks.onReject?.(info, 'IP fora da lista MODBUS_ALLOW');
      socket.destroy();
      return;
    }
    if (sockets.size >= maxClients) {
      hooks.onReject?.(info, 'limite de clientes');
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 10_000);
    hooks.onConnect?.(info);
    let buf = Buffer.alloc(0);

    socket.on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      const { frames, rest, error } = extractFrames(buf);
      for (const f of frames) {
        info.requests++;
        const res = handlePdu(f.pdu, model, info);
        if (!socket.destroyed) socket.write(encodeAdu(f.transactionId, f.unitId, res));
      }
      buf = Buffer.from(rest);
      if (error || buf.length > MAX_ADU * 4) socket.destroy();
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      sockets.delete(socket);
      hooks.onDisconnect?.(info);
    });
  });
  server.on('error', (err) => hooks.onError?.(err));
  const close = () => new Promise((resolve) => {
    for (const s of sockets) s.destroy();
    server.close(() => resolve());
  });
  return { server, sockets, close };
}

// ---------------------------------------------------------------------------
// Cliente
// ---------------------------------------------------------------------------

export class ModbusError extends Error {
  constructor(fc, code) {
    super(`Modbus: exceção ${code} na função ${fc} (${EXCEPTION_TEXT[code] ?? 'código desconhecido'})`);
    this.fc = fc;
    this.code = code;
  }
}

/** Resposta que não corresponde ao pedido (função, tamanho, eco ou unit id): o equipamento fugiu do protocolo. */
export class ModbusResponseError extends Error {
  constructor(detail) {
    super(`Resposta Modbus inválida: ${detail}`);
    this.detail = detail;
  }
}

/**
 * Confere a PDU de resposta contra a PDU do pedido. Retorna null se estiver correta ou o problema encontrado.
 * Exceção (função | 0x80) com 2 bytes é uma resposta válida: quem chama a transforma em ModbusError.
 */
export function checkResponse(req, res) {
  const fc = req[0];
  if (!res?.length || (res[0] & 0x7f) !== fc) {
    return `função ${res?.length ? res[0] & 0x7f : '—'} na resposta, esperada ${fc}`;
  }
  if (res[0] & 0x80) return res.length === 2 ? null : `exceção com ${res.length} bytes, esperados 2`;
  const qty = req.length >= 5 ? req.readUInt16BE(3) : 0;
  const bytes = (k) => `${k} ${k === 1 ? 'byte' : 'bytes'}`;
  const dataLength = (n) => {
    if (res.length !== 2 + n) return `resposta com ${bytes(Math.max(0, res.length - 2))} de dados; o pedido exige ${bytes(n)}`;
    return res[1] === n ? null : `contagem de bytes ${res[1]} na resposta, esperada ${n}`;
  };
  switch (fc) {
    case 0x01: case 0x02: return dataLength(Math.ceil(qty / 8));
    case 0x03: case 0x04: return dataLength(2 * qty);
    case 0x05: case 0x06: return res.equals(req) ? null : 'o eco da escrita não confere com o pedido';
    case 0x0f: case 0x10:
      return res.length === 5 && res.subarray(1, 5).equals(req.subarray(1, 5))
        ? null : 'a confirmação da escrita não confere com o endereço e a quantidade pedidos';
    default: return null;
  }
}

const bitsToBytes = (values) => {
  const bytes = Buffer.alloc(Math.ceil(values.length / 8));
  values.forEach((v, i) => { if (v) bytes[i >> 3] |= 1 << (i & 7); });
  return bytes;
};

export class ModbusClient {
  constructor(socket, { unitId = 1, timeoutMs = 2000 } = {}) {
    this.socket = socket;
    this.unitId = unitId;
    this.timeoutMs = timeoutMs;
    this.tid = 0;
    this.pending = new Map();
    this.buf = Buffer.alloc(0);
    this.closed = false;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', () => {});
    socket.on('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error('Conexão Modbus fechada.'));
      this.pending.clear();
    });
  }

  static connect({ host = '127.0.0.1', port = 5020, ...opts } = {}) {
    return new Promise((resolve, reject) => {
      const socket = connect({ host, port });
      const fail = (err) => { socket.destroy(); reject(err); };
      socket.once('error', fail);
      socket.setTimeout(opts.timeoutMs ?? 2000, () => fail(new Error(`Tempo esgotado ao conectar em ${host}:${port}`)));
      socket.once('connect', () => {
        socket.setTimeout(0);
        socket.off('error', fail);
        resolve(new ModbusClient(socket, opts));
      });
    });
  }

  onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const { frames, rest, error } = extractFrames(this.buf);
    this.buf = Buffer.from(rest);
    for (const f of frames) {
      const p = this.pending.get(f.transactionId);
      if (!p) continue;
      this.pending.delete(f.transactionId);
      clearTimeout(p.timer);
      // O servidor deve devolver o mesmo unit id do pedido (MODBUS Messaging on TCP/IP, cabeçalho MBAP).
      const problem = f.unitId !== (this.unitId & 0xff)
        ? `unit id ${f.unitId} na resposta, esperado ${this.unitId & 0xff} (confira o Unit ID configurado)`
        : checkResponse(p.req, f.pdu);
      if (problem) p.reject(new ModbusResponseError(problem));
      else if (f.pdu[0] & 0x80) p.reject(new ModbusError(f.pdu[0] & 0x7f, f.pdu[1]));
      else p.resolve(f.pdu);
    }
    if (error) this.socket.destroy();
  }

  request(pdu) {
    if (this.closed) return Promise.reject(new Error('Conexão Modbus fechada.'));
    this.tid = (this.tid + 1) & 0xffff;
    const tid = this.tid;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(tid);
        reject(new Error('Tempo esgotado aguardando resposta Modbus.'));
      }, this.timeoutMs);
      this.pending.set(tid, { resolve, reject, timer, req: pdu });
      this.socket.write(encodeAdu(tid, this.unitId, pdu));
    });
  }

  async readBitsFc(fc, start, qty) {
    const pdu = Buffer.alloc(5);
    pdu[0] = fc;
    pdu.writeUInt16BE(start, 1);
    pdu.writeUInt16BE(qty, 3);
    const res = await this.request(pdu);
    return Array.from({ length: qty }, (_, i) => !!((res[2 + (i >> 3)] >> (i & 7)) & 1));
  }

  async readRegsFc(fc, start, qty) {
    const pdu = Buffer.alloc(5);
    pdu[0] = fc;
    pdu.writeUInt16BE(start, 1);
    pdu.writeUInt16BE(qty, 3);
    const res = await this.request(pdu);
    return Array.from({ length: qty }, (_, i) => res.readUInt16BE(2 + 2 * i));
  }

  readCoils(start, qty) { return this.readBitsFc(0x01, start, qty); }
  readDiscreteInputs(start, qty) { return this.readBitsFc(0x02, start, qty); }
  readHoldingRegisters(start, qty) { return this.readRegsFc(0x03, start, qty); }
  readInputRegisters(start, qty) { return this.readRegsFc(0x04, start, qty); }

  async writeCoil(addr, on) {
    const pdu = Buffer.alloc(5);
    pdu[0] = 0x05;
    pdu.writeUInt16BE(addr, 1);
    pdu.writeUInt16BE(on ? 0xff00 : 0, 3);
    await this.request(pdu);
  }

  async writeCoils(start, values) {
    const bytes = bitsToBytes(values);
    const pdu = Buffer.alloc(6 + bytes.length);
    pdu[0] = 0x0f;
    pdu.writeUInt16BE(start, 1);
    pdu.writeUInt16BE(values.length, 3);
    pdu[5] = bytes.length;
    bytes.copy(pdu, 6);
    await this.request(pdu);
  }

  async writeRegister(addr, value) {
    const pdu = Buffer.alloc(5);
    pdu[0] = 0x06;
    pdu.writeUInt16BE(addr, 1);
    pdu.writeUInt16BE(value & 0xffff, 3);
    await this.request(pdu);
  }

  async writeRegisters(start, values) {
    const pdu = Buffer.alloc(6 + 2 * values.length);
    pdu[0] = 0x10;
    pdu.writeUInt16BE(start, 1);
    pdu.writeUInt16BE(values.length, 3);
    pdu[5] = 2 * values.length;
    values.forEach((v, i) => pdu.writeUInt16BE(v & 0xffff, 6 + 2 * i));
    await this.request(pdu);
  }

  close() {
    this.closed = true;
    this.socket.end();
    this.socket.destroy();
  }
}
