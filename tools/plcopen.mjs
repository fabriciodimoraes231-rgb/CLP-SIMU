// Exporta programas do CLP Simu para PLCopen XML (TC6 2.01) pela linha de comando.
//
//   node tools/plcopen.mjs --programa meu.json --maquina tanque     → programa-tanque.xml
//   node tools/plcopen.mjs --pasta saida                            → todos os exemplos + amostra com todos os elementos
//
// A amostra cobre todos os tipos de elemento (para validar o exportador contra o esquema XSD do PLCopen com
// tools/validar-plcopen.ps1).

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { exportPlcopen } from '../src/engine/plcopen.js';
import { buildProgram, normalizeProgram } from '../src/engine/program.js';
import { MACHINES, machineExamples } from '../src/machines/index.js';

const USAGE = `Uso:
  node tools/plcopen.mjs --programa <arquivo.json> [--maquina <id>] [--saida <arquivo.xml>]
  node tools/plcopen.mjs --pasta <pasta>

Opções:
  --programa <arquivo>  programa exportado pelo CLP Simu (Exportar ▾ → Programa do CLP Simu)
  --maquina <id>        máquina do programa, para os símbolos de E/S (${MACHINES.map((m) => m.id).join(', ')})
  --saida <arquivo>     arquivo XML de saída (padrão: programa-<máquina>.xml)
  --pasta <pasta>       exporta todos os exemplos das máquinas e a amostra com todos os elementos`;

let values;
try {
  ({ values } = parseArgs({
    options: {
      programa: { type: 'string' }, maquina: { type: 'string' }, saida: { type: 'string' },
      pasta: { type: 'string' }, ajuda: { type: 'boolean', short: 'h' },
    },
  }));
} catch (err) {
  console.error(`${err.message}\n\n${USAGE}`);
  process.exit(2);
}
if (values.ajuda || (!values.programa && !values.pasta)) {
  console.log(USAGE);
  process.exit(values.ajuda ? 0 : 2);
}

/** Programa com todos os tipos de elemento, ramos paralelos e comentário com caracteres especiais. */
const sample = () => buildProgram({
  cols: 5,
  symbols: { 'M0.0': 'TON', 'M0.1': 'Ação 1', T0: 'T_A', T1: 'T_B', C0: 'C_UP', C1: 'C_DN', MW1: 'SP' },
  rungs: [
    ['Selo <com> "aspas" & ]]> fim', [
      ['NO I0.0', 'NC I0.1', '-', '-', 'COIL Q0.0'],
      ['NO Q0.0', '.', '.', '.', 'NCOIL Q0.1'],
    ], [[0, 1], [0, 4]]],
    ['', [['P I0.2', 'N I0.3', '-', '-', 'SET M0.0'], ['.', '.', '.', '.', 'RESET M0.1']], [[0, 4]]],
    ['Temporizadores', [['NO M0.0', '-', '-', '-', 'TON T0 1500'], ['NO M0.1', '-', '-', '-', 'TOF T1 2000']]],
    ['Contadores', [['NO T0', '-', '-', '-', 'CTU C0 3'], ['NO T1', '-', '-', '-', 'CTD C1 4']]],
    ['Resets', [['NO I0.4', '-', '-', '-', 'RESET C0'], ['NO I0.5', '-', '-', '-', 'RESET C1']]],
    ['Comparações', [
      ['EQ IW0 MW1', 'NE C0 2', 'GT MW1 -5', '-', 'COIL Q0.2'],
      ['GE T0 500', 'LT MW2 MW3', 'LE 1 2', '-', 'COIL Q0.3'],
    ]],
    ['Aritmética', [
      ['-', '-', '-', '-', 'MOVE 880 MW1'],
      ['.', '.', '.', '.', 'ADD MW1 10 MW2'],
      ['.', '.', '.', '.', 'SUB MW2 C0 MW3'],
      ['.', '.', '.', '.', 'MUL IW0 2 MW4'],
      ['.', '.', '.', '.', 'DIV MW4 3 MW5'],
      ['.', '.', '.', '.', 'MOD MW5 7 MW6'],
    ], [[0, 4], [1, 4], [2, 4], [3, 4], [4, 4]]],
  ],
});

async function write(file, program, machine) {
  const r = exportPlcopen(program, { machine });
  if (r.errors) {
    const e = r.errors[0];
    console.error(`${file}: programa com ${r.errors.length} problema(s). Primeiro: degrau ${e.rung + 1}, linha ${e.row + 1}, coluna ${e.col + 1}: ${e.message}`);
    process.exitCode = 1;
    return;
  }
  await writeFile(file, r.xml);
  console.log(`${file} (${r.xml.length.toLocaleString('pt-BR')} bytes)`);
  for (const n of r.notes) console.log(`  ${n.level === 'aviso' ? 'ATENÇÃO' : 'obs.'}: ${n.text}`);
}

const machine = values.maquina ? MACHINES.find((m) => m.id === values.maquina) : null;
if (values.maquina && !machine) {
  console.error(`Máquina desconhecida: ${values.maquina}. Opções: ${MACHINES.map((m) => m.id).join(', ')}`);
  process.exit(2);
}

if (values.pasta) {
  await mkdir(values.pasta, { recursive: true });
  for (const m of MACHINES) {
    for (const ex of machineExamples(m)) await write(join(values.pasta, `${m.id}-${ex.id}.xml`), ex.program(), m);
  }
  await write(join(values.pasta, 'amostra-todos-elementos.xml'), sample(), null);
}

if (values.programa) {
  const info = await stat(values.programa).catch(() => null);
  if (!info?.isFile() || info.size > 2_000_000) {
    console.error(`Arquivo não encontrado ou grande demais: ${values.programa}`);
    process.exit(1);
  }
  let program = null;
  try {
    program = normalizeProgram(JSON.parse(await readFile(values.programa, 'utf8')));
  } catch {
    program = null;
  }
  if (!program) {
    console.error('O arquivo não é um programa exportado pelo CLP Simu.');
    process.exit(1);
  }
  await write(values.saida ?? `programa-${machine?.id ?? 'clpsimu'}.xml`, program, machine);
}
