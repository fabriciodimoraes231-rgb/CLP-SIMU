// Testes do Modbus TCP: exemplos da especificação, exceções, enquadramento TCP e cliente.
import test from 'node:test';
import assert from 'node:assert/strict';
import { connect, createServer as createTcpServer } from 'node:net';
import {
  handlePdu, encodeAdu, extractFrames, createModbusServer, ModbusClient, ModbusError, ModbusResponseError,
  checkResponse, EX,
} from '../server/modbus.mjs';
import {
  packArea, unpackArea, bitIndex, keyFromIndex, modbusRef, sanitizeBytes, toRegister,
  wordsToRegisters, applyHoldingWrite, machineModbusMap, HOLDING_REGS,
} from '../src/engine/iomap.js';
import { tank } from '../src/machines/tank.js';

const hex = (s) => Buffer.from(s.replace(/\s+/g, ''), 'hex');
const toHex = (b) => Buffer.from(b).toString('hex').toUpperCase().replace(/(..)(?!$)/g, '$1 ');

function bigModel() {
  return {
    coils: new Uint8Array(65536),
    discreteInputs: new Uint8Array(65536),
    inputRegisters: new Uint16Array(65536),
    holdingRegisters: new Uint16Array(65536),
  };
}

function setBits(table, start, bytes, qty) {
  for (let i = 0; i < qty; i++) table[start + i] = (bytes[i >> 3] >> (i & 7)) & 1;
}

// Exemplos da "MODBUS Application Protocol Specification V1.1b3", seção 6.
test('Modbus: exemplos de leitura da especificação (FC 1, 2, 3, 4)', () => {
  const m = bigModel();
  setBits(m.coils, 0x13, [0xcd, 0x6b, 0x05], 19);
  assert.equal(toHex(handlePdu(hex('01 0013 0013'), m)), '01 03 CD 6B 05');

  setBits(m.discreteInputs, 0xc4, [0xac, 0xdb, 0x35], 22);
  assert.equal(toHex(handlePdu(hex('02 00C4 0016'), m)), '02 03 AC DB 35');

  m.holdingRegisters.set([0x022b, 0x0000, 0x0064], 0x6b);
  assert.equal(toHex(handlePdu(hex('03 006B 0003'), m)), '03 06 02 2B 00 00 00 64');

  m.inputRegisters[0x08] = 0x000a;
  assert.equal(toHex(handlePdu(hex('04 0008 0001'), m)), '04 02 00 0A');
});

test('Modbus: exemplos de escrita da especificação (FC 5, 6, 15, 16)', () => {
  const m = bigModel();
  const writes = [];
  m.onWrite = (table, start, qty) => writes.push([table, start, qty]);

  assert.equal(toHex(handlePdu(hex('05 00AC FF00'), m)), '05 00 AC FF 00');
  assert.equal(m.coils[0xac], 1);
  assert.equal(toHex(handlePdu(hex('05 00AC 0000'), m)), '05 00 AC 00 00');
  assert.equal(m.coils[0xac], 0);

  assert.equal(toHex(handlePdu(hex('06 0001 0003'), m)), '06 00 01 00 03');
  assert.equal(m.holdingRegisters[1], 3);

  assert.equal(toHex(handlePdu(hex('0F 0013 000A 02 CD 01'), m)), '0F 00 13 00 0A');
  assert.deepEqual([...m.coils.subarray(0x13, 0x13 + 10)], [1, 0, 1, 1, 0, 0, 1, 1, 1, 0]);

  assert.equal(toHex(handlePdu(hex('10 0001 0002 04 000A 0102'), m)), '10 00 01 00 02');
  assert.deepEqual([...m.holdingRegisters.subarray(1, 3)], [0x000a, 0x0102]);

  assert.deepEqual(writes.map((w) => w[0]), ['coils', 'coils', 'holdingRegisters', 'coils', 'holdingRegisters']);
});

