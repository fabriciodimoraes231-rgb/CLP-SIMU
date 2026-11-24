import test from 'node:test';
import assert from 'node:assert/strict';
import { PLC } from '../src/engine/plc.js';
import { parseAddress, parseOperand, compareAddress, toInt16 } from '../src/engine/address.js';
import {
  buildProgram, compileProgram, normalizeProgram, autoWire, createRung, cellFromToken, programAddresses,
} from '../src/engine/program.js';

const COLS = 4;

function load(rungs) {
  const plc = new PLC();
  assert.deepEqual(plc.load(buildProgram({ cols: COLS, rungs })), []);
  return plc;
}

function run(plc, inputs, n = 1, dt = 10) {
  let out;
  for (let i = 0; i < n; i++) out = plc.scan(inputs, dt);
  return out;
}

test('endereços: normaliza e rejeita inválidos', () => {
  assert.equal(parseAddress(' %i0.3 ').key, 'I0.3');
  assert.equal(parseAddress('q1.7').key, 'Q1.7');
  assert.equal(parseAddress('t5').key, 'T5');
  assert.equal(parseAddress('C31').key, 'C31');
  for (const bad of ['I0.8', 'X0.0', 'M16.0', 'T32', 'I0', '', 'Q0.0.1', 'I-1.0', null]) {
    assert.equal(parseAddress(bad), null, String(bad));
  }
  const sorted = ['T1', 'Q0.0', 'I1.0', 'I0.7', 'M0.0', 'C0', 'T0'].sort(compareAddress);
  assert.deepEqual(sorted, ['I0.7', 'I1.0', 'Q0.0', 'M0.0', 'T0', 'T1', 'C0']);
});

test('contatos em série formam E lógico', () => {
  const plc = load([['', [['NO I0.0', 'NO I0.1', '-', 'COIL Q0.0']]]]);
  assert.equal(run(plc, { 'I0.0': 1, 'I0.1': 0 })['Q0.0'], false);
  assert.equal(run(plc, { 'I0.0': 1, 'I0.1': 1 })['Q0.0'], true);
});

test('contato NF conduz com operando em 0; bobina negada inverte', () => {
  const plc = load([['', [['NC I0.0', '-', '-', 'COIL Q0.0']]], ['', [['NO I0.0', '-', '-', 'NCOIL Q0.1']]]]);
  let out = run(plc, { 'I0.0': 0 });
  assert.equal(out['Q0.0'], true);
  assert.equal(out['Q0.1'], true);
  out = run(plc, { 'I0.0': 1 });
  assert.equal(out['Q0.0'], false);
  assert.equal(out['Q0.1'], false);
});

test('ramo paralelo com selo (partida e parada)', () => {
  const plc = load([
    ['', [
      ['NO I0.0', 'NO I0.1', '-', 'COIL M0.0'],
      ['NO M0.0', '.', '.', '.'],
    ], [[0, 1]]],
    ['', [['NO M0.0', '-', '-', 'COIL Q0.0']]],
  ]);
  // I0.1 = botão DESLIGA NF: vale 1 em repouso
  assert.equal(run(plc, { 'I0.0': 0, 'I0.1': 1 })['Q0.0'], false);
  assert.equal(run(plc, { 'I0.0': 1, 'I0.1': 1 })['Q0.0'], true);
  assert.equal(run(plc, { 'I0.0': 0, 'I0.1': 1 })['Q0.0'], true, 'selo mantém ligado');
  assert.equal(run(plc, { 'I0.0': 0, 'I0.1': 0 })['Q0.0'], false, 'desliga');
  assert.equal(run(plc, { 'I0.0': 0, 'I0.1': 1 })['Q0.0'], false, 'continua desligado');
});

test('linha sem ligação vertical não alimenta a saída de outra linha', () => {
  const plc = load([['', [['NO I0.0', '-', '-', 'COIL Q0.0'], ['NO I0.1', '-', '-', '.']]]]);
  assert.equal(run(plc, { 'I0.0': 0, 'I0.1': 1 })['Q0.0'], false);
});

