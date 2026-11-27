// Testes de integração com software externo: ponte da planta, WebSocket e
// "CLP externo" controlando a máquina simulada por Modbus TCP real (porta local).
import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { startServer } from '../server/app.mjs';
import { PlantBridge } from '../server/bridge.mjs';
import { ModbusClient, ModbusError, EX } from '../server/modbus.mjs';
import { ModbusPlc } from '../server/external-plc.mjs';
import { packArea, unpackArea, toRegister, wordsToRegisters, applyHoldingWrite } from '../src/engine/iomap.js';
import { PLC } from '../src/engine/plc.js';
import { conveyor } from '../src/machines/conveyor.js';
import { tank } from '../src/machines/tank.js';
import { mulberry32, analogInputs } from '../src/machines/common.js';

// realtime: false → a planta do servidor só anda com runner.step() (passo travado com o CLP externo).
const quiet = { log: () => {}, warn: () => {}, realtime: false };
const DT = 10;

function helloFor(machine, watchdogMs = 0) {
  return {
    type: 'hello',
    machine: { id: machine.id, name: machine.name },
    io: {
      inputs: machine.inputs, outputs: machine.outputs,
      analogs: (machine.analogs ?? []).map(({ read, ...a }) => a),
    },
    watchdogMs,
  };
}

/**
 * Página emulada no modo "CLP externo: o CLP se conecta ao simulador". A planta roda na ponte (PlantRunner);
 * nos testes ela anda passo a passo, em sincronia com o CLP externo.
 */
class PlantRig {
  constructor(bridge, machine) {
    this.bridge = bridge;
    this.messages = [];
    this.link = bridge.connectPlant({ send: (m) => this.messages.push(m) });
    this.link.receive(helloFor(machine));
    assert.ok(bridge.runner, 'planta criada no servidor');
  }

  get runner() { return this.bridge.runner; }
  get sim() { return this.runner.sim; }
  get outputs() { return this.runner.outputs; }

  /** Avança a física em passos de 10 ms; o CLP externo faz um ciclo a cada `every` passos. */
  async run(ext, seconds, every = 2) {
    const steps = Math.round((seconds * 1000) / DT);
    for (let i = 0; i < steps; i++) {
      this.runner.step();
      if (ext && i % every === 0) await ext.cycle(DT * every);
    }
  }

  async press(ext, addr, seconds = 0.3) {
    this.link.receive({ type: 'control', addr, on: true });
    await this.run(ext, seconds);
    this.link.receive({ type: 'control', addr, on: false });
  }
}

test('CLP externo via Modbus TCP opera a esteira: separa sem erro e para com 5 rejeitos', async (t) => {
  const srv = await startServer({ port: 0, modbusPort: 0, ...quiet, createRng: () => mulberry32(42) });
  t.after(() => srv.close());
  const rig = new PlantRig(srv.bridge, conveyor);
  const client = await ModbusClient.connect({ port: srv.modbusPort });
  t.after(() => client.close());
  const ext = new ModbusPlc({ client, program: conveyor.exampleProgram() });

  await rig.run(ext, 0.5);
  assert.equal(rig.outputs['Q0.3'], true, 'lâmpada vermelha com sistema parado');
  await rig.press(ext, 'I0.0');
  assert.equal(rig.outputs['Q0.0'], true, 'motor liga pelo CLP externo');
  await rig.run(ext, 120);

  const s = rig.sim.stats;
  assert.equal(s.rejectShort, 0, 'nenhuma baixa rejeitada');
  assert.equal(s.endTall, 0, 'nenhuma alta na saída');
  assert.equal(s.rejectTall, 5, 'para ao completar 5 rejeitos');
  assert.ok(s.endShort > 0, 'baixas chegam à saída');
  assert.equal(rig.outputs['Q0.0'], undefined, 'motor parado');
  assert.ok(srv.bridge.requests > 10000, 'tráfego Modbus real');
});

