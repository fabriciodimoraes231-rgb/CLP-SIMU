// Endereçamento do CLP simulado.
//  Bits ........ I (entradas), Q (saídas), M (memórias) → "I0.0" (byte 0–15, bit 0–7)
//  Palavras .... MW0–MW63 (memórias de 16 bits) · IW0–IW15 (entradas analógicas da máquina)
//  Temporizadores T0–T31 · Contadores C0–C31
// O prefixo IEC "%" é aceito e removido ("%I0.0" → "I0.0").
//
// As palavras são INT da IEC 61131-3 (16 bits com sinal, −32768 a 32767) e são independentes
// dos bits: MW0 não se sobrepõe a M0.0–M1.7 (mesmo critério do OpenPLC para %MW e %MX).

export const MAX_BYTE = 15;
export const MAX_TC = 31;
export const MAX_MW = 63;
export const MAX_IW = 15;
export const INT_MIN = -32_768;
export const INT_MAX = 32_767;

const BIT_RE = /^%?([IQM])(\d{1,2})\.(\d)$/;
const TC_RE = /^%?([TC])(\d{1,2})$/;
const WORD_RE = /^%?([IM]W)(\d{1,2})$/;
const INT_RE = /^[+-]?\d{1,6}$/;
const WORD_MAX = { MW: MAX_MW, IW: MAX_IW };

/** Áreas cujo valor pode ser lido como número: palavras, tempo decorrido (T, em ms) e contagem (C). */
export const WORD_READABLE = ['IW', 'MW', 'T', 'C'];

export function parseAddress(text) {
  if (typeof text !== 'string') return null;
  const s = text.trim().toUpperCase();
  let m = BIT_RE.exec(s);
  if (m) {
    const byte = Number(m[2]);
    const bit = Number(m[3]);
    if (byte > MAX_BYTE || bit > 7) return null;
    return { area: m[1], byte, bit, key: `${m[1]}${byte}.${bit}` };
  }
  m = TC_RE.exec(s);
  if (m) {
    const index = Number(m[2]);
    if (index > MAX_TC) return null;
    return { area: m[1], index, key: `${m[1]}${index}` };
  }
  m = WORD_RE.exec(s);
  if (m) {
    const index = Number(m[2]);
    if (index > WORD_MAX[m[1]]) return null;
    return { area: m[1], index, word: true, key: `${m[1]}${index}` };
  }
  return null;
}

export function normalizeAddress(text) {
  return parseAddress(text)?.key ?? null;
}

/**
 * Operando numérico: constante inteira (INT) ou endereço.
 * Retorna { value } para constante, o objeto de parseAddress para endereço, ou null.
 */
export function parseOperand(text) {
  if (typeof text !== 'string') return null;
  const s = text.trim();
  if (INT_RE.test(s)) {
    const value = Number(s);
    return value >= INT_MIN && value <= INT_MAX ? { value, key: null } : null;
  }
  return parseAddress(s);
}

/** Converte para INT de 16 bits com estouro circular, como num CLP real (32767 + 1 = −32768). */
export const toInt16 = (v) => (Math.trunc(Number(v) || 0) << 16) >> 16;

const AREA_ORDER = { I: 0, Q: 1, M: 2, IW: 3, MW: 4, T: 5, C: 6 };

/** Ordena endereços por área e depois numericamente (I0.0, I0.1 … Q0.0 … IW0 … MW0 … T0, T1 …). */
export function compareAddress(a, b) {
  const pa = parseAddress(a);
  const pb = parseAddress(b);
  if (!pa || !pb) return String(a).localeCompare(String(b));
  if (pa.area !== pb.area) return AREA_ORDER[pa.area] - AREA_ORDER[pb.area];
  if ('index' in pa) return pa.index - pb.index;
  return pa.byte - pb.byte || pa.bit - pb.bit;
}
