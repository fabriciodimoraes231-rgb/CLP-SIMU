// CLP externo de exemplo: executa um programa ladder do CLP Simu fora do navegador e
// controla a máquina simulada pelo Modbus TCP — o mesmo papel de um OpenPLC Runtime ou CODESYS.
//
//   node tools/clp-externo.mjs                       segue a máquina aberta na página (programa de exemplo)
//   node tools/clp-externo.mjs --exemplo analogico   outro exemplo da máquina (quando ela tem mais de um)
//   node tools/clp-externo.mjs --programa meu.json   roda um programa exportado pelo botão "Exportar"
//
// Ctrl+C desliga todas as saídas da planta antes de sair.

import { readFile, stat } from 'node:fs/promises';
import { ModbusClient, ModbusError, EX } from '../server/modbus.mjs';
import { ModbusPlc } from '../server/external-plc.mjs';
import { normalizeProgram } from '../src/engine/program.js';
import { compareAddress } from '../src/engine/address.js';
import { MACHINES, machineExamples } from '../src/machines/index.js';
import { parseCli, sleep, stamp, fetchPlanta, symbolTable, connectionHint } from './common.mjs';

const USAGE = `Uso: node tools/clp-externo.mjs [opções]

Opções:
  --programa <arquivo.json>  programa exportado pelo CLP Simu (padrão: exemplo da máquina aberta na página)
  --maquina <id>             usa o exemplo desta máquina (${MACHINES.map((m) => m.id).join(', ')})
  --exemplo <id>             qual exemplo da máquina (${[...new Set(MACHINES.flatMap((m) => machineExamples(m).map((x) => x.id)))].join(', ')})
  --ciclo <ms>               tempo de ciclo do CLP externo (padrão 20, mínimo 5)
  --host <ip>                servidor Modbus (padrão 127.0.0.1)
  --porta <n>                porta Modbus (padrão 5020)
  --http <n>                 porta da página, para ler o nome da máquina (padrão 5173)`;

const { values, port, httpPort } = parseCli({
  programa: { type: 'string' },
  maquina: { type: 'string' },
  exemplo: { type: 'string' },
  ciclo: { type: 'string', default: '20' },
}, USAGE);

const host = values.host;
const cycleMs = Math.max(5, Number(values.ciclo) || 20);
const say = (msg) => console.log(`[${stamp()}] ${msg}`);

// ---- programa -------------------------------------------------------------

let fixedProgram = null;
if (values.programa) {
  const info = await stat(values.programa).catch(() => null);
  if (!info?.isFile() || info.size > 2_000_000) {
    console.error(`Arquivo não encontrado ou grande demais: ${values.programa}`);
    process.exit(1);
  }
  try {
    fixedProgram = normalizeProgram(JSON.parse(await readFile(values.programa, 'utf8')));
  } catch {
    fixedProgram = null;
  }
  if (!fixedProgram) {
    console.error('O arquivo não é um programa exportado pelo CLP Simu.');
    process.exit(1);
  }
}
if (values.maquina && !MACHINES.some((m) => m.id === values.maquina)) {
  console.error(`Máquina desconhecida: ${values.maquina}. Opções: ${MACHINES.map((m) => m.id).join(', ')}`);
  process.exit(2);
}

let client = null;
let ext = null;
let loadedFor = null;   // id da máquina cujo exemplo está carregado
let symbols = new Map();
let lastOut = {};

function load(machineId) {
  const machine = MACHINES.find((m) => m.id === machineId) ?? MACHINES[0];
  const examples = machineExamples(machine);
  const example = examples.find((x) => x.id === values.exemplo) ?? examples[0];
  if (!fixedProgram && values.exemplo && example.id !== values.exemplo) {
    say(`A máquina "${machine.name}" não tem o exemplo "${values.exemplo}". Opções: ${examples.map((x) => x.id).join(', ')}. Usando "${example.id}".`);
  }
  const program = fixedProgram ?? example.program();
  ext = new ModbusPlc({ client, program });
  loadedFor = machine.id;
  lastOut = {};
  const src = fixedProgram ? `programa ${values.programa}` : `exemplo "${example.name}" da máquina "${machine.name}"`;
  say(`CLP externo: ${src} · ${program.rungs.length} degraus · ciclo ${cycleMs} ms · Modbus ${host}:${port}`);
}

