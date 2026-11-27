// Testes do teste com CLP real: planta rodando no servidor, modo "o simulador se conecta ao CLP" (cliente
// Modbus) contra um CLP escravo de ensaio por TCP de verdade, e lista de IPs permitidos no servidor Modbus.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PlantRunner, simState, MIN_PRESS_MS } from '../server/plant-runner.mjs';
import {
  ModbusPoller, validateClientConfig, isPrivateIPv4, packWords, unpackWords, machinePoints, describeError,
} from '../server/modbus-poller.mjs';
import { SlavePlc } from '../server/plc-escravo.mjs';
import { createServer as createTcpServer } from 'node:net';
import {
  createModbusServer, ModbusClient, ModbusError, EX, extractFrames, encodeAdu,
} from '../server/modbus.mjs';
import { startServer } from '../server/app.mjs';
import { conveyor } from '../src/machines/conveyor.js';
import { tank } from '../src/machines/tank.js';
import { mulberry32 } from '../src/machines/common.js';

const quiet = { log: () => {}, warn: () => {} };
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
const listen = (server) => new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server.address().port)));

test('planta no servidor: passo de 10 ms, pulso mínimo dos botões, extras e estado sem funções', () => {
  const r = new PlantRunner(conveyor, { realtime: false, rng: mulberry32(1) });
  assert.equal(r.inputs['I0.1'], true, 'DESLIGA (NF) em repouso vale 1');
  assert.equal(r.inputs['I0.4'], true, 'cilindro recuado');

  r.setControl('I0.0', true);
  assert.equal(r.inputs['I0.0'], true, 'botão aparece na hora');
  r.step();
  r.setControl('I0.0', false); // toque rápido
  assert.equal(r.inputs['I0.0'], true, 'segura até o pulso mínimo');
  for (let i = 0; i < MIN_PRESS_MS / 10 - 2; i++) r.step();
  assert.equal(r.inputs['I0.0'], true);
  r.step();
  assert.equal(r.inputs['I0.0'], false, `solta depois de ${MIN_PRESS_MS} ms`);
  assert.equal(r.setControl('I9.9', true), false, 'botão inexistente');

  r.outputs = { 'Q0.1': true };
  for (let i = 0; i < 60; i++) r.step();
  assert.equal(r.inputs['I0.5'], true, 'cilindro avança com o solenoide');
  assert.equal(r.simMs, 600 + MIN_PRESS_MS - 10 + 10);

  assert.equal(r.extra(2, false), null);
  assert.equal(r.sim.autoFeed, false, 'opção "Alimentação automática"');
  r.reset(); // tira a peça que a alimentação automática já tinha colocado
  assert.equal(r.extra(0), null, 'peça baixa entra');
  assert.match(r.extra(0), /ocupada/, 'entrada ocupada');
  const snap = r.snapshot();
  assert.equal(JSON.stringify(snap).includes('function'), false);
  assert.equal(snap.state.rng, undefined, 'gerador aleatório não vai para a página');
  assert.deepEqual(snap.extras, [null, null, false]);
  assert.deepEqual(simState({ a: 1, f: () => 1, n: { g: () => 2, b: [1] } }), { a: 1, n: { b: [1] } });

  const t = new PlantRunner(tank, { realtime: false });
  assert.deepEqual(t.analogs, [0, 220], 'nível 0 % e 22,0 °C nos registradores');
});

test('planta no servidor anda em tempo real sozinha (sem depender do navegador)', async () => {
  const r = new PlantRunner(conveyor, { rng: mulberry32(1) });
  try {
    await wait(300);
    assert.ok(r.simMs >= 200 && r.simMs <= 400, `~300 ms simulados (${r.simMs})`);
  } finally {
    r.stop();
  }
});

