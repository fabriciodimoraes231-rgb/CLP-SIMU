// "CLP escravo" de ensaio: imita um CLP que responde como servidor (escravo) Modbus TCP, com memória própria
// e um programa ladder do CLP Simu. Serve para ensaiar o modo "o simulador se conecta ao CLP" sem o CLP real
// (tools/clp-escravo.mjs) e para os testes automáticos.
//
// Como num CLP de verdade, o programa lê as entradas de uma área de memória (onde o simulador escreve) e
// grava as saídas em outra (que o simulador lê). As áreas seguem a mesma convenção do ModbusPoller.

import { PLC } from '../src/engine/plc.js';
import { keyFromIndex, bitIndex } from '../src/engine/iomap.js';
import { machinePoints, packWords, unpackWords } from './modbus-poller.mjs';

const SPACE = 65536;

export class SlavePlc {
  /**
   * program: programa do CLP Simu · machine: para saber quantos pontos ler/escrever
   * inputs/outputs: { table, start } · analogs: { start } (holding) ou null
   */
  constructor({ program, machine, inputs, outputs, analogs = null }) {
    this.plc = new PLC();
    const errors = this.plc.load(program);
    if (errors.length) {
      const e = errors[0];
      throw new Error(`Programa com ${errors.length} problema(s). Primeiro: degrau ${e.rung + 1}, linha ${e.row + 1}, coluna ${e.col + 1}: ${e.message}`);
    }
    this.inputs = inputs;
    this.outputs = outputs;
    this.analogs = analogs;
    this.points = machinePoints(machine);
    this.model = {
      coils: new Uint8Array(SPACE),
      discreteInputs: new Uint8Array(SPACE),
      holdingRegisters: new Uint16Array(SPACE),
      inputRegisters: new Uint16Array(SPACE),
    };
    this.scans = 0;
  }

  readBits(area, n) {
    if (area.table === 'holding') return unpackWords(Array.from(this.model.holdingRegisters.subarray(area.start, area.start + Math.ceil(n / 16))), n);
    const table = area.table === 'discrete' ? this.model.discreteInputs : this.model.coils;
    return Array.from(table.subarray(area.start, area.start + n), (v) => !!v);
  }

  writeBits(area, bits) {
    if (area.table === 'holding') {
      packWords(bits).forEach((v, i) => { this.model.holdingRegisters[area.start + i] = v; });
      return;
    }
    const table = area.table === 'discrete' ? this.model.discreteInputs : this.model.coils;
    bits.forEach((v, i) => { table[area.start + i] = v ? 1 : 0; });
  }

  /** Uma varredura: memória de entrada → ladder → memória de saída. */
  scan(dtMs) {
    const inputs = {};
    this.readBits(this.inputs, this.points.inputs).forEach((v, i) => { inputs[keyFromIndex('I', i)] = v; });
    if (this.analogs) {
      for (let r = 0; r < this.points.analogs; r++) inputs[`IW${r}`] = this.model.holdingRegisters[this.analogs.start + r];
    }
    const out = this.plc.scan(inputs, dtMs);
    const bits = new Array(this.points.outputs).fill(false);
    for (const [k, v] of Object.entries(out)) {
      const i = bitIndex(k);
      if (i >= 0 && i < bits.length) bits[i] = !!v;
    }
    this.writeBits(this.outputs, bits);
    this.scans++;
    return out;
  }

  /** Entradas como o CLP as enxerga agora (para conferência). */
  inputBits() {
    return this.readBits(this.inputs, this.points.inputs);
  }
}