async function followPlant() {
  const planta = await fetchPlanta(httpPort);
  if (!planta?.connected) return;
  symbols = symbolTable(planta);
  const id = planta.machine?.id;
  if (!id) return;
  if (!fixedProgram && !values.maquina && id !== loadedFor && MACHINES.some((m) => m.id === id)) load(id);
  else if (fixedProgram && loadedFor !== id) {
    say(`Atenção: a página está com a máquina "${planta.machine.name}". Confira se o programa é para ela.`);
    loadedFor = id;
  }
}

function logChanges(out) {
  const keys = new Set([...Object.keys(out), ...Object.keys(lastOut)]);
  const changed = [...keys].filter((k) => !!out[k] !== !!lastOut[k]).sort(compareAddress);
  if (changed.length) {
    say(changed.map((k) => `${k}${symbols.get(k) ? ` ${symbols.get(k)}` : ''}=${out[k] ? 1 : 0}`).join('  '));
  }
  lastOut = { ...out };
}

// ---- laço -----------------------------------------------------------------

let running = true;
let shuttingDown = false;
process.on('SIGINT', async () => {
  if (shuttingDown) process.exit(130);
  shuttingDown = true;
  running = false;
  try {
    if (ext && client && !client.closed) {
      await ext.allOff();
      say('Saídas da planta desligadas.');
    }
  } catch { /* planta ou servidor já fora */ }
  client?.close();
  process.exit(0);
});

async function connectLoop() {
  let warned = false;
  while (running) {
    try {
      client = await ModbusClient.connect({ host, port });
      say(`Conectado ao servidor Modbus ${host}:${port}.`);
      return;
    } catch (err) {
      if (!warned) say(`${connectionHint(err, host, port)} Tentando de novo a cada 2 s…`);
      warned = true;
      await sleep(2000);
    }
  }
}

await connectLoop();
load(values.maquina ?? (await fetchPlanta(httpPort))?.machine?.id ?? MACHINES[0].id);
await followPlant();

let waiting = false;
let last = performance.now();
let lastFollow = 0;
while (running) {
  const t0 = performance.now();
  const dt = Math.min(t0 - last, 1000);
  last = t0;
  try {
    const out = await ext.cycle(dt);
    if (waiting) {
      say('Planta conectada: CLP externo no controle.');
      waiting = false;
      await followPlant();
    }
    logChanges(out);
  } catch (err) {
    if (err instanceof ModbusError && err.code === EX.GATEWAY_TARGET_FAILED) {
      if (!waiting) say('Aguardando a planta: abra a página do simulador e escolha "Controle: CLP externo".');
      waiting = true;
      ext.plc.coldStart();
      await sleep(500);
      continue;
    }
    if (err instanceof ModbusError && err.code === EX.ILLEGAL_FUNCTION) {
      // A página está em "CLP interno + servidor Modbus": as coils pertencem ao ladder dela.
      if (!waiting) say('A página está com o CLP interno no controle. Escolha "Controle: CLP externo" para assumir a máquina daqui.');
      waiting = true;
      ext.plc.coldStart();
      await sleep(1000);
      continue;
    }
    if (!running) break;
    say(`Conexão perdida (${err.message}).`);
    client?.close();
    await connectLoop();
    if (!running) break;
    load(loadedFor);
    continue;
  }
  if (t0 - lastFollow > 2000) {
    lastFollow = t0;
    followPlant();
  }
  await sleep(Math.max(0, cycleMs - (performance.now() - t0)));
}
