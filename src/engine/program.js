// Modelo do programa ladder, validação/compilação e utilitários de edição.
//
// Estrutura (é também o formato do arquivo exportado):
//   program = { version: 1, cols, symbols: { 'M0.0': 'NOME' }, rungs: [rung] }
//   rung    = { comment, cells: cell|null [linhas][cols], vlinks: bool [linhas][cols] }
//   cell    = { type: 'NO', addr: 'I0.0', preset?: 500 }
//             { type: 'GE', in1: 'IW1', in2: '600' }            comparação
//             { type: 'ADD', in1: 'MW0', in2: '1', addr: 'MW0' } aritmética (addr = destino)
//
// vlinks[r][c] = ligação vertical no nó da coluna c (borda esquerda da célula c),
// unindo a linha r à linha r+1. Só valem c ≥ 1 e r < linhas-1.

import { ELEMENTS, OPERAND_LABEL } from './elements.js';
import { parseAddress, parseOperand, normalizeAddress, WORD_READABLE } from './address.js';

export const DEFAULT_COLS = 7;
export const MAX_ROWS = 6;
export const MAX_RUNGS = 200;

const grid = (rows, cols, value) => Array.from({ length: rows }, () => new Array(cols).fill(value));

export function createRung(cols, rows = 1, comment = '') {
  return { comment, cells: grid(rows, cols, null), vlinks: grid(rows, cols, false) };
}

export function createProgram(cols = DEFAULT_COLS) {
  return { version: 1, cols, symbols: {}, rungs: [createRung(cols)] };
}

export function addRow(rung, cols) {
  if (rung.cells.length >= MAX_ROWS) return false;
  rung.cells.push(new Array(cols).fill(null));
  rung.vlinks.push(new Array(cols).fill(false));
  return true;
}

export function removeLastRow(rung) {
  if (rung.cells.length <= 1) return false;
  rung.cells.pop();
  rung.vlinks.pop();
  rung.vlinks[rung.vlinks.length - 1].fill(false); // não há mais linha abaixo
  return true;
}

export const rowIsEmpty = (rung, r) => rung.cells[r].every((c) => !c);
export const rungIsEmpty = (rung) => rung.cells.every((row) => row.every((c) => !c));

/**
 * Completa com fios a linha r até a bobina/bloco da última coluna.
 * Linha com condições: preenche depois do último elemento.
 * Linha só com saída (ramo de saída paralela): preenche a partir da ligação vertical mais à direita.
 */
export function autoWire(rung, r, cols) {
  const row = rung.cells[r];
  const last = row[cols - 1];
  if (!last || ELEMENTS[last.type]?.kind !== 'output') return;
  let start = -1;
  for (let c = cols - 2; c >= 0; c--) {
    if (row[c]) { start = c + 1; break; }
  }
  if (start < 0) {
    for (let c = cols - 1; c >= 1; c--) {
      if ((r > 0 && rung.vlinks[r - 1][c]) || rung.vlinks[r][c]) { start = c; break; }
    }
  }
  if (start < 0) return;
  for (let c = start; c <= cols - 2; c++) if (!row[c]) row[c] = { type: 'WIRE' };
}

/** Endereços (normalizados) usados pelas células do programa. */
export function programAddresses(program) {
  const keys = new Set();
  for (const rung of program.rungs) {
    for (const row of rung.cells) {
      for (const cell of row) {
        if (!cell) continue;
        for (const f of ['addr', 'in1', 'in2']) {
          const key = typeof cell[f] === 'string' && normalizeAddress(cell[f]);
          if (key) keys.add(key);
        }
      }
    }
  }
  return keys;
}

/**
 * Valida e compila o programa para execução.
 * Retorna { errors: [{ rung, row, col, message }], compiled } — compiled é null se houver erro.
 */
export function compileProgram(program) {
  const errors = [];
  const cols = program.cols;
  const blockUse = new Map(); // 'T0' → [{rung,row,col}] (mesmo T/C em dois blocos é erro)

  const rungs = program.rungs.map((rung, ri) => {
    const cells = rung.cells.map((row, r) => row.map((cell, c) => {
      if (!cell) return null;
      const at = { rung: ri, row: r, col: c };
      const def = ELEMENTS[cell.type];
      if (!def) {
        errors.push({ ...at, message: `Elemento desconhecido "${cell.type}".` });
        return null;
      }
      const outCol = c === cols - 1;
      if (def.kind === 'output' && !outCol) {
        errors.push({ ...at, message: `${def.label} deve ficar na última coluna (saídas).` });
      }
      if (def.kind !== 'output' && outCol) {
        errors.push({ ...at, message: `${def.label} não pode ficar na coluna de saídas.` });
      }
      const out = { type: cell.type };
      if (def.operands) {
        for (const f of def.operands) {
          const raw = cell[f] ?? '';
          const op = parseOperand(raw);
          const name = OPERAND_LABEL[f];
          if (!op) {
            errors.push({ ...at, message: `Operando ${name} inválido "${raw}". Use um inteiro de −32768 a 32767 ou IW0, MW0, T0, C0.` });
          } else if (op.key && !WORD_READABLE.includes(op.area)) {
            errors.push({ ...at, message: `Operando ${name}: ${op.key} é um bit. Use uma constante ou IW, MW, T, C.` });
          } else {
            out[f] = op.key ? { key: op.key } : { value: op.value };
          }
        }
        if ((cell.type === 'DIV' || cell.type === 'MOD') && out.in2?.value === 0) {
          errors.push({ ...at, message: 'Divisão por zero: B não pode ser a constante 0.' });
        }
      }
      if (def.areas) {
        const a = parseAddress(cell.addr ?? '');
        if (!a) {
          errors.push({ ...at, message: def.operands
            ? `Destino inválido "${cell.addr ?? ''}". Use uma memória de palavra, de MW0 a MW63.`
            : `Endereço inválido "${cell.addr ?? ''}". Exemplos: I0.0, Q0.1, M2.3, T0, C1.` });
        } else if (!def.areas.includes(a.area)) {
          errors.push({ ...at, message: `${def.label} não aceita ${a.key}. Áreas permitidas: ${def.areas.join(', ')}.` });
        } else {
          out.key = a.key;
          if (def.preset) {
            if (!blockUse.has(a.key)) blockUse.set(a.key, []);
            blockUse.get(a.key).push(at);
          }
        }
      }
      if (def.preset) {
        const p = Number(cell.preset);
        if (!Number.isInteger(p) || p < def.preset.min || p > def.preset.max) {
          errors.push({ ...at, message: `${def.preset.label} inválido: use um inteiro entre ${def.preset.min} e ${def.preset.max}.` });
        } else {
          out.preset = p;
        }
      }
      return out;
    }));
    return { cells, vlinks: rung.vlinks.map((row) => row.slice()) };
  });

  for (const [key, uses] of blockUse) {
    if (uses.length > 1) {
      for (const at of uses) errors.push({ ...at, message: `${key} é usado em mais de um bloco. Cada temporizador/contador deve ter um único bloco.` });
    }
  }

  return { errors, compiled: errors.length ? null : { cols, rungs } };
}