test('CLP externo lê os analógicos do tanque (registradores de entrada) e opera a batelada', async (t) => {
  const srv = await startServer({ port: 0, modbusPort: 0, ...quiet });
  t.after(() => srv.close());
  const rig = new PlantRig(srv.bridge, tank);
  const client = await ModbusClient.connect({ port: srv.modbusPort });
  t.after(() => client.close());
  const ext = new ModbusPlc({ client, program: tank.exampleProgram() });

  await rig.run(ext, 0.3);
  await rig.press(ext, 'I0.0');
  await rig.run(ext, 6);
  const [level, temp] = await client.readInputRegisters(0, 2);
  assert.equal(level, toRegister(rig.sim.level, 10), 'nível em 0,1 %');
  assert.equal(temp, toRegister(rig.sim.temp, 10), 'temperatura em 0,1 °C');
  assert.ok(level > 500 && level < 1000, `enchendo (${level})`);

  await rig.run(ext, 150);
  assert.equal(rig.sim.stats.good, 3);
  assert.equal(rig.sim.stats.bad, 0);
  assert.equal(rig.sim.stats.overflow, false);
});

test('CLP externo roda o exemplo analógico do tanque lendo IW pelos registradores de entrada', async (t) => {
  const srv = await startServer({ port: 0, modbusPort: 0, ...quiet });
  t.after(() => srv.close());
  const rig = new PlantRig(srv.bridge, tank);
  const client = await ModbusClient.connect({ port: srv.modbusPort });
  t.after(() => client.close());
  const ext = new ModbusPlc({ client, program: tank.examples.find((x) => x.id === 'analogico').program() });
  assert.equal(ext.readsAnalogs, true);
  assert.equal(new ModbusPlc({ client, program: tank.exampleProgram() }).readsAnalogs, false, 'sem IW, sem FC 4');

  await rig.run(ext, 0.3);
  await rig.press(ext, 'I0.0');
  await rig.run(ext, 150);
  assert.equal(rig.sim.stats.good, 3);
  assert.equal(rig.sim.stats.bad, 0);
  assert.equal(rig.sim.stats.overflow, false);
  assert.equal(ext.plc.readWord('MW0'), 3);
});

/**
 * Página no modo "CLP interno + servidor Modbus", emulada em Node: o ladder roda aqui (como na página)
 * e a ponte o expõe a um supervisório. Escritas nos registradores holding são aplicadas nas MW e confirmadas.
 */
class ServerRig {
  constructor(bridge, machine, program) {
    this.machine = machine;
    this.sim = machine.createSim({ rng: mulberry32(1) });
    this.plc = new PLC();
    assert.deepEqual(this.plc.load(program), []);
    this.outputs = {};
    this.active = new Set();
    this.applied = 0;
    this.writes = [];
    this.link = bridge.connectPlant({
      send: (m) => {
        if (m.type !== 'hr') return;
        this.writes.push(m);
        applyHoldingWrite(this.plc.words, m);
        this.applied = m.seq;
      },
    });
    this.link.receive({ ...helloFor(machine), role: 'clp' });
  }

  step() {
    this.sim.update(DT / 1000, this.outputs);
    const inputs = { ...this.sim.readInputs(), ...analogInputs(this.machine, this.sim) };
    for (const c of this.machine.controls) {
      const on = this.active.has(c.addr);
      inputs[c.addr] = c.contact === 'NO' ? on : !on;
    }
    this.outputs = this.plc.scan(inputs, DT);
    this.link.receive({
      type: 'inputs', i: packArea(inputs, 'I'), a: Object.values(analogInputs(this.machine, this.sim)),
      q: packArea(this.outputs, 'Q'), h: wordsToRegisters(this.plc.words), hs: this.applied,
    });
  }

  /** Avança em passos de 10 ms, deixando o supervisório falar a cada `every` passos. */
  async run(seconds, every = 50) {
    const steps = Math.round((seconds * 1000) / DT);
    for (let i = 0; i < steps; i++) {
      this.step();
      if (i % every === 0) await new Promise((ok) => setImmediate(ok));
    }
  }