test('configuração do modo cliente: IP privado, portas, áreas e limites', () => {
  for (const ip of ['192.168.1.10', '10.0.0.5', '172.16.0.1', '172.31.255.254', '169.254.10.20', '127.0.0.1']) assert.ok(isPrivateIPv4(ip), ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '192.169.0.1', '256.1.1.1', 'clp.local', '', '192.168.1']) assert.equal(isPrivateIPv4(ip), false, ip);

  const ok = { host: '192.168.1.10', port: 502, unitId: 1, periodMs: 50, inputs: { table: 'coils', start: 2148 }, outputs: { table: 'coils', start: 1280 }, analogs: null };
  assert.deepEqual(validateClientConfig(ok, conveyor).config, ok);
  const bad = (patch) => validateClientConfig({ ...ok, ...patch }, conveyor).error;
  assert.match(bad({ host: '8.8.8.8' }), /rede privada/);
  assert.match(bad({ port: 0 }), /Porta/);
  assert.match(bad({ unitId: 300 }), /Unit ID/);
  assert.match(bad({ periodMs: 5 }), /Período/);
  assert.match(bad({ inputs: { table: 'discrete', start: 0 } }), /Entradas: tipo/);
  assert.match(bad({ outputs: { table: 'coils', start: 65534 } }), /passa do endereço/);
  assert.match(bad({ analogs: { start: -1 } }), /Analógicos/);
  assert.deepEqual(machinePoints(conveyor), { inputs: 9, outputs: 4, analogs: 0 });
  assert.deepEqual(machinePoints(tank), { inputs: 6, outputs: 5, analogs: 2 });

  const bits = [true, false, true, ...new Array(14).fill(false), true];
  assert.deepEqual(packWords(bits), [0b101, 0b10]);
  assert.deepEqual(unpackWords([0b101, 0b10], 18), bits);

  assert.match(describeError(new ModbusError(15, EX.ILLEGAL_ADDRESS), ok), /endereço fora do mapa/);
  assert.match(describeError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }), ok), /recusou a conexão/);
  assert.match(describeError(new Error('Tempo esgotado aguardando resposta Modbus.'), ok), /Sem resposta/);
});

/**
 * Simulador (cliente) ↔ CLP escravo (servidor Modbus TCP real em 127.0.0.1), em passo travado:
 * a cada 2 passos da planta, uma troca do simulador e uma varredura do CLP.
 */
async function rig(t, machine, program, areas, seed = 1) {
  const slave = new SlavePlc({ program, machine, ...areas });
  const srv = createModbusServer(slave.model);
  const port = await listen(srv.server);
  t.after(() => srv.close());
  const runner = new PlantRunner(machine, { realtime: false, rng: mulberry32(seed) });
  const { config, error } = validateClientConfig({ host: '127.0.0.1', port, unitId: 1, periodMs: 20, analogs: null, ...areas }, machine);
  assert.equal(error, undefined);
  const poller = new ModbusPoller(config, runner);
  poller.client = await ModbusClient.connect({ port, unitId: 1 });
  t.after(() => poller.client?.close());
  const run = async (seconds) => {
    for (let i = 0; i < seconds * 100; i++) {
      runner.step();
      if (i % 2 === 0) {
        await poller.cycle();
        slave.scan(20);
      }
    }
  };
  const press = async (addr) => {
    runner.setControl(addr, true);
    await run(0.3);
    runner.setControl(addr, false);
  };
  return { slave, runner, poller, run, press };
}

test('simulador como cliente Modbus opera a esteira num CLP escravo (endereços estilo Delta: M100 e Y0)', async (t) => {
  const r = await rig(t, conveyor, conveyor.exampleProgram(), {
    inputs: { table: 'coils', start: 2048 + 100 }, outputs: { table: 'coils', start: 1280 },
  }, 42);
  await r.run(0.5);
  assert.equal(r.runner.outputs['Q0.3'], true, 'lâmpada vermelha com sistema parado (lida do CLP)');
  assert.equal(r.slave.model.coils[2048 + 101], 1, 'DESLIGA (NF) chegou ao CLP em M101');
  await r.press('I0.0');
  assert.equal(r.runner.outputs['Q0.0'], true, 'motor ligado pelo programa do CLP');
  await r.run(120);
  const s = r.runner.sim.stats;
  assert.equal(s.rejectShort, 0, 'nenhuma baixa rejeitada');
  assert.equal(s.endTall, 0, 'nenhuma alta na saída');
  assert.equal(s.rejectTall, 5, 'para com 5 rejeitos');
  assert.ok(s.endShort > 0);
  assert.equal(r.runner.outputs['Q0.0'], undefined, 'motor parado');

  // Ao parar, o simulador zera as entradas no CLP.
  await r.poller.stop();
  assert.deepEqual(r.slave.inputBits(), new Array(9).fill(false));
});

