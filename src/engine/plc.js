// CLP simulado: memória, ciclo de varredura, temporizadores e contadores.
//
// Ciclo de varredura (scan):
//   1. lê as entradas físicas para a imagem de entradas (I);
//   2. executa os degraus de cima para baixo (cada degrau já enxerga o que os anteriores escreveram);
//   3. devolve a imagem de saídas (Q) para a máquina.
//
// Palavras (INT de 16 bits): MW em `words`, entradas analógicas IW em `analog`.
// Lidos como número, T devolve o tempo decorrido em ms (limitado a 32767) e C a contagem.

import { compileProgram } from './program.js';
import { evaluateRung } from './ladder.js';
import { ELEMENTS } from './elements.js';
import { toInt16, INT_MAX } from './address.js';

export const COUNTER_MAX = 32_767;

export class PLC {
  constructor() {
    this.compiled = null;
    this.coldStart();
  }

  /** Partida a frio: zera memórias, temporizadores, contadores e bordas. */
  coldStart() {
    this.bits = new Map();
    this.timers = new Map();
    this.counters = new Map();
    this.words = new Map();
    this.analog = new Map();
    this.edges = new WeakMap();
    this.mathFaults = 0;
    this.scanCount = 0;
    this.elapsed = 0;
    this.trace = [];
  }

  /** Compila e carrega o programa. Retorna a lista de erros (vazia se carregou). */
  load(program) {
    const { errors, compiled } = compileProgram(program);
    if (errors.length) return errors;
    this.compiled = compiled;
    this.coldStart();
    return [];
  }

  read(key) {
    switch (key[0]) {
      case 'T': return this.timers.get(key)?.q ?? false;
      case 'C': return this.counters.get(key)?.q ?? false;
      default: return this.bits.get(key) ?? false;
    }
  }

  /** Valor numérico (INT) de IW, MW, T (tempo decorrido em ms) ou C (contagem). */
  readWord(key) {
    switch (key[0]) {
      case 'I': return this.analog.get(key) ?? 0;
      case 'M': return this.words.get(key) ?? 0;
      case 'T': return Math.min(Math.round(this.timers.get(key)?.et ?? 0), INT_MAX);
      case 'C': return this.counters.get(key)?.cv ?? 0;
      default: return 0;
    }
  }

  /** Operando compilado: { key } (endereço) ou { value } (constante). */
  operand(op) {
    return op.key ? this.readWord(op.key) : op.value;
  }

  compare(cell) {
    return ELEMENTS[cell.type].test(this.operand(cell.in1), this.operand(cell.in2));
  }

  timer(key) {
    let t = this.timers.get(key);
    if (!t) { t = { type: null, pt: 0, et: 0, q: false }; this.timers.set(key, t); }
    return t;
  }

  counter(key) {
    let c = this.counters.get(key);
    if (!c) { c = { type: null, pv: 0, cv: 0, q: false, prevIn: false }; this.counters.set(key, c); }
    return c;
  }

  /**
   * Executa um ciclo. inputs = { 'I0.0': bool, 'IW0': número, … }; dt em ms. Retorna { 'Q0.0': bool, … }.
   * IW recebe o registrador de 16 bits da máquina, interpretado como INT (40000 → −25536).
   */
  scan(inputs, dt) {
    if (!this.compiled) throw new Error('Nenhum programa carregado.');
    for (const [k, v] of Object.entries(inputs)) {
      if (k[0] !== 'I') continue;
      if (k[1] === 'W') this.analog.set(k, toInt16(v));
      else this.bits.set(k, !!v);
    }
    const io = {
      read: (k) => this.read(k),
      edge: (cell, rising) => this.edge(cell, rising),
      compare: (cell) => this.compare(cell),
      execute: (cell, power) => this.execute(cell, power, dt),
    };
    const { cols, rungs } = this.compiled;
    this.trace = rungs.map((rung) => evaluateRung(rung, cols, io));
    this.scanCount++;
    this.elapsed += dt;
    return this.outputs();
  }

  outputs() {
    const out = {};
    for (const [k, v] of this.bits) if (k[0] === 'Q') out[k] = v;
    return out;
  }

  // Memória de borda por instrução, iniciando em 0 (como o R_TRIG/F_TRIG da IEC 61131-3).
  edge(cell, rising) {
    const v = this.read(cell.key);
    const prev = this.edges.get(cell) ?? false;
    this.edges.set(cell, v);
    return rising ? v && !prev : !v && prev;
  }

  execute(cell, power, dt) {
    const key = cell.key;
    switch (cell.type) {
      case 'COIL': this.bits.set(key, power); break;
      case 'NCOIL': this.bits.set(key, !power); break;
      case 'SET': if (power) this.bits.set(key, true); break;
      case 'RESET': if (power) this.reset(key); break;

      case 'TON': {
        const t = this.timer(key);
        t.type = 'TON';
        t.pt = cell.preset;
        if (power) {
          t.et = Math.min(t.et + dt, t.pt);
          t.q = t.et >= t.pt;
        } else {
          t.et = 0;
          t.q = false;
        }
        break;
      }
      case 'TOF': {
        const t = this.timer(key);
        t.type = 'TOF';
        t.pt = cell.preset;
        if (power) {
          t.q = true;
          t.et = 0;
        } else if (t.q) {
          t.et = Math.min(t.et + dt, t.pt);
          if (t.et >= t.pt) t.q = false;
        }
        break;
      }
      case 'CTU': {
        const c = this.counter(key);
        c.type = 'CTU';
        c.pv = cell.preset;
        if (power && !c.prevIn) c.cv = Math.min(c.cv + 1, COUNTER_MAX);
        c.prevIn = power;
        c.q = c.cv >= c.pv;
        break;
      }
      case 'CTD': {
        const c = this.counter(key);
        if (c.type !== 'CTD') { c.type = 'CTD'; c.cv = cell.preset; }
        c.pv = cell.preset;
        if (power && !c.prevIn) c.cv = Math.max(c.cv - 1, 0);
        c.prevIn = power;
        c.q = c.cv <= 0;
        break;
      }
      default: {
        const calc = ELEMENTS[cell.type]?.calc;
        if (!calc || !power) break;
        const r = calc(this.operand(cell.in1), cell.in2 ? this.operand(cell.in2) : 0);
        if (r === null) this.mathFaults++; // divisão por zero: o destino fica como estava
        else this.words.set(key, toInt16(r));
        break;
      }
    }
  }

  reset(key) {
    if (key[0] === 'T') {
      const t = this.timer(key);
      t.et = 0;
      t.q = false;
    } else if (key[0] === 'C') {
      const c = this.counter(key);
      c.cv = c.type === 'CTD' ? c.pv : 0;
      c.q = c.type === 'CTD' ? c.cv <= 0 : c.type === 'CTU' ? c.cv >= c.pv : false;
    } else {
      this.bits.set(key, false);
    }
  }
}