  async press(addr, seconds = 0.3) {
    this.active.add(addr);
    await this.run(seconds);
    this.active.delete(addr);
  }
}

test('ponte no papel CLP: holding = MW, coils só leitura e escrita confirmada pela página', async (t) => {
  const srv = await startServer({ port: 0, modbusPort: 0, ...quiet });
  t.after(() => srv.close());
  const client = await ModbusClient.connect({ port: srv.modbusPort });
  t.after(() => client.close());

  await assert.rejects(client.readHoldingRegisters(0, 2), (e) => e.code === EX.GATEWAY_TARGET_FAILED, 'sem página');

  const sent = [];
  const page = srv.bridge.connectPlant({ send: (m) => sent.push(m) });
  page.receive({ ...helloFor(tank), role: 'clp', io: { ...helloFor(tank).io, words: [{ addr: 'mw1', symbol: 'SP_NIVEL' }, { addr: 'M0.0' }] } });
  const h = new Array(64).fill(0);
  h[1] = 880;
  page.receive({ type: 'inputs', i: packArea({ 'I0.1': true }, 'I'), a: [123, 220], q: packArea({ 'Q0.4': true }, 'Q'), h, hs: 0 });

  assert.deepEqual(await client.readHoldingRegisters(0, 3), [0, 880, 0]);
  assert.equal((await client.readCoils(0, 8))[4], true, 'saídas do ladder nas coils');
  assert.equal((await client.readDiscreteInputs(0, 8))[1], true);
  assert.deepEqual(await client.readInputRegisters(0, 2), [123, 220]);
  await assert.rejects(client.writeCoil(0, true), (e) => e.code === EX.ILLEGAL_FUNCTION, 'coils só leitura');
  await assert.rejects(client.writeRegister(64, 1), (e) => e.code === EX.ILLEGAL_ADDRESS, 'só MW0–MW63');
  assert.equal(sent.some((m) => m.type === 'coils'), false, 'a ponte não manda coils para o CLP');

  await client.writeRegisters(1, [850, 0xffff]);
  const w = sent.filter((m) => m.type === 'hr');
  assert.deepEqual(w, [{ type: 'hr', seq: 1, start: 1, values: [850, 65535] }]);

  // A página ainda não aplicou (hs = 0): valores antigos publicados por ela são ignorados.
  page.receive({ type: 'inputs', i: [], a: [], h, hs: 0 });
  assert.deepEqual(await client.readHoldingRegisters(1, 2), [850, 65535], 'leitura logo após a escrita');
  // Página confirma; o ladder corrigiu o valor para o limite (820).
  h[1] = 820;
  h[2] = 65535;
  page.receive({ type: 'inputs', i: [], a: [], h, hs: 1 });
  assert.deepEqual(await client.readHoldingRegisters(1, 2), [820, 65535]);

  const snap = srv.bridge.snapshot();
  assert.equal(snap.role, 'clp');
  assert.deepEqual(snap.io.words, [{ addr: 'MW1', symbol: 'SP_NIVEL', desc: '' }], 'só MW, normalizadas');

  // A mesma conexão volta a ser planta: holding some, coils voltam a ser graváveis.
  page.receive(helloFor(tank));
  await assert.rejects(client.readHoldingRegisters(0, 1), (e) => e.code === EX.ILLEGAL_ADDRESS);
  await client.writeCoil(0, true);
  assert.equal(srv.bridge.runner.outputs['Q0.0'], true, 'coil move a planta do servidor');
});