test('ramo paralelo no meio do degrau (OU entre colunas)', () => {
  // (I0.0) E (I0.1 OU I0.2) → Q0.0, com o ramo entre os nós 1 e 2
  const plc = load([['', [
    ['NO I0.0', 'NO I0.1', '-', 'COIL Q0.0'],
    ['.', 'NO I0.2', '.', '.'],
  ], [[0, 1], [0, 2]]]]);
  assert.equal(run(plc, { 'I0.0': 1, 'I0.1': 0, 'I0.2': 1 })['Q0.0'], true);
  assert.equal(run(plc, { 'I0.0': 0, 'I0.1': 0, 'I0.2': 1 })['Q0.0'], false);
  assert.equal(run(plc, { 'I0.0': 1, 'I0.1': 0, 'I0.2': 0 })['Q0.0'], false);
});

test('ligação vertical na coluna de saída aciona várias saídas', () => {
  const plc = load([['', [['NO I0.0', '-', '-', 'COIL Q0.0'], ['.', '.', '.', 'COIL Q0.1']], [[0, 3]]]]);
  const out = run(plc, { 'I0.0': 1 });
  assert.equal(out['Q0.0'], true);
  assert.equal(out['Q0.1'], true);
});

test('SET mantém e RESET desliga', () => {
  const plc = load([
    ['', [['NO I0.0', '-', '-', 'SET Q0.0']]],
    ['', [['NO I0.1', '-', '-', 'RESET Q0.0']]],
  ]);
  assert.equal(run(plc, { 'I0.0': 1, 'I0.1': 0 })['Q0.0'], true);
  assert.equal(run(plc, { 'I0.0': 0, 'I0.1': 0 })['Q0.0'], true);
  assert.equal(run(plc, { 'I0.0': 0, 'I0.1': 1 })['Q0.0'], false);
});

test('TON conta enquanto energizado e zera ao desenergizar', () => {
  const plc = load([
    ['', [['NO I0.0', '-', '-', 'TON T0 100']]],
    ['', [['NO T0', '-', '-', 'COIL Q0.0']]],
  ]);
  assert.equal(run(plc, { 'I0.0': 1 }, 9)['Q0.0'], false);
  assert.equal(run(plc, { 'I0.0': 1 }, 1)['Q0.0'], true);
  assert.equal(plc.timers.get('T0').et, 100);
  assert.equal(run(plc, { 'I0.0': 0 })['Q0.0'], false);
  assert.equal(plc.timers.get('T0').et, 0);
});

test('TOF mantém a saída por PT depois que a entrada cai', () => {
  const plc = load([
    ['', [['NO I0.0', '-', '-', 'TOF T0 50']]],
    ['', [['NO T0', '-', '-', 'COIL Q0.0']]],
  ]);
  assert.equal(run(plc, { 'I0.0': 0 })['Q0.0'], false, 'começa desligado');
  assert.equal(run(plc, { 'I0.0': 1 })['Q0.0'], true);
  assert.equal(run(plc, { 'I0.0': 0 }, 4)['Q0.0'], true, 'mantém durante PT');
  assert.equal(run(plc, { 'I0.0': 0 }, 1)['Q0.0'], false, 'desliga ao fim de PT');
});

test('CTU conta só bordas de subida e RESET zera', () => {
  const plc = load([
    ['', [['NO I0.0', '-', '-', 'CTU C0 3']]],
    ['', [['NO I0.1', '-', '-', 'RESET C0']]],
    ['', [['NO C0', '-', '-', 'COIL Q0.0']]],
  ]);
  for (let i = 0; i < 2; i++) {
    run(plc, { 'I0.0': 1 }, 3);
    run(plc, { 'I0.0': 0 });
  }
  assert.equal(plc.counters.get('C0').cv, 2, 'segurar a entrada não conta de novo');
  assert.equal(run(plc, { 'I0.0': 1 })['Q0.0'], true);
  assert.equal(run(plc, { 'I0.0': 0, 'I0.1': 1 })['Q0.0'], false);
  assert.equal(plc.counters.get('C0').cv, 0);
});

