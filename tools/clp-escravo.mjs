// CLP escravo de ensaio: responde como um CLP com Modbus TCP servidor, rodando um programa ladder do CLP Simu.
// Use para ensaiar o modo "CLP externo: o simulador se conecta ao CLP" antes de ligar o CLP de verdade.
//
//   node tools/clp-escravo.mjs                         esteira, entradas em coils 0, saídas em coils 100
//   node tools/clp-escravo.mjs --maquina tanque --exemplo analogico --analogicos 200
//   node tools/clp-escravo.mjs --entradas coils:2148 --saidas coils:1280     (endereços como num Delta DVP)
//
// Escuta só em 127.0.0.1. Ctrl+C encerra.

import { readFile, stat } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createModbusServer } from '../server/modbus.mjs';
import { SlavePlc } from '../server/plc-escravo.mjs';
import { normalizeProgram } from '../src/engine/program.js';
import { compareAddress } from '../src/engine/address.js';
import { MACHINES, machineExamples } from '../src/machines/index.js';

const USAGE = `Uso: node tools/clp-escravo.mjs [opções]

Opções:
  --maquina <id>          máquina (${MACHINES.map((m) => m.id).join(', ')}; padrão: ${MACHINES[0].id})
  --exemplo <id>          exemplo da máquina (padrão: o primeiro)
  --programa <arquivo>    programa exportado pelo CLP Simu (.json), no lugar do exemplo
  --porta <n>             porta Modbus TCP (padrão 1502)
  --entradas <área>       onde o simulador escreve as entradas: coils:<início> ou holding:<início> (padrão coils:0)
  --saidas <área>         onde o programa grava as saídas: coils:, discrete: ou holding:<início> (padrão coils:100)
  --analogicos <início>   registrador holding onde o simulador escreve os analógicos (padrão: desligado)
  --ciclo <ms>            tempo de varredura (padrão 10)`;

let values;
try {
  ({ values } = parseArgs({
    options: {
      maquina: { type: 'string' }, exemplo: { type: 'string' }, programa: { type: 'string' },
      porta: { type: 'string', default: '1502' }, entradas: { type: 'string', default: 'coils:0' },
      saidas: { type: 'string', default: 'coils:100' }, analogicos: { type: 'string' },
      ciclo: { type: 'string', default: '10' }, ajuda: { type: 'boolean', short: 'h' },
    },
  }));
} catch (err) {
  console.error(`${err.message}\n\n${USAGE}`);
  process.exit(2);
}
if (values.ajuda) {
  console.log(USAGE);
  process.exit(0);
}

const fail = (msg) => { console.error(msg); process.exit(2); };
const area = (text, tables, name) => {
  const m = /^(coils|discrete|holding):(\d{1,5})$/.exec(text);
  if (!m || !tables.includes(m[1]) || Number(m[2]) > 65535) fail(`${name} inválida: "${text}". Use ${tables.map((t) => `${t}:<início>`).join(' ou ')}.`);
  return { table: m[1], start: Number(m[2]) };
};

const machine = values.maquina ? MACHINES.find((m) => m.id === values.maquina) : MACHINES[0];
if (!machine) fail(`Máquina desconhecida: ${values.maquina}. Opções: ${MACHINES.map((m) => m.id).join(', ')}`);
let program;
if (values.programa) {
  const info = await stat(values.programa).catch(() => null);
  if (!info?.isFile() || info.size > 2_000_000) fail(`Arquivo não encontrado ou grande demais: ${values.programa}`);
  try {
    program = normalizeProgram(JSON.parse(await readFile(values.programa, 'utf8')));
  } catch {
    program = null;
  }
  if (!program) fail('O arquivo não é um programa exportado pelo CLP Simu.');
} else {
  const examples = machineExamples(machine);
  const ex = values.exemplo ? examples.find((x) => x.id === values.exemplo) : examples[0];
  if (!ex) fail(`Exemplo desconhecido: ${values.exemplo}. Opções: ${examples.map((x) => x.id).join(', ')}`);
  program = ex.program();
}

const inputs = area(values.entradas, ['coils', 'holding'], 'Área de entradas');
const outputs = area(values.saidas, ['coils', 'discrete', 'holding'], 'Área de saídas');
const analogs = values.analogicos !== undefined ? { start: Number(values.analogicos) } : null;
if (analogs && !(Number.isInteger(analogs.start) && analogs.start >= 0 && analogs.start <= 65535)) fail('--analogicos: use um endereço de 0 a 65535.');
const port = Number(values.porta);
const cycleMs = Math.max(5, Number(values.ciclo) || 10);

let slave;
try {
  slave = new SlavePlc({ program, machine, inputs, outputs, analogs });
} catch (err) {
  fail(err.message);
}

const stamp = () => new Date().toLocaleTimeString('pt-BR');
const server = createModbusServer(slave.model, {
  hooks: {
    onConnect: (i) => console.log(`[${stamp()}] Simulador conectado (${i.remote})`),
    onDisconnect: (i) => console.log(`[${stamp()}] Simulador desconectado após ${i.requests} requisições`),
  },
});
server.server.on('error', (err) => fail(`Não foi possível abrir a porta ${port}: ${err.code ?? err.message}`));
server.server.listen(port, '127.0.0.1', () => {
  const where = (a) => `${a.table} a partir de ${a.start}`;
  console.log(`CLP escravo de ensaio em 127.0.0.1:${port} · máquina "${machine.name}" · ciclo ${cycleMs} ms`);
  console.log(`  entradas (o simulador escreve): ${where(inputs)}`);
  console.log(`  saídas (o simulador lê):        ${where(outputs)}`);
  if (analogs) console.log(`  analógicos (o simulador escreve): holding a partir de ${analogs.start}`);
  console.log('Na página: Controle → "CLP externo: o simulador se conecta ao CLP", IP 127.0.0.1, porta '
    + `${port} e as mesmas áreas. Ctrl+C encerra.`);
});

let last = performance.now();
let prev = {};
const timer = setInterval(() => {
  const t = performance.now();
  const out = slave.scan(Math.min(t - last, 1000));
  last = t;
  const keys = new Set([...Object.keys(out), ...Object.keys(prev)]);
  const changed = [...keys].filter((k) => !!out[k] !== !!prev[k]).sort(compareAddress);
  if (changed.length) {
    const sym = (k) => machine.outputs.find((o) => o.addr === k)?.symbol;
    console.log(`[${stamp()}] ${changed.map((k) => `${k}${sym(k) ? ` ${sym(k)}` : ''}=${out[k] ? 1 : 0}`).join('  ')}`);
  }
  prev = { ...out };
}, cycleMs);

process.on('SIGINT', async () => {
  clearInterval(timer);
  await server.close();
  process.exit(0);
});
