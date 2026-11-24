// Avaliação de um degrau (fluxo de energia da esquerda para a direita).
//
// O degrau é uma grade de células. O nó (r, c) fica na borda esquerda da célula (r, c).
// O nó da coluna 0 é o trilho esquerdo (sempre energizado). Cada célula liga o nó (r, c)
// ao nó (r, c+1). As ligações verticais unem nós da mesma coluna em linhas vizinhas:
// o grupo inteiro recebe o OU lógico das energias que chegam a ele.
// A última coluna recebe as saídas (bobinas e blocos), executadas depois que toda a
// lógica do degrau foi resolvida.

import { isCompare } from './elements.js';

/** Une (OU) a energia dos nós ligados verticalmente na coluna c. Altera `power`. */
export function mergeVertical(power, vlinks, c) {
  const rows = power.length;
  let start = 0;
  for (let r = 0; r < rows; r++) {
    if (r < rows - 1 && vlinks[r][c]) continue; // o grupo continua na linha de baixo
    if (r > start) {
      let v = false;
      for (let i = start; i <= r; i++) v = v || power[i];
      for (let i = start; i <= r; i++) power[i] = v;
    }
    start = r + 1;
  }
}

function conducts(cell, io) {
  switch (cell.type) {
    case 'WIRE': return true;
    case 'NO': return io.read(cell.key);
    case 'NC': return !io.read(cell.key);
    // A memória de borda é atualizada em TODO ciclo, com ou sem energia no degrau.
    case 'P': return io.edge(cell, true);
    case 'N': return io.edge(cell, false);
    default: return isCompare(cell.type) ? io.compare(cell) : false;
  }
}

/**
 * Executa um degrau compilado.
 * io = { read(key) → bool, edge(cell, rising) → bool, compare(cell) → bool, execute(cell, power) }
 * Retorna o rastro para a animação: nodes[r][c] (energia no nó), outs[r][c] (energia na
 * saída da célula) e closed[r][c] (o contato está fechado, independente da energia).
 */
export function evaluateRung(rung, cols, io) {
  const rows = rung.cells.length;
  const nodes = [];
  const outs = [];
  const closed = [];
  for (let r = 0; r < rows; r++) {
    nodes.push(new Array(cols).fill(false));
    outs.push(new Array(cols).fill(false));
    closed.push(new Array(cols).fill(false));
  }

  let power = new Array(rows).fill(true); // trilho esquerdo
  for (let c = 0; c < cols; c++) {
    if (c > 0) mergeVertical(power, rung.vlinks, c);
    for (let r = 0; r < rows; r++) nodes[r][c] = power[r];
    if (c === cols - 1) break;
    const next = new Array(rows);
    for (let r = 0; r < rows; r++) {
      const cell = rung.cells[r][c];
      const pass = cell ? conducts(cell, io) : false;
      closed[r][c] = pass;
      next[r] = power[r] && pass;
      outs[r][c] = next[r];
    }
    power = next;
  }

  const oc = cols - 1;
  for (let r = 0; r < rows; r++) {
    const cell = rung.cells[r][oc];
    if (cell) {
      io.execute(cell, power[r]);
      outs[r][oc] = power[r];
    }
  }
  return { nodes, outs, closed };
}