test('supervisório ajusta os setpoints do CLP interno pelo Modbus (exemplo analógico do tanque)', async (t) => {
  const srv = await startServer({ port: 0, modbusPort: 0, ...quiet });
  t.after(() => srv.close());
  const scada = await ModbusClient.connect({ port: srv.modbusPort });
  t.after(() => scada.close());
  const rig = new ServerRig(srv.bridge, tank, tank.examples.find((x) => x.id === 'analogico').program());

  await rig.run(0.2);
  assert.deepEqual(await scada.readHoldingRegisters(1, 3), [880, 650, 3], 'valores da inicialização');

  // Nível acima do limite, temperatura 70,0 °C e meta de 2 lotes.
  await scada.writeRegisters(1, [990, 700, 2]);
  await rig.run(0.2);
  assert.deepEqual(await scada.readHoldingRegisters(1, 3), [920, 700, 2], 'o ladder corrige o nível para 92,0 %');
  assert.equal(rig.plc.read('M2.0'), true, 'a inicialização não roda de novo');

  await rig.press('I0.0');
  let maxLevel = 0;
  let maxTemp = 0;
  for (let s = 0; s < 120; s++) {
    await rig.run(1);
    maxLevel = Math.max(maxLevel, rig.sim.level);
    maxTemp = Math.max(maxTemp, rig.sim.temp);
  }
  assert.ok(maxLevel > 91.5 && maxLevel < 93, `encheu até o setpoint corrigido (${maxLevel.toFixed(1)} %)`);
  assert.ok(maxTemp > 69.9, `aqueceu até o novo setpoint, na resolução de 0,1 °C (${maxTemp.toFixed(1)} °C)`);
  assert.equal(rig.sim.stats.good, 2, 'parou na nova meta');
  assert.equal(rig.sim.stats.bad, 0);
  assert.equal(rig.plc.read('M0.0'), false);
  assert.deepEqual(await scada.readHoldingRegisters(0, 1), [2], 'LOTES lido pelo supervisório');
  assert.equal((await scada.readCoils(0, 8))[4], false, 'lâmpada de operação apagada');

  // Zerar LOTES pelo supervisório libera um novo ciclo.
  await scada.writeRegister(0, 0);
  await rig.run(0.2);
  assert.equal(rig.plc.readWord('MW0'), 0);
  assert.ok(rig.writes.length >= 2);
});

test('ponte: sem planta conectada o Modbus responde com a exceção 0x0B', async (t) => {
  const srv = await startServer({ port: 0, modbusPort: 0, ...quiet });
  t.after(() => srv.close());
  const client = await ModbusClient.connect({ port: srv.modbusPort });
  t.after(() => client.close());
  await assert.rejects(client.readDiscreteInputs(0, 8), (e) => e instanceof ModbusError && e.code === EX.GATEWAY_TARGET_FAILED);

  const rig = new PlantRig(srv.bridge, conveyor);
  const di = await client.readDiscreteInputs(0, 8);
  assert.equal(di[1], true, 'DESLIGA (NF) em repouso = 1');
  assert.equal(di[4], true, 'cilindro recuado');
  await client.writeCoil(0, true);
  assert.equal(rig.outputs['Q0.0'], true, 'coil chega à planta');

  rig.link.disconnect();
  await assert.rejects(client.readCoils(0, 8), (e) => e.code === EX.GATEWAY_TARGET_FAILED);
});