test('CTD começa em PV, não fica negativo e RESET recarrega PV', () => {
  const plc = load([
    ['', [['NO I0.0', '-', '-', 'CTD C1 2']]],
    ['', [['NO I0.1', '-', '-', 'RESET C1']]],
    ['', [['NO C1', '-', '-', 'COIL Q0.0']]],
  ]);
  run(plc, { 'I0.0': 0 });
  assert.equal(plc.counters.get('C1').cv, 2);
  run(plc, { 'I0.0': 1 }); run(plc, { 'I0.0': 0 });
  assert.equal(run(plc, { 'I0.0': 1 })['Q0.0'], true);
  run(plc, { 'I0.0': 0 }); run(plc, { 'I0.0': 1 });
  assert.equal(plc.counters.get('C1').cv, 0);
  assert.equal(run(plc, { 'I0.0': 0, 'I0.1': 1 })['Q0.0'], false);
  assert.equal(plc.counters.get('C1').cv, 2);
});

test('borda P é detectada no operando mesmo com o degrau sem energia', () => {
  const plc = load([['', [['NO I0.1', 'P I0.0', '-', 'COIL Q0.0']]]]);
  run(plc, { 'I0.0': 0, 'I0.1': 0 });
  run(plc, { 'I0.0': 1, 'I0.1': 0 }); // a borda acontece aqui, sem energia
  assert.equal(run(plc, { 'I0.0': 1, 'I0.1': 1 })['Q0.0'], false, 'sem borda "atrasada"');
  run(plc, { 'I0.0': 0, 'I0.1': 1 });
  assert.equal(run(plc, { 'I0.0': 1, 'I0.1': 1 })['Q0.0'], true, 'borda com energia');
  assert.equal(run(plc, { 'I0.0': 1, 'I0.1': 1 })['Q0.0'], false, 'dura um único ciclo');
});

test('borda N conduz um ciclo na descida', () => {
  const plc = load([['', [['N I0.0', '-', '-', 'COIL Q0.0']]]]);
  assert.equal(run(plc, { 'I0.0': 1 })['Q0.0'], false);
  assert.equal(run(plc, { 'I0.0': 0 })['Q0.0'], true);
  assert.equal(run(plc, { 'I0.0': 0 })['Q0.0'], false);
});

test('rastro de energia para a animação', () => {
  const plc = load([['', [['NO I0.0', 'NC I0.1', '-', 'COIL Q0.0']]]]);
  run(plc, { 'I0.0': 1, 'I0.1': 1 });
  const tr = plc.trace[0];
  assert.deepEqual(tr.nodes[0], [true, true, false, false]);
  assert.deepEqual(tr.closed[0].slice(0, 2), [true, false]);
});

test('validação aponta erros de posição, endereço, área e blocos repetidos', () => {
  const program = buildProgram({
    cols: COLS,
    rungs: [
      ['', [['COIL Q0.0', '-', '-', 'NO I0.0']]],
      ['', [['NO X9.9', '-', '-', 'COIL I0.0']]],
      ['', [['NO I0.0', '-', '-', 'TON T0 100']]],
      ['', [['NO I0.1', '-', '-', 'TOF T0 100']]],
      ['', [['NO I0.0', '-', '-', 'CTU C0 -1']]],
    ],
  });
  const { errors, compiled } = compileProgram(program);
  const has = (rung, col) => errors.some((e) => e.rung === rung && e.col === col);
  assert.equal(compiled, null);
  assert.ok(has(0, 0), 'bobina fora da coluna de saída');
  assert.ok(has(0, 3), 'contato na coluna de saída');
  assert.ok(has(1, 0), 'endereço inválido');
  assert.ok(has(1, 3), 'bobina escrevendo em entrada');
  assert.ok(has(2, 3) && has(3, 3), 'T0 em dois blocos');
  assert.ok(has(4, 3), 'PV negativo');
});