/**
 * Valida a estrutura de um programa vindo de arquivo/armazenamento.
 * Retorna um programa limpo ou null se o formato for irreconhecível.
 */
export function normalizeProgram(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.rungs)) return null;
  const cols = raw.cols;
  if (!Number.isInteger(cols) || cols < 3 || cols > 12) return null;

  const symbols = {};
  if (raw.symbols && typeof raw.symbols === 'object') {
    for (const [k, v] of Object.entries(raw.symbols)) {
      const key = normalizeAddress(k);
      if (key && typeof v === 'string' && v.trim()) symbols[key] = v.trim().slice(0, 32);
    }
  }

  const rungs = [];
  for (const src of raw.rungs.slice(0, MAX_RUNGS)) {
    if (!src || !Array.isArray(src.cells) || src.cells.length < 1) return null;
    const rows = Math.min(src.cells.length, MAX_ROWS);
    const comment = typeof src.comment === 'string' ? src.comment.slice(0, 200) : '';
    const rung = createRung(cols, rows, comment);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cell = src.cells[r]?.[c];
        if (cell && typeof cell === 'object' && Object.hasOwn(ELEMENTS, cell.type)) {
          const out = { type: cell.type };
          for (const f of ['addr', 'in1', 'in2']) {
            if (typeof cell[f] === 'string') out[f] = cell[f].slice(0, 12);
          }
          if (cell.preset !== undefined) out.preset = Number(cell.preset);
          rung.cells[r][c] = out;
        }
        rung.vlinks[r][c] = r < rows - 1 && c >= 1 && src.vlinks?.[r]?.[c] === true;
      }
    }
    rungs.push(rung);
  }
  if (!rungs.length) rungs.push(createRung(cols));
  return { version: 1, cols, symbols, rungs };
}

// ---------------------------------------------------------------------------
// Construtor compacto, usado nos programas de exemplo e nos testes.
//   '.' ou ''      → célula vazia
//   '-'            → fio
//   'NO I0.0'      → contato NA em I0.0
//   'TON T0 500'   → temporizador com PT = 500 ms
//   'GE IW1 600'   → comparação IW1 >= 600
//   'ADD MW0 1 MW0'→ MW0 := MW0 + 1 (operandos e, por último, o destino)
//   'MOVE 0 MW0'   → MW0 := 0
// ---------------------------------------------------------------------------

export function cellFromToken(token) {
  if (token == null || token === '.' || token === '') return null;
  if (token === '-') return { type: 'WIRE' };
  const [type, ...args] = token.trim().split(/\s+/);
  if (!Object.hasOwn(ELEMENTS, type)) throw new Error(`Elemento desconhecido: ${type}`);
  const def = ELEMENTS[type];
  if (def.operands) {
    const cell = { type };
    def.operands.forEach((f, i) => { if (args[i] !== undefined) cell[f] = args[i]; });
    if (def.areas && args[def.operands.length] !== undefined) cell.addr = args[def.operands.length];
    return cell;
  }
  const [addr, preset] = args;
  const cell = { type };
  if (addr !== undefined) cell.addr = addr;
  if (preset !== undefined) cell.preset = Number(preset);
  return cell;
}

export function buildRung(cols, comment, rows, links = []) {
  const rung = createRung(cols, rows.length, comment);
  rows.forEach((row, r) => {
    if (row.length !== cols) throw new Error(`Degrau "${comment}": a linha ${r + 1} tem ${row.length} células, esperado ${cols}.`);
    row.forEach((token, c) => { rung.cells[r][c] = cellFromToken(token); });
  });
  for (const [r, c] of links) rung.vlinks[r][c] = true;
  return rung;
}

export function buildProgram({ cols = DEFAULT_COLS, symbols = {}, rungs }) {
  return {
    version: 1,
    cols,
    symbols: { ...symbols },
    rungs: rungs.map(([comment, rows, links]) => buildRung(cols, comment, rows, links)),
  };
}