test('simulador como cliente: tanque analógico com entradas e saídas em holding (16 bits) e analógicos', async (t) => {
  const r = await rig(t, tank, tank.examples.find((x) => x.id === 'analogico').program(), {
    inputs: { table: 'holding', start: 10 }, outputs: { table: 'holding', start: 20 }, analogs: { start: 30 },
  });
  await r.run(0.3);
  assert.equal(r.slave.model.holdingRegisters[31], 220, 'temperatura escrita no registrador 31');
  assert.equal(r.slave.model.holdingRegisters[10] & 0b10, 0b10, 'DESLIGA (NF) = bit 1 do registrador 10');
  await r.press('I0.0');
  await r.run(150);
  assert.equal(r.runner.sim.stats.good, 3);
  assert.equal(r.runner.sim.stats.bad, 0);
  assert.equal(r.runner.sim.stats.overflow, false);
});

test('modo cliente pela ponte, em tempo real: conecta, opera, recusa mestre local e atua o watchdog', async (t) => {
  const slave = new SlavePlc({
    program: conveyor.exampleProgram(), machine: conveyor,
    inputs: { table: 'coils', start: 0 }, outputs: { table: 'coils', start: 100 },
  });
  const slaveSrv = createModbusServer(slave.model);
  const slavePort = await listen(slaveSrv.server);
  const scanner = setInterval(() => slave.scan(10), 10);
  t.after(() => clearInterval(scanner));

  const srv = await startServer({ port: 0, modbusPort: 0, ...quiet });
  t.after(() => srv.close());
  const sent = [];
  const page = srv.bridge.connectPlant({ send: (m) => sent.push(m) });
  page.receive({
    type: 'hello', role: 'planta', mode: 'cliente', machine: { id: 'esteira', name: 'Esteira' },
    client: { host: '127.0.0.1', port: slavePort, unitId: 1, periodMs: 20, inputs: { table: 'coils', start: 0 }, outputs: { table: 'coils', start: 100 }, analogs: null },
  });
  await wait(400);
  assert.equal(srv.bridge.poller.state, 'ok', srv.bridge.poller.message);
  page.receive({ type: 'control', addr: 'I0.0', on: true });
  await wait(100);
  page.receive({ type: 'control', addr: 'I0.0', on: false });
  await wait(500);
  assert.equal(srv.bridge.runner.outputs['Q0.0'], true, 'motor ligado pelo CLP');
  assert.ok(sent.some((m) => m.type === 'plant' && m.q[0] & 1), 'a página vê o motor ligado');
  assert.ok(srv.bridge.status().poller.cycles > 10);

  // Um segundo mestre (cliente no servidor Modbus local) é recusado: a planta já tem dono.
  const local = await ModbusClient.connect({ port: srv.modbusPort });
  t.after(() => local.close());
  await assert.rejects(local.readCoils(0, 4), (e) => e.code === EX.GATEWAY_TARGET_FAILED);

  // CLP fora do ar: em ~1 s a máquina para (watchdog conferido a cada 100 ms).
  await slaveSrv.close();
  await wait(1300);
  assert.equal(srv.bridge.status().poller.tripped, true);
  assert.deepEqual(srv.bridge.runner.outputs, {});
  assert.notEqual(srv.bridge.poller.state, 'ok');

  // Configuração inválida vinda da página é recusada com mensagem.
  page.receive({ type: 'config', client: { host: '8.8.8.8', port: 502, unitId: 1, periodMs: 50, inputs: { table: 'coils', start: 0 }, outputs: { table: 'coils', start: 0 } } });
  assert.match(srv.bridge.status().clientError, /rede privada/);
  assert.equal(srv.bridge.poller, null);
});