test('normalizeProgram limpa dados importados', () => {
  assert.equal(normalizeProgram(null), null);
  assert.equal(normalizeProgram({ cols: 99, rungs: [] }), null);
  const p = normalizeProgram({
    cols: 4,
    symbols: { 'm0.0': 'LIGADO', bogus: 'x' },
    rungs: [{
      comment: 'ok',
      cells: [[{ type: 'NO', addr: 'I0.0' }, { type: '<script>' }, null, { type: 'COIL', addr: 'Q0.0' }]],
      vlinks: [[true, true, true, true]],
    }],
  });
  assert.deepEqual(p.symbols, { 'M0.0': 'LIGADO' });
  assert.equal(p.rungs[0].cells[0][1], null, 'tipo desconhecido descartado');
  assert.deepEqual(p.rungs[0].vlinks[0], [false, false, false, false], 'sem ligação na última linha');
});

test('autoWire completa a linha até a saída', () => {
  const rung = createRung(COLS, 2);
  rung.cells[0][0] = cellFromToken('NO I0.0');
  rung.cells[0][3] = cellFromToken('COIL Q0.0');
  autoWire(rung, 0, COLS);
  assert.deepEqual(rung.cells[0].map((c) => c?.type ?? null), ['NO', 'WIRE', 'WIRE', 'COIL']);
  rung.cells[1][3] = cellFromToken('COIL Q0.1');
  rung.vlinks[0][2] = true;
  autoWire(rung, 1, COLS);
  assert.deepEqual(rung.cells[1].map((c) => c?.type ?? null), [null, null, 'WIRE', 'COIL']);
});

// ---------------------------------------------------------------------------
// Palavras (INT), comparação e aritmética
// ---------------------------------------------------------------------------

test('endereços de palavra e operandos numéricos', () => {
  assert.equal(parseAddress('mw5').key, 'MW5');
  assert.equal(parseAddress('%IW15').key, 'IW15');
  assert.equal(parseAddress('MW63').word, true);
  for (const bad of ['MW64', 'IW16', 'QW0', 'MW', 'MW0.1']) assert.equal(parseAddress(bad), null, bad);
  assert.deepEqual(parseOperand(' -32768 '), { value: -32768, key: null });
  assert.equal(parseOperand('32767').value, 32767);
  assert.equal(parseOperand('+7').value, 7);
  for (const bad of ['32768', '-32769', '1.5', '1e3', '', 'abc', null]) assert.equal(parseOperand(bad), null, String(bad));
  assert.equal(parseOperand('t3').key, 'T3');
  assert.equal(toInt16(32768), -32768);
  assert.equal(toInt16(-32769), 32767);
  assert.equal(toInt16(65535), -1);
  const sorted = ['T0', 'MW1', 'M0.0', 'IW0', 'MW0', 'Q0.0', 'C0', 'I0.0'].sort(compareAddress);
  assert.deepEqual(sorted, ['I0.0', 'Q0.0', 'M0.0', 'IW0', 'MW0', 'MW1', 'T0', 'C0']);
});

test('comparações com constantes, IW e MW', () => {
  const ops = ['EQ', 'NE', 'GT', 'GE', 'LT', 'LE'];
  const plc = load([
    ['', [['-', '-', '-', 'MOVE IW0 MW0']]],
    ...ops.map((op, i) => ['', [[`${op} MW0 600`, '-', '-', `COIL Q0.${i}`]]]),
    ['', [['GE IW0 IW1', '-', '-', 'COIL Q1.0']]],
  ]);
  const table = (v) => ops.map((op, i) => run(plc, { IW0: v, IW1: 600 })[`Q0.${i}`]);
  //                       EQ     NE     GT     GE     LT     LE
  assert.deepEqual(table(599), [false, true, false, false, true, true]);
  assert.deepEqual(table(600), [true, false, false, true, false, true]);
  assert.deepEqual(table(601), [false, true, true, true, false, false]);
  assert.equal(run(plc, { IW0: 600, IW1: 600 })['Q1.0'], true, 'palavra com palavra');
  assert.equal(run(plc, { IW0: 40000, IW1: 600 })['Q1.0'], false, 'IW acima de 32767 vira negativo (INT)');
  assert.equal(plc.readWord('IW0'), -25536);
  assert.equal(plc.read('IW0'), false, 'IW não cria bit de entrada');
});

