// Mapa de E/S para integração com software externo (Modbus TCP).
// Compartilhado pelo navegador, pelo servidor e pelas ferramentas de linha de comando (sem DOM).
//
//   Entradas I0.0–I15.7  → entradas discretas (FC 2) 0–127   · referência 10001–10128
//   Saídas   Q0.0–Q15.7  → coils (FC 1, 5, 15)       0–127   · referência 00001–00128
//   Analógicos da máquina → registradores de entrada (FC 4) 0–15 · referência 30001–30016
//   Memórias MW0–MW63     → registradores holding (FC 3, 6, 16) 0–63 · referência 40001–40064
//                           (só no modo "CLP interno + servidor Modbus", para o supervisório)

import { MAX_BYTE, MAX_MW, parseAddress, toInt16 } from './address.js';

export const AREA_BYTES = MAX_BYTE + 1;   // 16 bytes por área
export const AREA_BITS = AREA_BYTES * 8;  // 128 pontos
export const ANALOG_REGS = 16;
export const HOLDING_REGS = MAX_MW + 1;   // 64

/** Índice Modbus (0-based) de um bit I/Q: byte*8 + bit. */
export function bitIndex(key) {
  const a = parseAddress(key);
  if (!a || (a.area !== 'I' && a.area !== 'Q')) return -1;
  return a.byte * 8 + a.bit;
}

/** Endereço do CLP Simu a partir do índice Modbus: ('Q', 9) → 'Q1.1'. */
export const keyFromIndex = (area, index) => `${area}${index >> 3}.${index & 7}`;

/** { 'I0.2': true, … } → 16 bytes (bit 0 do byte 0 = I0.0). Outras áreas são ignoradas. */
export function packArea(values, area) {
  const bytes = new Array(AREA_BYTES).fill(0);
  for (const [k, v] of Object.entries(values ?? {})) {
    if (!v || k[0] !== area) continue;
    const i = bitIndex(k);
    if (i >= 0) bytes[i >> 3] |= 1 << (i & 7);
  }
  return bytes;
}

/** 16 bytes → { 'Q0.0': true, … } só com os bits ligados. */
export function unpackArea(bytes, area) {
  const out = {};
  for (let i = 0; i < AREA_BITS; i++) {
    if ((bytes?.[i >> 3] ?? 0) & (1 << (i & 7))) out[keyFromIndex(area, i)] = true;
  }
  return out;
}

/** Bytes válidos (0–255, inteiros) ou null — para validar mensagens vindas da rede. */
export function sanitizeBytes(arr, length = AREA_BYTES) {
  if (!Array.isArray(arr) || arr.length > length) return null;
  const out = new Array(length).fill(0);
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    out[i] = v;
  }
  return out;
}

/** Valor de engenharia → registrador de 16 bits (escala inteira, saturado em 0–65535). */
export const toRegister = (value, scale = 1) => Math.max(0, Math.min(65535, Math.round(Number(value) * scale) || 0));

/** MW do CLP → registradores de 16 bits (INT negativo em complemento de dois: −1 → 65535). */
export function wordsToRegisters(words) {
  return Array.from({ length: HOLDING_REGS }, (_, i) => (words.get(`MW${i}`) ?? 0) & 0xffff);
}

/**
 * Aplica nas MW uma escrita vinda do supervisório: { start, values } (registradores de 16 bits).
 * Retorna [{ key, value }] com o que foi gravado (valor já como INT), ou null se a mensagem for inválida.
 */
export function applyHoldingWrite(words, msg) {
  const { start, values } = msg ?? {};
  if (!Number.isInteger(start) || start < 0 || !Array.isArray(values) || !values.length) return null;
  if (start + values.length > HOLDING_REGS) return null;
  if (!values.every((v) => Number.isInteger(v) && v >= 0 && v <= 0xffff)) return null;
  return values.map((v, i) => {
    const key = `MW${start + i}`;
    const value = toInt16(v);
    words.set(key, value);
    return { key, value };
  });
}

const TABLES = {
  DI: { name: 'Entrada discreta', base: 10001 },
  COIL: { name: 'Coil', base: 1 },
  IR: { name: 'Registrador de entrada', base: 30001 },
  HR: { name: 'Registrador holding', base: 40001 },
};

/** Referência no estilo Modicon (1-based, 5 dígitos): ('DI', 3) → '10004', ('COIL', 0) → '00001'. */
export const modbusRef = (table, index) => String(TABLES[table].base + index).padStart(5, '0');

/**
 * Mapa Modbus de uma máquina, na ordem de exibição.
 * words = [{ addr: 'MW1', symbol, desc }] acrescenta os registradores holding (modo servidor).
 */
export function machineModbusMap(machine, words = []) {
  const row = (table, index, io, unit) => ({
    table, index, ref: modbusRef(table, index), addr: io.addr ?? null,
    symbol: io.symbol, desc: io.desc ?? '', unit,
  });
  return [
    ...machine.inputs.map((io) => row('DI', bitIndex(io.addr), io)),
    ...machine.outputs.map((io) => row('COIL', bitIndex(io.addr), io)),
    ...(machine.analogs ?? []).map((a) => row('IR', a.reg, { ...a, addr: `IW${a.reg}` }, a.unit)),
    ...words.map((w) => row('HR', parseAddress(w.addr).index, w)),
  ];
}