test('Modbus: respostas de exceção', () => {
  const m = bigModel();
  assert.equal(toHex(handlePdu(hex('2B 0E 01 00'), m)), 'AB 01', 'função não suportada');
  assert.equal(toHex(handlePdu(hex('01 0000 0000'), m)), '81 03', 'quantidade zero');
  assert.equal(toHex(handlePdu(hex('01 0000 07D1'), m)), '81 03', 'mais de 2000 bits');
  assert.equal(toHex(handlePdu(hex('03 0000 007E'), m)), '83 03', 'mais de 125 registradores');
  assert.equal(toHex(handlePdu(hex('01 FFFF 0002'), m)), '81 02', 'passa do fim da tabela');
  assert.equal(toHex(handlePdu(hex('05 0001 1234'), m)), '85 03', 'valor de coil inválido');
  assert.equal(toHex(handlePdu(hex('0F 0000 000A 01 FF'), m)), '8F 03', 'contagem de bytes errada');
  assert.equal(toHex(handlePdu(hex('01 0000'), m)), '81 03', 'PDU curta');

  const small = { coils: new Uint8Array(128), discreteInputs: new Uint8Array(128), inputRegisters: new Uint16Array(16), holdingRegisters: new Uint16Array(0) };
  assert.equal(toHex(handlePdu(hex('02 0000 0080'), small)), '02 10 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00');
  assert.equal(toHex(handlePdu(hex('02 0000 0081'), small)), '82 02', '128 entradas no mapa');
  assert.equal(toHex(handlePdu(hex('03 0000 0001'), small)), '83 02', 'sem registradores holding');

  small.isAvailable = () => false;
  assert.equal(toHex(handlePdu(hex('02 0000 0008'), small)), '82 0B', 'planta desconectada');
  assert.equal(toHex(handlePdu(hex('05 0000 FF00'), small)), '85 0B');
  assert.equal(small.coils[0], 0, 'nada é escrito sem planta');
  assert.equal(toHex(handlePdu(hex('2B 0E 01 00'), small)), 'AB 01', 'função inválida tem prioridade');
});

test('Modbus TCP: enquadramento com quadros parciais, vários juntos e cabeçalho inválido', () => {
  const a = encodeAdu(1, 1, hex('01 0000 0008'));
  const b = encodeAdu(2, 9, hex('02 0000 0008'));
  const both = Buffer.concat([a, b]);

  let r = extractFrames(both.subarray(0, 14)); // ADU "a" (12 bytes) + 2 bytes de "b"
  assert.equal(r.frames.length, 1);
  assert.equal(r.rest.length, 2);
  r = extractFrames(both);
  assert.deepEqual(r.frames.map((f) => [f.transactionId, f.unitId, toHex(f.pdu)]), [[1, 1, '01 00 00 00 08'], [2, 9, '02 00 00 00 08']]);
  assert.equal(r.rest.length, 0);

  r = extractFrames(both.subarray(0, 5));
  assert.equal(r.frames.length, 0);
  assert.equal(r.rest.length, 5);

  const bad = Buffer.from(a);
  bad.writeUInt16BE(1, 2); // protocol id ≠ 0
  assert.equal(extractFrames(bad).error, true);
});

test('Modbus TCP: servidor real com cliente, pipeline e bytes picados', async (t) => {
  const model = { coils: new Uint8Array(128), discreteInputs: new Uint8Array(128), inputRegisters: new Uint16Array(16), holdingRegisters: new Uint16Array(0) };
  model.discreteInputs[3] = 1;
  model.inputRegisters[1] = 655;
  const events = [];
  const srv = createModbusServer(model, { hooks: { onConnect: () => events.push('in'), onDisconnect: () => events.push('out') } });
  await new Promise((ok) => srv.server.listen(0, '127.0.0.1', ok));
  const { port } = srv.server.address();
  t.after(() => srv.close());

  const client = await ModbusClient.connect({ port });
  assert.deepEqual((await client.readDiscreteInputs(0, 8)).map(Number), [0, 0, 0, 1, 0, 0, 0, 0]);
  assert.deepEqual(await client.readInputRegisters(0, 2), [0, 655]);
  await client.writeCoils(0, [true, false, true]);
  await client.writeCoil(9, true);
  assert.deepEqual((await client.readCoils(0, 10)).map(Number), [1, 0, 1, 0, 0, 0, 0, 0, 0, 1]);
  await assert.rejects(client.readHoldingRegisters(0, 1), (e) => e instanceof ModbusError && e.code === EX.ILLEGAL_ADDRESS);
  await assert.rejects(client.readCoils(120, 9), (e) => e.code === EX.ILLEGAL_ADDRESS);
  client.close();

  // Cliente "cru": duas requisições no mesmo pacote e uma terceira enviada byte a byte.
  const raw = connect({ port, host: '127.0.0.1' });
  await new Promise((ok) => raw.once('connect', ok));
  const chunks = [];
  raw.on('data', (d) => chunks.push(d));
  raw.write(Buffer.concat([encodeAdu(7, 1, hex('01 0000 0003')), encodeAdu(8, 1, hex('02 0003 0001'))]));
  const third = encodeAdu(9, 1, hex('04 0001 0001'));
  for (const byte of third) raw.write(Buffer.from([byte]));
  await new Promise((ok) => setTimeout(ok, 100));
  const frames = extractFrames(Buffer.concat(chunks)).frames;
  assert.deepEqual(frames.map((f) => [f.transactionId, toHex(f.pdu)]), [
    [7, '01 01 05'], [8, '02 01 01'], [9, '04 02 02 8F'],
  ]);

  // Cabeçalho inválido derruba a conexão.
  const closed = new Promise((ok) => raw.once('close', ok));
  raw.write(hex('0001 0005 0006 01 01000000 08'));
  await closed;
  await new Promise((ok) => setTimeout(ok, 20));
  assert.deepEqual(events.sort(), ['in', 'in', 'out', 'out'], 'duas conexões abertas e fechadas');
});