test('ponte: watchdog desliga as saídas sem comunicação e nova aba substitui a anterior', () => {
  let clock = 0;
  const logs = [];
  const bridge = new PlantBridge({ log: (m) => logs.push(m), now: () => clock, statusIntervalMs: 1e9, realtime: false });
  try {
    const first = [];
    let firstClosed = false;
    const a = bridge.connectPlant({ send: (m) => first.push(m), close: () => { firstClosed = true; } });
    a.receive(helloFor(conveyor, 1000));
    assert.equal(bridge.watchdogMs, 1000);

    bridge.model.onRequest();
    bridge.model.coils[0] = 1;
    bridge.model.onWrite('coils', 0, 1);
    assert.deepEqual(bridge.runner.outputs, { 'Q0.0': true }, 'coil escrita move a planta do servidor');
    bridge.runner.step();
    assert.equal(first.some((m) => m.type === 'plant'), true, 'a página recebe o estado da planta');

    clock = 900;
    bridge.tick();
    assert.equal(bridge.model.coils[0], 1, 'dentro do prazo');
    clock = 1100;
    bridge.tick();
    assert.equal(bridge.model.coils[0], 0, 'watchdog atuou');
    assert.equal(bridge.status().tripped, true);
    assert.deepEqual(bridge.runner.outputs, {}, 'a planta para');
    assert.ok(logs.some((l) => l.startsWith('Watchdog')));

    // No papel de planta as entradas vêm da máquina do servidor: mensagens da página são ignoradas.
    const before = [...bridge.model.discreteInputs.subarray(0, 16)];
    assert.equal(before[1], 1, 'DESLIGA (NF) em repouso');
    a.receive({ type: 'inputs', i: [0, 0], a: [5] });
    a.receive({ type: 'control', addr: 'I9.9', on: true });
    a.receive({ type: 'extra', index: 99 });
    assert.deepEqual([...bridge.model.discreteInputs.subarray(0, 16)], before);
    a.receive({ type: 'hello', machine: { id: 'x', name: 'Nome\u001b[31m com escape' }, io: { inputs: [{ addr: 'I0.0', symbol: 'B' }, { addr: 'X9' }] } });
    assert.ok(first.some((m) => m.type === 'notice' && /desconhecida/.test(m.text)), 'máquina desconhecida avisa a página');
    assert.equal(bridge.runner, null);
    assert.equal(bridge.snapshot().machine.name, 'Nome[31m com escape');
    assert.deepEqual(bridge.snapshot().io.inputs.map((x) => x.addr), ['I0.0']);
    assert.equal(bridge.watchdogMs, 0, 'hello sem watchdog desliga o watchdog');

    const second = [];
    bridge.connectPlant({ send: (m) => second.push(m) });
    assert.equal(first.at(-1).type, 'replaced');
    assert.equal(firstClosed, true);
    a.receive({ type: 'inputs', i: [255] });
    assert.equal(bridge.model.discreteInputs[0], 0, 'planta antiga não escreve mais');
  } finally {
    bridge.close();
  }
});

test('ponte: watchdog acompanha o CLP que escreve as coils; leituras de outro cliente não o seguram', async (t) => {
  const srv = await startServer({ port: 0, modbusPort: 0, ...quiet });
  t.after(() => srv.close());
  const page = srv.bridge.connectPlant({ send: () => {} });
  page.receive(helloFor(conveyor, 1000));
  const plc = await ModbusClient.connect({ port: srv.modbusPort });
  const monitor = await ModbusClient.connect({ port: srv.modbusPort });
  t.after(() => { plc.close(); monitor.close(); });
  const poll = async (read, ms) => {
    for (const end = Date.now() + ms; Date.now() < end;) {
      await read();
      await new Promise((ok) => setTimeout(ok, 100));
    }
  };

  // O CLP liga o motor e "trava"; um supervisório segue lendo as coils a cada 100 ms.
  await plc.writeCoils(0, [true]);
  assert.deepEqual(srv.bridge.runner.outputs, { 'Q0.0': true });
  await poll(() => monitor.readCoils(0, 4), 1600);
  assert.equal(srv.bridge.status().tripped, true, 'watchdog atuou mesmo com o supervisório conectado');
  assert.deepEqual(srv.bridge.runner.outputs, {}, 'motor desligado');

  // CLP que só escreve quando a saída muda, mas lê as entradas todo ciclo: as leituras dele seguram o watchdog.
  await plc.writeCoils(0, [true]);
  assert.equal(srv.bridge.status().tripped, false);
  await poll(() => plc.readDiscreteInputs(0, 9), 1600);
  assert.equal(srv.bridge.status().tripped, false, 'o próprio CLP continua comunicando');
  assert.deepEqual(srv.bridge.runner.outputs, { 'Q0.0': true });
});

// ---- WebSocket (cliente cru, para verificar o handshake e os quadros) ----

function wsFrame(text) {
  const payload = Buffer.from(text);
  const mask = randomBytes(4);
  const head = payload.length < 126
    ? Buffer.from([0x81, 0x80 | payload.length])
    : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
  const body = Buffer.from(payload.map((b, i) => b ^ mask[i & 3]));
  return Buffer.concat([head, mask, body]);
}

