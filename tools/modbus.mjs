// Cliente Modbus TCP de linha de comando para testar o simulador sem instalar nada.
//
//   node tools/modbus.mjs ler                  lê entradas, saídas, analógicos e (no modo servidor) as MW
//   node tools/modbus.mjs monitorar            mostra as mudanças a cada 200 ms (Ctrl+C para sair)
//   node tools/modbus.mjs escrever Q0.0 1      liga (1) ou desliga (0) uma saída (coil) — modo CLP externo
//   node tools/modbus.mjs escrever MW2 700     grava um setpoint (registrador holding) — modo servidor

import { ModbusClient, ModbusError, EX } from '../server/modbus.mjs';
import { AREA_BITS, ANALOG_REGS, HOLDING_REGS, bitIndex, keyFromIndex, modbusRef } from '../src/engine/iomap.js';
import { parseAddress, parseOperand, toInt16 } from '../src/engine/address.js';
import { parseCli, sleep, stamp, fetchPlanta, symbolTable, connectionHint } from './common.mjs';

const USAGE = `Uso: node tools/modbus.mjs <comando> [opções]

Comandos:
  ler                     lê entradas discretas (FC 2), coils (FC 1), registradores de entrada (FC 4)
                          e, com a página em "CLP interno + servidor Modbus", as MW (holding, FC 3)
  monitorar               mostra as mudanças a cada 200 ms (Ctrl+C para sair)
  escrever <saída> <0|1>  escreve uma coil (FC 5). <saída> = Q0.0 … Q15.7 ou índice 0–127 (modo CLP externo)
  escrever <MWn> <valor>  escreve um registrador holding (FC 6): MW0 … MW63, valor de −32768 a 32767
                          (modo CLP interno + servidor Modbus: setpoints do ladder)

Opções:
  --host <ip>    servidor Modbus (padrão 127.0.0.1)
  --porta <n>    porta Modbus (padrão 5020)
  --http <n>     porta da página, para mostrar os símbolos (padrão 5173)`;

const { values, positionals, port, httpPort } = parseCli({}, USAGE);
const [command, ...rest] = positionals;
const host = values.host;

if (!['ler', 'monitorar', 'escrever'].includes(command)) {
  console.log(USAGE);
  process.exit(command ? 2 : 0);
}

let client;
try {
  client = await ModbusClient.connect({ host, port });
} catch (err) {
  console.error(connectionHint(err, host, port));
  process.exit(1);
}

const planta = await fetchPlanta(httpPort);
const symbols = symbolTable(planta);
const analogs = planta?.io?.analogs ?? [];
const server = planta?.role === 'clp';
// MW mostradas: as que o programa usa ou nomeia (enviadas pela página); sem a lista, MW0–MW15.
const words = server
  ? (planta.io.words?.length ? planta.io.words.map((w) => parseAddress(w.addr).index) : [...Array(16).keys()])
  : [];
// Pontos mostrados: os declarados pela máquina; sem a página, os 16 primeiros de cada tabela.
const diShown = planta?.io ? planta.io.inputs.map((x) => bitIndex(x.addr)) : [...Array(16).keys()];
const coilShown = planta?.io ? planta.io.outputs.map((x) => bitIndex(x.addr)) : [...Array(16).keys()];

async function snapshot() {
  const [di, coils, ir, hr] = await Promise.all([
    client.readDiscreteInputs(0, AREA_BITS),
    client.readCoils(0, AREA_BITS),
    analogs.length ? client.readInputRegisters(0, ANALOG_REGS) : Promise.resolve([]),
    words.length ? client.readHoldingRegisters(0, HOLDING_REGS) : Promise.resolve([]),
  ]);
  return { di, coils, ir, hr: hr.map(toInt16) };
}

const pad = (s, n) => String(s).padEnd(n);
const sym = (key) => symbols.get(key) ?? '';
const fmtAnalog = (a, raw) => `${raw}${a.scale !== 1 ? `  (${(raw / a.scale).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} ${a.unit})` : ` ${a.unit}`}`;

function fail(err) {
  console.error(err instanceof ModbusError ? err.message : `Erro: ${err.message}`);
  client.close();
  process.exit(1);
}

if (command === 'ler') {
  try {
    const s = await snapshot();
    if (planta?.machine) console.log(`${server ? 'CLP interno (servidor Modbus)' : 'Planta'}: ${planta.machine.name}\n`);
    console.log('Entradas discretas (FC 2) — sensores e botões');
    for (const i of diShown) console.log(`  ${modbusRef('DI', i)}  DI ${pad(i, 4)} ${pad(keyFromIndex('I', i), 6)} ${pad(sym(keyFromIndex('I', i)), 16)} ${s.di[i] ? 1 : 0}`);
    console.log(server ? '\nCoils (FC 1) — saídas do CLP, só leitura' : '\nCoils (FC 1, 5, 15) — atuadores');
    for (const i of coilShown) console.log(`  ${modbusRef('COIL', i)}  coil ${pad(i, 2)} ${pad(keyFromIndex('Q', i), 6)} ${pad(sym(keyFromIndex('Q', i)), 16)} ${s.coils[i] ? 1 : 0}`);
    if (analogs.length) {
      console.log('\nRegistradores de entrada (FC 4) — analógicos');
      for (const a of analogs) console.log(`  ${modbusRef('IR', a.reg)}  IR ${pad(a.reg, 4)} ${pad(`IW${a.reg}`, 6)} ${pad(a.symbol, 16)} ${fmtAnalog(a, s.ir[a.reg])}`);
    }
    if (words.length) {
      console.log('\nRegistradores holding (FC 3, 6, 16) — memórias MW do CLP');
      for (const i of words) console.log(`  ${modbusRef('HR', i)}  HR ${pad(i, 4)} ${pad(`MW${i}`, 6)} ${pad(sym(`MW${i}`), 16)} ${s.hr[i]}`);
    }
    if (!planta) console.log('\n(Página não encontrada: mostrando só os 16 primeiros pontos, sem símbolos.)');
  } catch (err) {
    fail(err);
  }
  client.close();
}