test('mapa de E/S: empacotamento I/Q e referências Modbus', () => {
  assert.equal(bitIndex('I0.0'), 0);
  assert.equal(bitIndex('%Q1.1'), 9);
  assert.equal(bitIndex('I15.7'), 127);
  assert.equal(bitIndex('M0.0'), -1);
  assert.equal(keyFromIndex('Q', 9), 'Q1.1');

  const bytes = packArea({ 'I0.2': true, 'I1.0': true, 'I0.3': false, 'Q0.0': true }, 'I');
  assert.deepEqual(bytes.slice(0, 3), [0b100, 0b1, 0]);
  assert.equal(bytes.length, 16);
  assert.deepEqual(unpackArea(bytes, 'I'), { 'I0.2': true, 'I1.0': true });

  assert.equal(modbusRef('DI', 3), '10004');
  assert.equal(modbusRef('COIL', 0), '00001');
  assert.equal(modbusRef('IR', 1), '30002');

  assert.equal(sanitizeBytes([1, 2, 300]), null);
  assert.equal(sanitizeBytes('x'), null);
  assert.equal(sanitizeBytes(new Array(17).fill(0)), null);
  assert.deepEqual(sanitizeBytes([5]).slice(0, 2), [5, 0]);

  assert.equal(toRegister(45.26, 10), 453);
  assert.equal(toRegister(-3, 10), 0);
  assert.equal(toRegister(1e9), 65535);
  assert.equal(toRegister('abc'), 0);
});

test('mapa de E/S: memórias MW como registradores holding', () => {
  assert.equal(HOLDING_REGS, 64);
  assert.equal(modbusRef('HR', 0), '40001');
  assert.equal(modbusRef('HR', 63), '40064');

  const words = new Map([['MW0', 5], ['MW1', -1], ['MW63', -32768]]);
  const regs = wordsToRegisters(words);
  assert.equal(regs.length, 64);
  assert.deepEqual([regs[0], regs[1], regs[2], regs[63]], [5, 65535, 0, 32768], 'INT negativo em complemento de dois');

  assert.deepEqual(applyHoldingWrite(words, { start: 1, values: [850, 65535] }),
    [{ key: 'MW1', value: 850 }, { key: 'MW2', value: -1 }]);
  assert.equal(words.get('MW1'), 850);
  assert.equal(words.get('MW2'), -1);
  for (const bad of [null, { start: 63, values: [1, 2] }, { start: -1, values: [1] }, { start: 0, values: [] },
    { start: 0, values: [70000] }, { start: 0, values: [1.5] }, { start: '0', values: [1] }]) {
    assert.equal(applyHoldingWrite(words, bad), null, JSON.stringify(bad));
  }

  const rows = machineModbusMap(tank, [{ addr: 'MW2', symbol: 'SP_TEMP', desc: '' }]);
  const hr = rows.filter((r) => r.table === 'HR');
  assert.deepEqual(hr.map((r) => [r.index, r.ref, r.addr, r.symbol]), [[2, '40003', 'MW2', 'SP_TEMP']]);
});