test('comparação lê o tempo decorrido de T e a contagem de C', () => {
  const plc = load([
    ['', [['NO I0.0', '-', '-', 'TON T0 1000']]],
    ['', [['GE T0 300', '-', '-', 'COIL Q0.0']]],
    ['', [['NO I0.1', '-', '-', 'CTU C0 10']]],
    ['', [['EQ C0 2', '-', '-', 'COIL Q0.1']]],
  ]);
  assert.equal(run(plc, { 'I0.0': 1 }, 29)['Q0.0'], false);
  assert.equal(run(plc, { 'I0.0': 1 }, 1)['Q0.0'], true, '300 ms decorridos');
  assert.equal(plc.timers.get('T0').q, false, 'o T0 ainda não terminou');
  for (let i = 0; i < 2; i++) { run(plc, { 'I0.1': 1 }); run(plc, { 'I0.1': 0 }); }
  assert.equal(run(plc, {})['Q0.1'], true);
});

test('MOVE, ADD, SUB, MUL, DIV e MOD gravam em MW com estouro circular', () => {
  const plc = load([
    ['', [
      ['-', '-', '-', 'MOVE 7 MW0'],
      ['.', '.', '.', 'MOVE -7 MW1'],
      ['.', '.', '.', 'ADD MW0 MW1 MW2'],
      ['.', '.', '.', 'SUB MW0 10 MW3'],
      ['.', '.', '.', 'MUL MW0 MW1 MW4'],
      ['.', '.', '.', 'DIV MW0 2 MW5'],
    ], [[0, 3], [1, 3], [2, 3], [3, 3], [4, 3]]],
    ['', [
      ['-', '-', '-', 'DIV MW1 2 MW6'],
      ['.', '.', '.', 'MOD MW1 2 MW7'],
      ['.', '.', '.', 'MOD MW0 3 MW8'],
      ['.', '.', '.', 'MUL 300 300 MW9'],
      ['.', '.', '.', 'ADD 32767 1 MW10'],
      ['.', '.', '.', 'SUB -32768 1 MW11'],
    ], [[0, 3], [1, 3], [2, 3], [3, 3], [4, 3]]],
  ]);
  run(plc, {});
  const w = (i) => plc.readWord(`MW${i}`);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(w), [7, -7, 0, -3, -49, 3]);
  assert.equal(w(6), -3, 'divisão trunca em direção a zero');
  assert.equal(w(7), -1, 'resto com o sinal de A');
  assert.equal(w(8), 1);
  assert.equal(w(9), 24464, '90000 dá a volta em 16 bits');
  assert.equal(w(10), -32768);
  assert.equal(w(11), 32767);
});

test('aritmética só executa com energia; borda P faz o ADD somar uma vez', () => {
  const plc = load([
    ['', [['NO I0.0', '-', '-', 'ADD MW0 1 MW0']]],
    ['', [['P I0.1', '-', '-', 'ADD MW1 1 MW1']]],
    ['', [['NO I0.2', '-', '-', 'MOVE 0 MW1']]],
  ]);
  run(plc, { 'I0.0': 0, 'I0.1': 0 }, 5);
  assert.equal(plc.readWord('MW0'), 0, 'sem energia não executa');
  run(plc, { 'I0.0': 1, 'I0.1': 1 }, 5);
  assert.equal(plc.readWord('MW0'), 5, 'com energia executa a cada varredura');
  assert.equal(plc.readWord('MW1'), 1, 'borda: uma vez');
  run(plc, { 'I0.1': 0 }); run(plc, { 'I0.1': 1 });
  assert.equal(plc.readWord('MW1'), 2);
  run(plc, { 'I0.2': 1 });
  assert.equal(plc.readWord('MW1'), 0);
});

