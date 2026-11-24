// Testes de integração: programa de exemplo + simulação física de cada máquina.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PLC } from '../src/engine/plc.js';
import { conveyor } from '../src/machines/conveyor.js';
import { tank } from '../src/machines/tank.js';
import { MACHINES, machineExamples } from '../src/machines/index.js';
import { mulberry32, analogInputs } from '../src/machines/common.js';
import { parseAddress } from '../src/engine/address.js';
import { compileProgram } from '../src/engine/program.js';

const DT = 10; // ms, mesmo ciclo da interface

class Rig {
  constructor(machine, seed = 1, program = machine.exampleProgram()) {
    this.machine = machine;
    this.sim = machine.createSim({ rng: mulberry32(seed) });
    this.plc = new PLC();
    assert.deepEqual(this.plc.load(program), []);
    this.outputs = {};
    this.active = new Set();
  }

  run(seconds) {
    const steps = Math.round((seconds * 1000) / DT);
    for (let i = 0; i < steps; i++) {
      this.sim.update(DT / 1000, this.outputs);
      const inputs = { ...this.sim.readInputs(), ...analogInputs(this.machine, this.sim) };
      for (const c of this.machine.controls) {
        const on = this.active.has(c.addr);
        inputs[c.addr] = c.contact === 'NO' ? on : !on;
      }
      this.outputs = this.plc.scan(inputs, DT);
    }
  }

  press(addr, seconds = 0.2) {
    this.active.add(addr);
    this.run(seconds);
    this.active.delete(addr);
  }
}

test('definições das máquinas são consistentes', () => {
  for (const m of MACHINES) {
    const ins = new Set(m.inputs.map((i) => i.addr));
    for (const io of [...m.inputs, ...m.outputs]) assert.ok(parseAddress(io.addr), `${m.id}: ${io.addr}`);
    for (const c of m.controls) assert.ok(ins.has(c.addr), `${m.id}: controle ${c.addr} sem entrada`);
    const sensors = Object.keys(m.createSim({ rng: mulberry32(1) }).readInputs());
    for (const k of sensors) assert.ok(ins.has(k), `${m.id}: sensor ${k} sem entrada declarada`);
    const regs = (m.analogs ?? []).map((a) => a.reg);
    assert.equal(new Set(regs).size, regs.length, `${m.id}: registradores analógicos repetidos`);
    for (const r of regs) assert.ok(parseAddress(`IW${r}`), `${m.id}: IW${r} fora da faixa`);
    const examples = machineExamples(m);
    assert.equal(examples[0].program, m.exampleProgram, `${m.id}: o primeiro exemplo é o padrão`);
    assert.equal(new Set(examples.map((x) => x.id)).size, examples.length, `${m.id}: ids de exemplo repetidos`);
    for (const x of examples) assert.deepEqual(compileProgram(x.program()).errors, [], `${m.id}/${x.id} compila`);
  }
});

test('esteira: exemplo separa as peças sem erro e para com 5 rejeitos', () => {
  const rig = new Rig(conveyor, 42);
  rig.run(0.5);
  assert.equal(rig.outputs['Q0.3'], true, 'lâmpada vermelha com sistema parado');
  rig.press('I0.0');
  assert.equal(rig.outputs['Q0.0'], true, 'motor liga');
  rig.run(120);

  const s = { ...rig.sim.stats }; // cópia: sim.stats continua mudando
  assert.equal(s.rejectShort, 0, 'nenhuma baixa rejeitada');
  assert.equal(s.endTall, 0, 'nenhuma alta na saída');
  assert.equal(s.rejectTall, 5, 'para ao completar 5 rejeitos');
  assert.ok(s.endShort > 0, 'baixas chegam à saída');
  assert.equal(rig.plc.read('M0.0'), false);
  assert.equal(rig.outputs['Q0.0'], false, 'motor parado');

  // RESET + LIGA volta a operar
  rig.press('I1.0');
  rig.press('I0.0');
  rig.run(30);
  const t = rig.sim.stats;
  assert.ok(t.rejectTall + t.endShort > s.rejectTall + s.endShort, 'voltou a separar peças');
  assert.equal(t.rejectShort + t.endTall, 0);
});