test('Modbus: tabela de coils só leitura responde 0x01 às escritas e continua legível', () => {
  const m = { ...bigModel(), writable: (table) => table !== 'coils' };
  m.coils[3] = 1;
  assert.equal(toHex(handlePdu(hex('05 0003 FF00'), m)), '85 01');
  assert.equal(toHex(handlePdu(hex('0F 0000 0008 01 FF'), m)), '8F 01');
  assert.equal(toHex(handlePdu(hex('01 0000 0008'), m)), '01 01 08');
  assert.equal(m.coils[3], 1, 'nada foi escrito');
  assert.equal(toHex(handlePdu(hex('06 0001 0352'), m)), '06 00 01 03 52', 'registradores continuam graváveis');
  assert.equal(m.holdingRegisters[1], 850);
});

test('cliente Modbus: recusa resposta que não confere com o pedido (função, bytes, eco, unit id)', async (t) => {
  // "CLP" de teste: responde o que cada caso mandar, com o mesmo transaction id do pedido.
  let reply = null;
  const plc = createTcpServer((s) => {
    s.on('error', () => {});
    let pending = Buffer.alloc(0);
    s.on('data', (chunk) => {
      const { frames, rest } = extractFrames(Buffer.concat([pending, chunk]));
      pending = Buffer.from(rest);
      for (const f of frames) {
        const r = reply(f);
        s.write(encodeAdu(f.transactionId, r.unitId ?? f.unitId, r.pdu));
      }
    });
  });
  await new Promise((ok) => plc.listen(0, '127.0.0.1', ok));
  t.after(() => plc.close());
  const client = await ModbusClient.connect({ port: plc.address().port, unitId: 1 });
  t.after(() => client.close());
  const invalid = (re) => (e) => e instanceof ModbusResponseError && re.test(e.message);

  // 10 coils ocupam 2 bytes e o "CLP" manda 1: antes os bits que faltavam viravam 0 sem nenhum erro.
  reply = () => ({ pdu: hex('01 01 05') });
  await assert.rejects(client.readCoils(0, 10), invalid(/resposta com 1 byte de dados; o pedido exige 2 bytes/));
  reply = () => ({ pdu: hex('01 03 05 01') });
  await assert.rejects(client.readCoils(0, 10), invalid(/contagem de bytes 3 na resposta, esperada 2/));
  reply = () => ({ pdu: hex('02 02 05 01') });
  await assert.rejects(client.readCoils(0, 10), invalid(/função 2 na resposta, esperada 1/));
  reply = () => ({ pdu: hex('03 02 00') });
  await assert.rejects(client.readHoldingRegisters(0, 1), invalid(/o pedido exige 2 bytes/));
  reply = () => ({ pdu: hex('0F 0000 0005') });
  await assert.rejects(client.writeCoils(0, new Array(9).fill(true)), invalid(/confirmação da escrita/));
  reply = () => ({ pdu: hex('05 0003 0000') });
  await assert.rejects(client.writeCoil(3, true), invalid(/eco da escrita/));
  reply = () => ({ unitId: 7, pdu: hex('01 01 00') });
  await assert.rejects(client.readCoils(0, 8), invalid(/unit id 7 na resposta, esperado 1/));

  // Respostas corretas continuam aceitas, exceção continua sendo ModbusError e a conexão segue utilizável.
  reply = () => ({ pdu: hex('01 02 05 01') });
  assert.deepEqual((await client.readCoils(0, 10)).map(Number), [1, 0, 1, 0, 0, 0, 0, 0, 1, 0]);
  reply = (f) => ({ pdu: f.pdu });
  await client.writeCoil(3, true);
  reply = () => ({ pdu: hex('81 02') });
  await assert.rejects(client.readCoils(0, 10), (e) => e instanceof ModbusError && e.code === EX.ILLEGAL_ADDRESS);

  assert.equal(checkResponse(hex('10 0000 0002 04 0001 0002'), hex('10 0000 0002')), null);
  assert.equal(checkResponse(hex('04 0000 0002'), hex('04 04 0000 028F')), null);
  assert.match(checkResponse(hex('03 0000 0001'), hex('83 02 00')), /exceção com 3 bytes/);
});