function parseFrames(buf) {
  const out = [];
  let off = 0;
  while (buf.length - off >= 2) {
    let len = buf[off + 1] & 0x7f;
    let h = 2;
    if (len === 126) { len = buf.readUInt16BE(off + 2); h = 4; }
    if (buf.length - off < h + len) break;
    out.push({ opcode: buf[off] & 0x0f, text: buf.subarray(off + h, off + h + len).toString() });
    off += h + len;
  }
  return out;
}

function wsOpen(port, { origin = `http://127.0.0.1:${port}`, host = `127.0.0.1:${port}` } = {}) {
  return new Promise((resolve, reject) => {
    const socket = connect({ port, host: '127.0.0.1' });
    let buf = Buffer.alloc(0);
    const conn = { socket, status: 0, headers: '', frames: [] };
    socket.on('error', reject);
    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!conn.status) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        conn.headers = buf.subarray(0, end).toString();
        conn.status = Number(conn.headers.split(' ')[1]);
        buf = buf.subarray(end + 4);
        resolve(conn);
      }
      conn.frames = parseFrames(buf);
    });
    socket.write([
      'GET /bridge HTTP/1.1', `Host: ${host}`, 'Upgrade: websocket', 'Connection: Upgrade',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13', `Origin: ${origin}`, '', '',
    ].join('\r\n'));
  });
}

const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));

test('WebSocket da ponte: handshake RFC 6455, mensagens e recusa de outras origens', async (t) => {
  const srv = await startServer({ port: 0, modbusPort: 0, ...quiet });
  t.after(() => srv.close());

  const evil = await wsOpen(srv.port, { origin: 'http://site-malicioso.example' });
  assert.equal(evil.status, 403, 'origem de outro site recusada');
  const rebinding = await wsOpen(srv.port, { host: `rebind.example:${srv.port}` });
  assert.equal(rebinding.status, 403, 'Host diferente recusado (DNS rebinding)');

  const ws = await wsOpen(srv.port);
  t.after(() => ws.socket.destroy());
  assert.equal(ws.status, 101);
  // Valor do exemplo da própria RFC 6455 (seção 1.3).
  assert.match(ws.headers, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/);

  ws.socket.write(wsFrame(JSON.stringify(helloFor(conveyor))));
  ws.socket.write(wsFrame(JSON.stringify({ type: 'control', addr: 'I0.0', on: true })));
  await wait(80);
  const api = await (await fetch(`http://127.0.0.1:${srv.port}/api/planta`)).json();
  assert.equal(api.connected, true);
  assert.equal(api.machine.id, 'esteira');
  assert.equal(api.modbus.port, srv.modbusPort);

  const client = await ModbusClient.connect({ port: srv.modbusPort });
  t.after(() => client.close());
  assert.equal((await client.readDiscreteInputs(0, 1))[0], true, 'botão LIGA apertado pela página (WebSocket)');
  await client.writeCoils(0, [false, true]);
  for (let i = 0; i < 4; i++) srv.bridge.runner.step();
  await wait(80);
  const msgs = ws.frames.filter((f) => f.opcode === 1).map((f) => JSON.parse(f.text));
  const plant = msgs.filter((m) => m.type === 'plant').at(-1);
  assert.deepEqual(unpackArea(plant.q, 'Q'), { 'Q0.1': true }, 'coil chega à página no estado da planta');
  assert.equal(plant.controls['I0.0'], true);
  assert.ok(plant.state.boxes, 'estado da esteira para desenhar');
  assert.ok(msgs.some((m) => m.type === 'status' && m.clients.length === 1));

  // Quadro sem máscara (proibido para clientes) encerra a conexão.
  const closed = new Promise((ok) => ws.socket.once('close', ok));
  ws.socket.write(Buffer.from([0x81, 0x02, 0x7b, 0x7d]));
  await closed;
  await wait(30);
  assert.equal(srv.bridge.snapshot().connected, false, 'planta desconectada');
});