test('divisão por zero em tempo de execução mantém o destino e é contada', () => {
  const plc = load([
    ['', [['-', '-', '-', 'MOVE 9 MW0'], ['.', '.', '.', 'DIV 100 MW1 MW0']], [[0, 3]]],
  ]);
  run(plc, {}, 3);
  assert.equal(plc.readWord('MW0'), 9);
  assert.equal(plc.mathFaults, 3);
  plc.coldStart();
  assert.equal(plc.mathFaults, 0);
  assert.equal(plc.readWord('MW0'), 0, 'partida a frio zera MW');
});

test('validação das instruções numéricas', () => {
  const program = buildProgram({
    cols: COLS,
    rungs: [
      ['', [['GE I0.0 5', '-', '-', 'COIL Q0.0']]],
      ['', [['NO I0.0', '-', '-', 'ADD MW0 1 Q0.0']]],
      ['', [['NO I0.0', '-', '-', 'DIV MW0 0 MW1']]],
      ['', [['ADD MW0 1 MW0', '-', '-', 'GE MW0 1']]],
      ['', [['EQ MW0 40000', '-', '-', 'MOVE MW64 MW1']]],
      ['', [['LT T0 C0', '-', '-', 'MOVE IW3 MW1']]],
    ],
  });
  const { errors } = compileProgram(program);
  const msgs = (rung, col) => errors.filter((e) => e.rung === rung && e.col === col).map((e) => e.message).join(' | ');
  assert.match(msgs(0, 0), /é um bit/);
  assert.match(msgs(1, 3), /não aceita Q0\.0/);
  assert.match(msgs(2, 3), /Divisão por zero/);
  assert.match(msgs(3, 0), /última coluna/);
  assert.match(msgs(3, 3), /não pode ficar na coluna de saídas/);
  assert.match(msgs(4, 0), /Operando B inválido "40000"/);
  assert.match(msgs(4, 3), /Operando A inválido "MW64"/);
  assert.equal(msgs(5, 0) + msgs(5, 3), '', 'T, C e IW são operandos válidos');
});

test('operandos numéricos: construtor, importação e lista de endereços usados', () => {
  assert.deepEqual(cellFromToken('GE IW1 600'), { type: 'GE', in1: 'IW1', in2: '600' });
  assert.deepEqual(cellFromToken('ADD MW0 1 MW2'), { type: 'ADD', in1: 'MW0', in2: '1', addr: 'MW2' });
  assert.deepEqual(cellFromToken('MOVE 0 MW3'), { type: 'MOVE', in1: '0', addr: 'MW3' });
  const p = normalizeProgram({
    cols: 4,
    symbols: { mw1: 'SETPOINT', iw0: 'NIVEL' },
    rungs: [{ cells: [[{ type: 'GE', in1: 'IW0', in2: 'MW1', extra: 1 }, null, null, { type: 'SUB', in1: 'MW1', in2: 5, addr: 'MW2' }]] }],
  });
  assert.deepEqual(p.symbols, { MW1: 'SETPOINT', IW0: 'NIVEL' });
  assert.deepEqual(p.rungs[0].cells[0][0], { type: 'GE', in1: 'IW0', in2: 'MW1' });
  assert.deepEqual(p.rungs[0].cells[0][3], { type: 'SUB', in1: 'MW1', addr: 'MW2' }, 'operando não textual descartado');
  assert.deepEqual([...programAddresses(p)].sort(compareAddress), ['IW0', 'MW1', 'MW2']);
});