test('esteira: emergência para o motor e recolhe o cilindro', () => {
  const rig = new Rig(conveyor, 7);
  rig.press('I0.0');
  rig.run(10);
  rig.active.add('I0.6'); // emergência travada
  rig.run(1);
  assert.equal(rig.outputs['Q0.0'], false);
  assert.equal(rig.outputs['Q0.1'], false);
  assert.equal(rig.plc.read('M0.0'), false);
  assert.equal(rig.sim.readInputs()['I0.4'], true, 'cilindro recuado');
  rig.press('I0.0');
  assert.equal(rig.outputs['Q0.0'], false, 'não liga com emergência acionada');
  rig.active.delete('I0.6');
  rig.press('I0.0');
  assert.equal(rig.outputs['Q0.0'], true, 'liga após destravar');
});

test('tanque: exemplo produz 3 lotes no padrão e desliga', () => {
  const rig = new Rig(tank);
  rig.run(0.3);
  rig.press('I0.0');
  rig.run(150);
  const s = rig.sim.stats;
  assert.equal(s.good, 3);
  assert.equal(s.bad, 0);
  assert.equal(s.overflow, false);
  assert.equal(rig.plc.read('M0.0'), false);
  assert.equal(rig.plc.counters.get('C0').cv, 3);
});

test('tanque: exemplo analógico (IW, comparações, MOVE, ADD, DIV) produz 3 lotes no padrão', () => {
  const analog = tank.examples.find((x) => x.id === 'analogico');
  const rig = new Rig(tank, 1, analog.program());
  rig.run(0.3);
  assert.equal(rig.plc.readWord('MW1'), 880, 'setpoint de nível');
  assert.equal(rig.plc.readWord('MW4'), 22, 'temperatura em °C inteiros (DIV)');
  rig.press('I0.0');
  rig.run(8);
  assert.equal(rig.outputs['Q0.0'], true, 'ainda enchendo antes de 88 %');
  rig.run(2);
  assert.equal(rig.outputs['Q0.0'], false, 'parou de encher no setpoint');
  assert.ok(rig.sim.level > 87.9 && rig.sim.level < 89, `nível ${rig.sim.level}`);
  assert.equal(rig.outputs['Q0.2'], true, 'aquecendo');
  rig.run(140);
  const s = rig.sim.stats;
  assert.equal(s.good, 3);
  assert.equal(s.bad, 0);
  assert.equal(s.overflow, false);
  assert.equal(rig.plc.readWord('MW0'), 3, 'LOTES');
  assert.equal(rig.plc.read('M0.0'), false, 'desligou na meta');
  rig.press('I0.5');
  assert.equal(rig.plc.readWord('MW0'), 0, 'RESET zera LOTES');
});

test('tanque: lote raso (abaixo de 85 %) é avaliado como fora do padrão', () => {
  const sim = tank.createSim();
  for (let i = 0; i < 500; i++) sim.update(DT / 1000, { 'Q0.0': true, 'Q0.2': true }); // até 50 %
  assert.ok(sim.level > 49 && sim.level < 51);
  for (let i = 0; i < 400; i++) sim.update(DT / 1000, { 'Q0.3': true });
  assert.deepEqual([sim.stats.good, sim.stats.bad], [0, 1]);
  for (let i = 0; i < 100; i++) sim.update(DT / 1000, { 'Q0.0': true }); // 10 %: não chega a ser um lote
  for (let i = 0; i < 100; i++) sim.update(DT / 1000, { 'Q0.3': true });
  assert.deepEqual([sim.stats.good, sim.stats.bad], [0, 1]);
});

test('tanque: sem controle, encher direto transborda', () => {
  const sim = tank.createSim();
  for (let i = 0; i < 1200; i++) sim.update(DT / 1000, { 'Q0.0': true });
  assert.equal(sim.stats.overflow, true);
  assert.equal(sim.level, 100);
});