/** escrever MWn <valor>: registrador holding (FC 6). */
async function writeWord(target, value) {
  const a = parseAddress(target);
  const v = parseOperand(value ?? '');
  if (!v || v.key) {
    console.error('Uso: node tools/modbus.mjs escrever <MW0 … MW63> <valor de −32768 a 32767>');
    client.close();
    process.exit(2);
  }
  const key = a.key;
  try {
    await client.writeRegister(a.index, v.value);
    const [back] = await client.readHoldingRegisters(a.index, 1);
    console.log(`Registrador holding ${a.index} (${modbusRef('HR', a.index)}) · ${key}${sym(key) ? ` ${sym(key)}` : ''} ← ${v.value}`);
    // O ladder pode corrigir o valor (limites) já na varredura seguinte: confere depois de um instante.
    await sleep(300);
    const [later] = await client.readHoldingRegisters(a.index, 1);
    if (toInt16(later) !== v.value) console.log(`O CLP alterou o valor para ${toInt16(later)} (limite ou lógica do programa).`);
    else if (toInt16(back) !== v.value) console.log(`Lido logo depois: ${toInt16(back)}.`);
  } catch (err) {
    if (err instanceof ModbusError && err.code === EX.ILLEGAL_ADDRESS && !server) {
      console.error('Registradores holding só existem no modo "CLP interno + servidor Modbus". Escolha esse modo no seletor Controle da página.');
      client.close();
      process.exit(1);
    }
    fail(err);
  }
  client.close();
}

if (command === 'escrever' && parseAddress(rest[0] ?? '')?.area === 'MW') {
  await writeWord(rest[0], rest[1]);
} else if (command === 'escrever') {
  const [target, value] = rest;
  const index = /^\d+$/.test(target ?? '') ? Number(target) : bitIndex(target ?? '');
  const key = (target ?? '').toUpperCase().replace(/^%/, '');
  if (index < 0 || index >= AREA_BITS || (!/^\d+$/.test(target) && key[0] !== 'Q') || !['0', '1'].includes(value)) {
    console.error('Uso: node tools/modbus.mjs escrever <Q0.0 … Q15.7 | 0–127> <0|1>\n'
      + '     ou: node tools/modbus.mjs escrever <MW0 … MW63> <valor>');
    client.close();
    process.exit(2);
  }
  try {
    await client.writeCoil(index, value === '1');
    const k = keyFromIndex('Q', index);
    console.log(`Coil ${index} (${modbusRef('COIL', index)}) · ${k}${sym(k) ? ` ${sym(k)}` : ''} ← ${value}`);
    console.log('Obs.: com o watchdog ligado na página, a saída volta a 0 após 1 s sem comunicação desta conexão.'
      + ' Para segurar o valor, desligue o watchdog no painel da página.');
  } catch (err) {
    if (err instanceof ModbusError && err.code === EX.ILLEGAL_FUNCTION) {
      console.error('As saídas pertencem ao ladder do CLP interno e não podem ser escritas pelo Modbus.'
        + ' Escreva nas memórias de palavra (ex.: escrever MW1 850) ou escolha "CLP externo" na página.');
      client.close();
      process.exit(1);
    }
    fail(err);
  }
  client.close();
}

if (command === 'monitorar') {
  let prev = null;
  let offline = false;
  let stopping = false;
  process.on('SIGINT', () => { stopping = true; });
  console.log(`Monitorando ${host}:${port} a cada 200 ms (Ctrl+C para sair)…`);
  while (!stopping) {
    try {
      const s = await snapshot();
      const lines = [];
      const bit = (label, table, area, i, now, before) => {
        if (prev && now === before) return;
        const k = keyFromIndex(area, i);
        lines.push(`${label} ${modbusRef(table, i)} ${k}${sym(k) ? ` ${sym(k)}` : ''}=${now ? 1 : 0}`);
      };
      for (const i of diShown) bit('DI', 'DI', 'I', i, s.di[i], prev?.di[i]);
      for (const i of coilShown) bit('coil', 'COIL', 'Q', i, s.coils[i], prev?.coils[i]);
      for (const a of analogs) {
        const v = s.ir[a.reg];
        if (!prev || Math.abs(v - prev.ir[a.reg]) >= Math.max(1, a.scale)) lines.push(`IR ${modbusRef('IR', a.reg)} ${a.symbol}=${fmtAnalog(a, v)}`);
        else s.ir[a.reg] = prev.ir[a.reg]; // só reporta variações de pelo menos 1 unidade
      }
      for (const i of words) {
        if (prev && s.hr[i] === prev.hr[i]) continue;
        const k = `MW${i}`;
        lines.push(`HR ${modbusRef('HR', i)} ${k}${sym(k) ? ` ${sym(k)}` : ''}=${s.hr[i]}`);
      }
      if (lines.length) console.log(`[${stamp()}] ${lines.join('  ')}`);
      prev = s;
      offline = false;
    } catch (err) {
      if (!(err instanceof ModbusError)) fail(err);
      if (!offline) console.log(`[${stamp()}] ${err.message}`);
      offline = true;
      prev = null;
    }
    await sleep(200);
  }
  client.close();
}