test('servidor Modbus: lista de IPs permitidos recusa quem não está nela', async (t) => {
  const model = { coils: new Uint8Array(8), discreteInputs: new Uint8Array(8), inputRegisters: new Uint16Array(1), holdingRegisters: new Uint16Array(1) };
  const rejected = [];
  const deny = createModbusServer(model, { allow: (ip) => ip === '192.168.1.10', hooks: { onReject: (i, reason) => rejected.push(reason) } });
  const portDeny = await listen(deny.server);
  t.after(() => deny.close());
  const c = await ModbusClient.connect({ port: portDeny, timeoutMs: 500 });
  await assert.rejects(c.readCoils(0, 1));
  c.close();
  await wait(20);
  assert.match(rejected[0], /MODBUS_ALLOW/);

  const allowSrv = createModbusServer(model, { allow: (ip) => ip === '127.0.0.1' });
  const portAllow = await listen(allowSrv.server);
  t.after(() => allowSrv.close());
  const ok = await ModbusClient.connect({ port: portAllow });
  t.after(() => ok.close());
  assert.deepEqual(await ok.readCoils(0, 2), [false, false], 'IP da lista é atendido');
});

const clientConfig = (port) => validateClientConfig({
  host: '127.0.0.1', port, unitId: 1, periodMs: 20,
  inputs: { table: 'coils', start: 0 }, outputs: { table: 'coils', start: 100 }, analogs: null,
}, conveyor).config;

test('modo cliente: parar enquanto a conexão abre fecha essa conexão (não ocupa vaga no CLP)', async () => {
  const runner = new PlantRunner(conveyor, { realtime: false });
  let closes = 0;
  const conn = { closed: false, close() { closes++; this.closed = true; } };
  // Conexão que leva 100 ms para abrir (CLP lento para aceitar).
  const connect = () => new Promise((ok) => { setTimeout(() => ok(conn), 100); });
  const poller = new ModbusPoller(clientConfig(502), runner, { connect });
  poller.start();
  await wait(20);
  assert.equal(poller.state, 'conectando');
  await poller.stop(); // ex.: "Aplicar e conectar" de novo, troca de modo ou aba fechada
  assert.equal(closes, 1, 'a conexão que abriu depois do stop() foi fechada');
  assert.equal(poller.client, null);
  assert.equal(poller.state, 'parado');
});

test('modo cliente: CLP que responde fora do padrão gera erro claro, sem reconectar a cada ciclo', async (t) => {
  let connections = 0;
  const plc = createTcpServer((s) => {
    connections++;
    s.on('error', () => {});
    let pending = Buffer.alloc(0);
    s.on('data', (chunk) => {
      const { frames, rest } = extractFrames(Buffer.concat([pending, chunk]));
      pending = Buffer.from(rest);
      // Conteúdo certo (confirma FC 15; FC 1 com Q0.0–Q0.3 ligadas), mas sempre com unit id 0 (o pedido usa 1).
      for (const f of frames) {
        const pdu = f.pdu[0] === 0x0f ? f.pdu.subarray(0, 5) : Buffer.from([f.pdu[0], 1, 0x0f]);
        s.write(encodeAdu(f.transactionId, 0, pdu));
      }
    });
  });
  const port = await listen(plc);
  t.after(() => plc.close());
  const runner = new PlantRunner(conveyor, { realtime: false });
  const poller = new ModbusPoller(clientConfig(port), runner);
  poller.start();
  t.after(() => poller.stop());
  await wait(800);
  assert.equal(poller.state, 'erro');
  assert.match(poller.message, /fora do padrão Modbus: unit id 0 na resposta, esperado 1/);
  assert.equal(connections, 1, 'mantém a conexão em vez de reconectar a cada 20 ms');
  assert.ok(poller.errors >= 1 && poller.errors <= 3, `espera entre tentativas (${poller.errors} erros em 800 ms)`);
  assert.deepEqual(runner.outputs, {}, 'saídas de uma resposta inválida não chegam à máquina');
});
