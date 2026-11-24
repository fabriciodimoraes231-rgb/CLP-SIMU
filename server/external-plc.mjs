// "CLP externo" de exemplo: roda um programa ladder do CLP Simu fora do navegador e
// conversa com a planta pelo Modbus TCP, como faria um OpenPLC Runtime ou um CODESYS.
// Cada ciclo: lê as entradas discretas (FC 2) e, se o programa usa IW, os registradores de entrada (FC 4)
// → varre o programa → escreve as coils (FC 15).

import { PLC } from '../src/engine/plc.js';
import { programAddresses } from '../src/engine/program.js';
import { AREA_BITS, ANALOG_REGS, bitIndex, keyFromIndex } from '../src/engine/iomap.js';

export class ModbusPlc {
  constructor({ client, program }) {
    this.client = client;
    this.plc = new PLC();
    const errors = this.plc.load(program);
    if (errors.length) {
      const e = errors[0];
      throw new Error(`Programa com ${errors.length} problema(s). Primeiro: degrau ${e.rung + 1}, linha ${e.row + 1}, coluna ${e.col + 1}: ${e.message}`);
    }
    this.readsAnalogs = [...programAddresses(program)].some((k) => k.startsWith('IW'));
    this.outputs = {};
  }

  /** Um ciclo completo de E/S. dtMs = tempo real desde o ciclo anterior (alimenta os temporizadores). */
  async cycle(dtMs) {
    const di = await this.client.readDiscreteInputs(0, AREA_BITS);
    const inputs = {};
    di.forEach((v, i) => { inputs[keyFromIndex('I', i)] = v; });
    if (this.readsAnalogs) {
      const regs = await this.client.readInputRegisters(0, ANALOG_REGS);
      regs.forEach((v, i) => { inputs[`IW${i}`] = v; });
    }
    this.outputs = this.plc.scan(inputs, dtMs);
    const coils = new Array(AREA_BITS).fill(false);
    for (const [k, v] of Object.entries(this.outputs)) if (v) coils[bitIndex(k)] = true;
    await this.client.writeCoils(0, coils);
    return this.outputs;
  }

  /** Desliga todas as saídas da planta (usado ao encerrar). */
  async allOff() {
    await this.client.writeCoils(0, new Array(AREA_BITS).fill(false));
  }
}
