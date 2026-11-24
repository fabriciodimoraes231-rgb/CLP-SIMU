// Editor ladder em grade (SVG), com paleta, painel de propriedades e animação em RUN.

import {
  ELEMENTS, DEFAULT_ADDR, DEFAULT_OPERANDS, OPERAND_LABEL, isBlock, isCompare, hasOperands, cellFields,
} from '../engine/elements.js';
import { parseAddress, parseOperand, MAX_TC, WORD_READABLE } from '../engine/address.js';
import {
  addRow, removeLastRow, createRung, autoWire, compileProgram, rowIsEmpty, rungIsEmpty,
  MAX_ROWS, MAX_RUNGS,
} from '../engine/program.js';
import { esc, trunc, fmtTime, fmtTimePair } from './util.js';

const CW = 92;  // largura da célula
const RH = 72;  // altura da linha
const X0 = 20;  // trilho esquerdo
const TOP = 4;
const cellX = (c) => X0 + c * CW;
const rowTop = (r) => TOP + r * RH;
const rowY = (r) => rowTop(r) + 38;

const GROUPS = [
  ['Edição', ['select', 'erase', 'WIRE', 'VLINK']],
  ['Contatos', ['NO', 'NC', 'P', 'N']],
  ['Saídas', ['COIL', 'NCOIL', 'SET', 'RESET']],
  ['Blocos', ['TON', 'TOF', 'CTU', 'CTD']],
  ['Comparação', ['EQ', 'NE', 'GT', 'GE', 'LT', 'LE']],
  ['Aritmética', ['MOVE', 'ADD', 'SUB', 'MUL', 'DIV', 'MOD']],
];

/** Áreas cujo símbolo pode ser editado no programa (I, Q e IW vêm da máquina). */
const SYMBOL_AREAS = ['M', 'MW', 'T', 'C'];

const TOOL_INFO = {
  select: ['Selecionar', 'Selecionar uma célula para editar (Esc)'],
  erase: ['Apagar', 'Apagar o elemento da célula clicada (Delete)'],
  WIRE: ['Fio', 'Fio horizontal'],
  VLINK: ['Ligação', 'Ligação vertical entre linhas: clique nos pontos de junção'],
  NO: ['NA', 'Contato normalmente aberto'],
  NC: ['NF', 'Contato normalmente fechado'],
  P: ['Borda ↑', 'Contato de borda de subida'],
  N: ['Borda ↓', 'Contato de borda de descida'],
  COIL: ['Bobina', 'Bobina de saída'],
  NCOIL: ['Negada', 'Bobina negada'],
  SET: ['Set', 'Bobina Set (liga e mantém)'],
  RESET: ['Reset', 'Bobina Reset (desliga / zera T e C)'],
  TON: ['TON', 'Temporizador com atraso na energização'],
  TOF: ['TOF', 'Temporizador com atraso na desenergização'],
  CTU: ['CTU', 'Contador crescente'],
  CTD: ['CTD', 'Contador decrescente'],
  EQ: ['A = B', 'Comparação: conduz se A for igual a B'],
  NE: ['A <> B', 'Comparação: conduz se A for diferente de B'],
  GT: ['A > B', 'Comparação: conduz se A for maior que B'],
  GE: ['A >= B', 'Comparação: conduz se A for maior ou igual a B'],
  LT: ['A < B', 'Comparação: conduz se A for menor que B'],
  LE: ['A <= B', 'Comparação: conduz se A for menor ou igual a B'],
  MOVE: ['MOVE', 'Copia A para uma memória de palavra (MW)'],
  ADD: ['ADD', 'Soma: MW := A + B'],
  SUB: ['SUB', 'Subtração: MW := A − B'],
  MUL: ['MUL', 'Multiplicação: MW := A × B'],
  DIV: ['DIV', 'Divisão inteira: MW := A ÷ B'],
  MOD: ['MOD', 'Resto da divisão: MW := A mod B'],
};

function toolIcon(id) {
  const L = (x1, y1, x2, y2) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
  const T = (s, x = 20, size = 8) => `<text x="${x}" y="15" font-size="${size}">${s}</text>`;
  let body = '';
  switch (id) {
    case 'select': body = '<path class="fill" d="M14 3 L14 20 L18 16 L21 22 L24 21 L21 15 L27 15 Z"/>'; break;
    case 'erase': body = L(13, 5, 27, 19) + L(27, 5, 13, 19); break;
    case 'WIRE': body = L(4, 12, 36, 12); break;
    case 'VLINK': body = L(4, 6, 36, 6) + L(20, 6, 20, 18) + L(4, 18, 36, 18) + '<circle class="fill" cx="20" cy="6" r="2"/><circle class="fill" cx="20" cy="18" r="2"/>'; break;
    case 'NO': case 'NC': case 'P': case 'N':
      body = L(2, 12, 15, 12) + L(15, 4, 15, 20) + L(25, 4, 25, 20) + L(25, 12, 38, 12);
      if (id === 'NC') body += L(17, 18, 23, 6);
      if (id === 'P' || id === 'N') body += T(id);
      break;
    case 'COIL': case 'NCOIL': case 'SET': case 'RESET':
      body = L(2, 12, 12, 12) + '<path d="M16 4 Q10 12 16 20"/><path d="M24 4 Q30 12 24 20"/>' + L(28, 12, 38, 12);
      if (id !== 'COIL') body += T({ NCOIL: '/', SET: 'S', RESET: 'R' }[id]);
      break;
    default:
      body = '<rect x="7" y="3" width="26" height="18" rx="2"/>'
        + (isCompare(id) ? L(2, 12, 7, 12) + L(33, 12, 38, 12) + T(esc(ELEMENTS[id].sym), 20, 9) : T(id, 20, 7.5));
  }
  return `<svg class="ticon" viewBox="0 0 40 24" width="40" height="24" aria-hidden="true">${body}</svg>`;
}

export class LadderEditor {
  /**
   * hooks: {
   *   symbol(key) → string            símbolo para mostrar abaixo do endereço
   *   describe(key) → { symbol, desc, fixed } | null
   *   onChange(errors)                programa alterado (já validado)
   *   notify(msg)                     mensagem curta ao usuário
   * }
   */
  constructor({ root, props, palette }, hooks) {
    this.root = root;
    this.propsEl = props;
    this.paletteEl = palette;
    this.hooks = hooks;
    this.program = null;
    this.tool = 'select';
    this.selection = null;
    this.errors = [];
    this.running = false;
    this.plc = null;

    this.renderPalette();
    palette.addEventListener('click', (e) => {
      const b = e.target.closest('[data-tool]');
      if (b && !this.running) this.setTool(b.dataset.tool);
    });
    root.addEventListener('click', (e) => this.onClick(e));
    root.addEventListener('input', (e) => this.onInput(e));
    document.addEventListener('keydown', (e) => this.onKey(e));
  }

  // -------------------------------------------------------------------------
  // API pública
  // -------------------------------------------------------------------------

  setProgram(program) {
    this.program = program;
    this.selection = null;
    this.errors = compileProgram(program).errors;
    this.render();
    this.renderProps();
  }

  setErrors(errors) {
    this.errors = errors;
    this.refreshSvgs();
  }

  setRunning(running, plc = null) {
    this.running = running;
    this.plc = plc;
    this.root.classList.toggle('running', running);
    this.paletteEl.classList.toggle('disabled', running);
    this.paletteEl.querySelectorAll('button').forEach((b) => { b.disabled = running; });
    this.render();
    this.renderProps();
  }

  setTool(tool) {
    this.tool = tool;
    this.paletteEl.querySelectorAll('[data-tool]').forEach((b) => {
      const on = b.dataset.tool === tool;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    this.root.dataset.tool = tool;
    this.refreshSvgs();
  }

  select(ri, r, c, { focus = false } = {}) {
    this.selection = { ri, r, c };
    this.refreshSvgs();
    this.renderProps({ focus });
  }

  /** Atualiza só os desenhos (usado a cada quadro em RUN). */
  refreshSvgs() {
    if (!this.program) return;
    this.root.querySelectorAll('[data-svg]').forEach((el) => {
      const ri = Number(el.dataset.svg);
      const rung = this.program.rungs[ri];
      if (rung) el.innerHTML = this.svgFor(rung, ri);
    });
  }

  // -------------------------------------------------------------------------
  // Paleta
  // -------------------------------------------------------------------------

  renderPalette() {
    this.paletteEl.innerHTML = GROUPS.map(([title, tools]) => `
      <div class="pal-group" role="group" aria-label="${esc(title)}">
        <span class="pal-title">${esc(title)}</span>
        <div class="pal-tools">
          ${tools.map((t) => `
            <button type="button" class="tool${t === this.tool ? ' active' : ''}" data-tool="${t}"
              title="${esc(TOOL_INFO[t][1])}" aria-pressed="${t === this.tool}">
              ${toolIcon(t)}<span>${esc(TOOL_INFO[t][0])}</span>
            </button>`).join('')}
        </div>
      </div>`).join('');
  }

  // -------------------------------------------------------------------------
  // Degraus
  // -------------------------------------------------------------------------

  render() {
    const p = this.program;
    if (!p) return;
    this.inline = null; // o campo flutuante some junto com o HTML antigo
    const dis = this.running ? 'disabled' : '';
    this.root.dataset.tool = this.tool;
    this.root.innerHTML = p.rungs.map((rung, ri) => `
      <article class="rung" data-ri="${ri}">
        <header class="rung-head">
          <span class="rung-no" title="Degrau ${ri + 1}">${ri + 1}</span>
          <input class="rung-comment" data-ri="${ri}" value="${esc(rung.comment)}" maxlength="200"
            placeholder="Comentário do degrau" aria-label="Comentário do degrau ${ri + 1}" ${this.running ? 'readonly' : ''}>
          <div class="rung-tools">
            <button type="button" data-act="row-add" data-ri="${ri}" title="Adicionar linha (ramo paralelo)" ${dis}>+ linha</button>
            <button type="button" data-act="row-del" data-ri="${ri}" title="Remover a última linha" ${dis}>− linha</button>
            <button type="button" data-act="up" data-ri="${ri}" title="Mover para cima" aria-label="Mover degrau para cima" ${dis}>↑</button>
            <button type="button" data-act="down" data-ri="${ri}" title="Mover para baixo" aria-label="Mover degrau para baixo" ${dis}>↓</button>
            <button type="button" data-act="dup" data-ri="${ri}" title="Duplicar degrau" aria-label="Duplicar degrau" ${dis}>⧉</button>
            <button type="button" data-act="del" data-ri="${ri}" class="danger" title="Excluir degrau" aria-label="Excluir degrau" ${dis}>✕</button>
          </div>
        </header>
        <div class="rung-body"><div data-svg="${ri}">${this.svgFor(rung, ri)}</div></div>
      </article>`).join('')
      + (this.running ? '' : '<button type="button" class="btn add-rung" data-act="add-rung">+ Adicionar degrau</button>');
  }

  svgFor(rung, ri) {
    const cols = this.program.cols;
    const rows = rung.cells.length;
    const W = cellX(cols) + X0;
    const H = TOP * 2 + rows * RH;
    const tr = this.running && this.plc ? this.plc.trace[ri] : null;
    const p = [];

    p.push(`<rect class="outcol" x="${cellX(cols - 1)}" y="0" width="${CW}" height="${H}"/>`);
    for (const e of this.errors) {
      if (e.rung === ri) p.push(`<rect class="cell-err" x="${cellX(e.col) + 2}" y="${rowTop(e.row) + 2}" width="${CW - 4}" height="${RH - 4}" rx="6"/>`);
    }
    const sel = this.selection;
    if (!tr && sel && sel.ri === ri) {
      p.push(`<rect class="cell-sel" x="${cellX(sel.c) + 2}" y="${rowTop(sel.r) + 2}" width="${CW - 4}" height="${RH - 4}" rx="6"/>`);
    }

    p.push(`<line class="rail${tr ? ' on' : ''}" x1="${X0}" y1="${TOP}" x2="${X0}" y2="${H - TOP}"/>`);
    p.push(`<line class="rail" x1="${cellX(cols)}" y1="${TOP}" x2="${cellX(cols)}" y2="${H - TOP}"/>`);

    for (let r = 0; r < rows - 1; r++) {
      for (let c = 1; c < cols; c++) {
        if (!rung.vlinks[r][c]) continue;
        const on = tr ? tr.nodes[r][c] : false;
        const x = cellX(c);
        p.push(`<line class="w${on ? ' on' : ''}" x1="${x}" y1="${rowY(r)}" x2="${x}" y2="${rowY(r + 1)}"/>`);
        p.push(`<circle class="dot${on ? ' on' : ''}" cx="${x}" cy="${rowY(r)}" r="3"/><circle class="dot${on ? ' on' : ''}" cx="${x}" cy="${rowY(r + 1)}" r="3"/>`);
      }
    }

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cell = rung.cells[r][c];
        if (cell) p.push(this.cellSvg(cell, r, c, tr));
      }
    }

    if (!tr) {
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          p.push(`<rect class="hit" data-r="${r}" data-c="${c}" x="${cellX(c)}" y="${rowTop(r)}" width="${CW}" height="${RH}"/>`);
        }
      }
      if (this.tool === 'VLINK') {
        for (let r = 0; r < rows - 1; r++) {
          for (let c = 1; c < cols; c++) {
            const y = (rowY(r) + rowY(r + 1)) / 2;
            p.push(`<circle class="vh${rung.vlinks[r][c] ? ' on' : ''}" data-vr="${r}" data-vc="${c}" cx="${cellX(c)}" cy="${y}" r="8"><title>Ligar/desligar a junção entre as linhas ${r + 1} e ${r + 2}</title></circle>`);
          }
        }
      }
    }

    return `<svg class="rung-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Diagrama do degrau ${ri + 1}">${p.join('')}</svg>`;
  }

  cellSvg(cell, r, c, tr) {
    const def = ELEMENTS[cell.type];
    if (!def) return '';
    if (hasOperands(cell.type)) return this.numericSvg(cell, def, r, c, tr);
    const x0 = cellX(c);
    const x1 = x0 + CW;
    const cx = x0 + CW / 2;
    const y = rowY(r);
    const pin = tr ? tr.nodes[r][c] : false;
    const pout = tr ? tr.outs[r][c] : false;
    const w = (on) => `w${on ? ' on' : ''}`;
    const info = parseAddress(cell.addr ?? '');
    const sym = info ? this.hooks.symbol(info.key) : '';
    const addrTxt = cell.addr ? cell.addr.toUpperCase() : '?';
    const bitLed = tr && info ? `<circle class="bitled${this.plc.read(info.key) ? ' on' : ''}" cx="${cx + 30}" cy="${y - 22}" r="3.5"/>` : '';
    const labels = `<text class="lbl-addr" x="${cx}" y="${y - 18}">${esc(addrTxt)}</text>`
      + (sym ? `<text class="lbl-sym" x="${cx}" y="${y + 28}">${esc(trunc(sym, 14))}</text>` : '')
      + bitLed;

    if (def.kind === 'wire') {
      return `<line class="${w(pout)}" x1="${x0}" y1="${y}" x2="${x1}" y2="${y}"/>`;
    }

    if (def.kind === 'contact') {
      const closed = tr ? tr.closed[r][c] : false;
      const b = `cb${closed ? ' on' : ''}`;
      let s = `<line class="${w(pin)}" x1="${x0}" y1="${y}" x2="${cx - 8}" y2="${y}"/>`
        + `<line class="${w(pout)}" x1="${cx + 8}" y1="${y}" x2="${x1}" y2="${y}"/>`;
      if (closed) s += `<rect class="cfill" x="${cx - 8}" y="${y - 12}" width="16" height="24"/>`;
      s += `<line class="${b}" x1="${cx - 8}" y1="${y - 12}" x2="${cx - 8}" y2="${y + 12}"/>`
        + `<line class="${b}" x1="${cx + 8}" y1="${y - 12}" x2="${cx + 8}" y2="${y + 12}"/>`;
      if (cell.type === 'NC') s += `<line class="${b}" x1="${cx - 6}" y1="${y + 10}" x2="${cx + 6}" y2="${y - 10}"/>`;
      if (cell.type === 'P' || cell.type === 'N') s += `<text class="ct" x="${cx}" y="${y + 4}">${cell.type}</text>`;
      return s + labels;
    }

    if (isBlock(cell.type)) return this.blockSvg(cell, r, c, tr, info, sym);

    const k = `co${pin ? ' on' : ''}`;
    let s = `<line class="${w(pin)}" x1="${x0}" y1="${y}" x2="${cx - 12}" y2="${y}"/>`
      + `<line class="${w(pin)}" x1="${cx + 12}" y1="${y}" x2="${x1}" y2="${y}"/>`
      + `<path class="${k}" d="M ${cx - 6} ${y - 12} Q ${cx - 15} ${y} ${cx - 6} ${y + 12}"/>`
      + `<path class="${k}" d="M ${cx + 6} ${y - 12} Q ${cx + 15} ${y} ${cx + 6} ${y + 12}"/>`;
    const letter = { NCOIL: '/', SET: 'S', RESET: 'R' }[cell.type];
    if (letter) s += `<text class="ct" x="${cx}" y="${y + 4}">${letter}</text>`;
    return s + labels;
  }

  blockSvg(cell, r, c, tr, info, sym) {
    const x0 = cellX(c);
    const x1 = x0 + CW;
    const cx = x0 + CW / 2;
    const y = rowY(r);
    const pin = tr ? tr.nodes[r][c] : false;
    const bx0 = cx - 36;
    const by0 = y - 26;
    const isTimer = cell.type === 'TON' || cell.type === 'TOF';
    let value;
    let q = false;
    const preset = Number(cell.preset);
    if (isTimer) {
      const t = tr && info ? this.plc.timers.get(info.key) : null;
      value = t ? fmtTimePair(t.et, preset) : `PT ${Number.isFinite(preset) ? fmtTime(preset) : '?'}`;
      q = !!t?.q;
    } else {
      const k = tr && info ? this.plc.counters.get(info.key) : null;
      value = k ? `CV ${k.cv}/${preset}` : `PV ${Number.isFinite(preset) ? preset : '?'}`;
      q = !!k?.q;
    }
    let s = `<line class="w${pin ? ' on' : ''}" x1="${x0}" y1="${y}" x2="${bx0}" y2="${y}"/>`
      + `<line class="w" x1="${bx0 + 72}" y1="${y}" x2="${x1}" y2="${y}"/>`
      + `<rect class="box${pin ? ' on' : ''}" x="${bx0}" y="${by0}" width="72" height="52" rx="4"/>`
      + `<text class="box-t" x="${cx}" y="${by0 + 13}">${cell.type} ${esc((cell.addr ?? '?').toUpperCase())}</text>`
      + `<text class="box-v" x="${cx}" y="${by0 + 28}">${esc(value)}</text>`;
    if (sym) s += `<text class="box-s" x="${cx}" y="${by0 + 43}">${esc(trunc(sym, 12))}</text>`;
    if (tr) s += `<circle class="bitled${q ? ' on' : ''}" cx="${bx0 + 65}" cy="${by0 + 8}" r="3.5"><title>Q</title></circle>`;
    return s;
  }

  /** Texto de um operando no bloco: endereço (ou constante) e, em RUN, o valor atual. */
  operandText(raw, tr) {
    const op = parseOperand(raw ?? '');
    if (!op) return raw ? String(raw).toUpperCase() : '?';
    if (!op.key) return String(op.value);
    return tr && WORD_READABLE.includes(op.area) ? `${op.key} ${this.plc.readWord(op.key)}` : op.key;
  }

  /** Dica (tooltip) com os símbolos dos operandos. */
  operandTitle(cell, def) {
    return cellFields(cell.type).map((f) => {
      const op = parseOperand(cell[f] ?? '');
      const sym = op?.key ? this.hooks.symbol(op.key) : '';
      return `${OPERAND_LABEL[f]}: ${cell[f] || '?'}${sym ? ` (${sym})` : ''}`;
    }).join(' · ') + ` — ${def.label}`;
  }

  /** Comparação (coluna de condições) e aritmética (coluna de saídas), desenhadas como caixas. */
  numericSvg(cell, def, r, c, tr) {
    const x0 = cellX(c);
    const x1 = x0 + CW;
    const cx = x0 + CW / 2;
    const y = rowY(r);
    const bw = 78;
    const bx0 = cx - bw / 2;
    const by0 = y - 26;
    const pin = tr ? tr.nodes[r][c] : false;
    const t = (str, n = 12) => esc(trunc(str, n));
    let s = `<g><title>${esc(this.operandTitle(cell, def))}</title>`
      + `<line class="w${pin ? ' on' : ''}" x1="${x0}" y1="${y}" x2="${bx0}" y2="${y}"/>`;
    if (isCompare(cell.type)) {
      const closed = tr ? tr.closed[r][c] : false;
      const pout = tr ? tr.outs[r][c] : false;
      s += `<line class="w${pout ? ' on' : ''}" x1="${bx0 + bw}" y1="${y}" x2="${x1}" y2="${y}"/>`
        + `<rect class="box cmp${closed ? ' on' : ''}" x="${bx0}" y="${by0}" width="${bw}" height="52" rx="4"/>`
        + `<text class="box-t" x="${cx}" y="${by0 + 13}">CMP ${esc(def.sym)}</text>`
        + `<text class="box-v" x="${cx}" y="${by0 + 28}">${t(this.operandText(cell.in1, tr))}</text>`
        + `<text class="box-v" x="${cx}" y="${by0 + 43}">${t(this.operandText(cell.in2, tr))}</text>`;
    } else {
      const dest = parseAddress(cell.addr ?? '');
      const destTxt = `→${dest?.key ?? (cell.addr ? cell.addr.toUpperCase() : '?')}`
        + (tr && dest?.word ? ` ${this.plc.readWord(dest.key)}` : '');
      const expr = cell.type === 'MOVE'
        ? this.operandText(cell.in1, null)
        : `${this.operandText(cell.in1, null)}${def.sym === 'mod' ? ' mod ' : def.sym}${this.operandText(cell.in2, null)}`;
      s += `<line class="w" x1="${bx0 + bw}" y1="${y}" x2="${x1}" y2="${y}"/>`
        + `<rect class="box${pin ? ' on' : ''}" x="${bx0}" y="${by0}" width="${bw}" height="52" rx="4"/>`
        + `<text class="box-t" x="${cx}" y="${by0 + 13}">${cell.type}</text>`
        + `<text class="box-v" x="${cx}" y="${by0 + 28}">${t(expr, 13)}</text>`
        + `<text class="box-v dest" x="${cx}" y="${by0 + 43}">${t(destTxt, 13)}</text>`;
    }
    return `${s}</g>`;
  }

  // -------------------------------------------------------------------------
  // Interação
  // -------------------------------------------------------------------------

  onClick(e) {
    if (this.running) return;
    const act = e.target.closest('[data-act]');
    if (act) {
      this.rungAction(act.dataset.act, Number(act.dataset.ri));
      return;
    }
    const holder = e.target.closest('[data-svg]');
    if (!holder) return;
    const ri = Number(holder.dataset.svg);
    const vh = e.target.closest('[data-vr]');
    if (vh) {
      this.toggleLink(ri, Number(vh.dataset.vr), Number(vh.dataset.vc));
      return;
    }
    const hit = e.target.closest('[data-r]');
    if (hit) this.cellClick(ri, Number(hit.dataset.r), Number(hit.dataset.c));
  }

  onInput(e) {
    const input = e.target.closest('.rung-comment');
    if (!input || this.running) return;
    const rung = this.program.rungs[Number(input.dataset.ri)];
    if (rung) {
      rung.comment = input.value.slice(0, 200);
      this.hooks.onChange(this.errors);
    }
  }

  onKey(e) {
    if (this.running) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.key === 'Escape') {
      this.setTool('select');
    } else if (e.key === 'Enter' && this.selection) {
      const { ri, r, c } = this.selection;
      e.preventDefault();
      this.openInline(ri, r, c);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && this.selection) {
      const { ri, r, c } = this.selection;
      const rung = this.program.rungs[ri];
      if (rung?.cells[r]?.[c]) {
        e.preventDefault();
        rung.cells[r][c] = null;
        this.changed();
        this.renderProps();
      }
    }
  }

  cellClick(ri, r, c) {
    const rung = this.program.rungs[ri];
    const cols = this.program.cols;
    const t = this.tool;
    if (t === 'select') {
      const again = this.selection?.ri === ri && this.selection.r === r && this.selection.c === c;
      this.select(ri, r, c);
      if (again) this.openInline(ri, r, c); // segundo clique na mesma célula edita o endereço
      return;
    }
    if (t === 'erase') {
      rung.cells[r][c] = null;
      this.select(ri, r, c);
      this.changed();
      return;
    }
    if (t === 'VLINK') {
      if (c >= cols - 1) this.hooks.notify('Clique nos pontos de junção (círculos) entre as linhas.');
      else this.toggleLink(ri, r, c + 1);
      return;
    }
    const def = ELEMENTS[t];
    let col = c;
    if (def.kind === 'output' && c !== cols - 1) {
      col = cols - 1;
      this.hooks.notify(`${def.label}: saídas ficam sempre na última coluna. Elemento colocado lá.`);
    } else if (def.kind !== 'output' && c === cols - 1) {
      this.hooks.notify(`${def.label} não pode ficar na coluna de saídas (sombreada).`);
      return;
    }
    const prev = rung.cells[r][col];
    const cell = { type: t };
    if (def.areas) {
      const pa = prev?.addr ? parseAddress(prev.addr) : null;
      cell.addr = pa && def.areas.includes(pa.area) ? prev.addr : this.suggestAddr(t);
    }
    if (def.preset) {
      const prevDef = prev ? ELEMENTS[prev.type] : null;
      cell.preset = prevDef?.preset === def.preset && prev.preset != null ? prev.preset : def.preset.def;
    }
    if (def.operands) {
      // Trocar GE por GT (ou ADD por SUB) mantém os operandos já digitados.
      const dflt = isCompare(t) ? DEFAULT_OPERANDS.compare : DEFAULT_OPERANDS[t] ?? DEFAULT_OPERANDS.math;
      for (const f of def.operands) {
        cell[f] = prev && hasOperands(prev.type) && typeof prev[f] === 'string' ? prev[f] : dflt[f];
      }
    }
    rung.cells[r][col] = cell;
    autoWire(rung, r, cols);
    this.changed();
    this.select(ri, r, col);
    if (cellFields(t).length) this.openInline(ri, r, col);
  }

  /**
   * Campos flutuantes sobre a célula: o endereço ou, nas instruções numéricas, A, B e o destino.
   * Enter/Esc ou clique fora fecham; Tab passa de um campo para o outro.
   */
  openInline(ri, r, c) {
    this.closeInline();
    const cell = this.program.rungs[ri]?.cells[r]?.[c];
    const def = cell && ELEMENTS[cell.type];
    const host = this.root.querySelector(`[data-svg="${ri}"]`)?.parentElement;
    const fields = def ? cellFields(cell.type) : [];
    if (!fields.length || !host) return;
    const multi = fields.length > 1;
    const box = document.createElement('div');
    box.className = `inline-edit${multi ? ' multi' : ''}`;
    for (const f of fields) {
      const input = document.createElement('input');
      input.value = cell[f] ?? '';
      input.maxLength = 12;
      input.spellcheck = false;
      input.autocomplete = 'off';
      input.setAttribute('list', def.operands ? 'wordList' : 'addrList');
      input.setAttribute('aria-label', `${multi ? OPERAND_LABEL[f] : 'Endereço'}: ${def.label}`);
      if (multi) {
        const lab = document.createElement('label');
        const tag = document.createElement('span');
        tag.textContent = f === 'addr' ? '→' : OPERAND_LABEL[f];
        tag.setAttribute('aria-hidden', 'true');
        lab.append(tag, input);
        box.append(lab);
      } else {
        box.append(input);
      }
      input.addEventListener('input', () => {
        cell[f] = input.value.trim();
        this.changed();
        const pf = this.propsEl.querySelector(`[data-pfield="${f}"]`);
        if (pf) pf.value = cell[f];
        this.updateHints(cell, def);
        this.updatePropErrors();
      });
    }
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') {
        e.preventDefault();
        this.closeInline();
      }
    });
    box.addEventListener('focusout', (e) => {
      if (!box.contains(e.relatedTarget)) this.closeInline();
    });
    host.append(box);
    // Centraliza sobre a célula sem passar da borda direita do degrau.
    const maxLeft = cellX(this.program.cols) + X0 - box.offsetWidth;
    box.style.left = `${Math.max(0, Math.min(cellX(c) + CW / 2 - box.offsetWidth / 2, maxLeft))}px`;
    box.style.top = `${rowTop(r) + 6}px`;
    this.inline = box;
    const first = box.querySelector('input');
    first.focus({ preventScroll: true });
    first.select();
  }

  closeInline() {
    const el = this.inline;
    if (!el) return;
    this.inline = null;
    el.remove();
  }

  suggestAddr(type) {
    const def = ELEMENTS[type];
    if (def.preset) {
      const area = def.areas[0];
      const used = new Set();
      for (const rung of this.program.rungs) {
        for (const row of rung.cells) {
          for (const cell of row) {
            if (!cell || !isBlock(cell.type)) continue;
            const a = parseAddress(cell.addr ?? '');
            if (a?.area === area) used.add(a.index);
          }
        }
      }
      for (let i = 0; i <= MAX_TC; i++) if (!used.has(i)) return `${area}${i}`;
    }
    return DEFAULT_ADDR[type] ?? '';
  }

  toggleLink(ri, r, c) {
    const rung = this.program.rungs[ri];
    const cols = this.program.cols;
    if (r >= rung.cells.length - 1) {
      this.hooks.notify('Adicione uma linha abaixo (+ linha) para criar um ramo paralelo.');
      return;
    }
    if (c < 1 || c > cols - 1) return;
    rung.vlinks[r][c] = !rung.vlinks[r][c];
    if (rung.vlinks[r][c]) {
      autoWire(rung, r, cols);
      autoWire(rung, r + 1, cols);
    }
    this.changed();
  }

  rungAction(act, ri) {
    const p = this.program;
    const rung = p.rungs[ri];
    switch (act) {
      case 'add-rung':
        if (p.rungs.length >= MAX_RUNGS) { this.hooks.notify(`Limite de ${MAX_RUNGS} degraus.`); return; }
        p.rungs.push(createRung(p.cols));
        this.selection = { ri: p.rungs.length - 1, r: 0, c: 0 };
        break;
      case 'row-add':
        if (!addRow(rung, p.cols)) { this.hooks.notify(`Máximo de ${MAX_ROWS} linhas por degrau.`); return; }
        break;
      case 'row-del':
        if (rung.cells.length <= 1) { this.hooks.notify('O degrau precisa de pelo menos uma linha.'); return; }
        if (!rowIsEmpty(rung, rung.cells.length - 1) && !window.confirm('Remover a última linha e os elementos dela?')) return;
        removeLastRow(rung);
        this.selection = null;
        break;
      case 'up':
      case 'down': {
        const j = act === 'up' ? ri - 1 : ri + 1;
        if (j < 0 || j >= p.rungs.length) return;
        [p.rungs[ri], p.rungs[j]] = [p.rungs[j], p.rungs[ri]];
        this.selection = null;
        break;
      }
      case 'dup':
        if (p.rungs.length >= MAX_RUNGS) return;
        p.rungs.splice(ri + 1, 0, structuredClone(rung));
        this.selection = null;
        break;
      case 'del':
        if (!rungIsEmpty(rung) && !window.confirm(`Excluir o degrau ${ri + 1}?`)) return;
        p.rungs.splice(ri, 1);
        if (!p.rungs.length) p.rungs.push(createRung(p.cols));
        this.selection = null;
        break;
      default:
        return;
    }
    this.errors = compileProgram(p).errors;
    this.render();
    this.renderProps();
    this.hooks.onChange(this.errors);
    if (act === 'add-rung') this.root.querySelector(`[data-ri="${p.rungs.length - 1}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  changed() {
    this.errors = compileProgram(this.program).errors;
    this.refreshSvgs();
    this.hooks.onChange(this.errors);
  }

  // -------------------------------------------------------------------------
  // Painel de propriedades
  // -------------------------------------------------------------------------

  renderProps({ focus = false } = {}) {
    const el = this.propsEl;
    if (this.running) {
      el.innerHTML = '<h3>Propriedades</h3><p class="muted">CLP em RUN. Pare (STOP) para editar o programa.</p>';
      return;
    }
    const sel = this.selection;
    const rung = sel ? this.program.rungs[sel.ri] : null;
    const cell = rung?.cells[sel.r]?.[sel.c];
    if (!sel || !rung) {
      el.innerHTML = `
        <h3>Como usar</h3>
        <ol class="howto">
          <li>Escolha um elemento na paleta e clique numa célula do degrau.</li>
          <li>Contatos ficam à esquerda; bobinas, temporizadores e contadores ficam na <b>última coluna</b> (sombreada).</li>
          <li>Para ligações em paralelo (OU), use <b>+ linha</b> e a ferramenta <b>Ligação</b>, clicando nos pontos de junção.</li>
          <li><b>Comparações</b> (A &gt;= B…) entram entre os contatos; <b>MOVE</b>, <b>ADD</b> e os outros blocos de
            aritmética gravam numa memória de palavra (MW) na última coluna. Operandos: constantes, IW (analógicos da
            máquina), MW, T (ms decorridos) e C (contagem).</li>
          <li>Clique em <b>RUN</b> e opere a máquina pelos botões do painel.</li>
        </ol>`;
      return;
    }
    const where = `Degrau ${sel.ri + 1} · linha ${sel.r + 1} · coluna ${sel.c + 1}`;
    if (!cell) {
      el.innerHTML = `<h3>Célula vazia</h3><p class="muted">${where}</p><p class="muted">Escolha um elemento na paleta e clique aqui para inserir.</p>`;
      return;
    }
    const def = ELEMENTS[cell.type];
    const errs = this.errors.filter((e) => e.rung === sel.ri && e.row === sel.r && e.col === sel.c);
    const fields = cellFields(cell.type);
    const fieldLabel = (f) => {
      if (!def.operands) return 'Endereço';
      if (f === 'addr') return 'Destino (MW)';
      return `Operando ${OPERAND_LABEL[f]}`;
    };
    el.innerHTML = `
      <h3>${esc(def.label)}</h3>
      <p class="muted">${where}</p>
      <p class="help">${esc(def.help)}</p>
      ${fields.map((f) => `
        <label class="field">${fieldLabel(f)}
          <input data-pfield="${f}" list="${def.operands ? 'wordList' : 'addrList'}" value="${esc(cell[f] ?? '')}"
            maxlength="12" spellcheck="false" autocomplete="off">
        </label>
        <div class="hint" data-phint="${f}"></div>`).join('')}
      ${def.areas ? `
        <label class="field" id="pSymWrap">Símbolo ${def.operands ? 'do destino ' : ''}(opcional)
          <input id="pSym" maxlength="32" spellcheck="false" autocomplete="off" placeholder="ex.: SISTEMA_ON">
        </label>` : ''}
      ${def.preset ? `
        <label class="field">${esc(def.preset.label)}
          <input id="pPreset" type="number" inputmode="numeric" min="${def.preset.min}" max="${def.preset.max}" step="1" value="${esc(cell.preset ?? '')}">
        </label>` : ''}
      <div id="pErrs" class="prop-errs">${errs.map((e) => `<p>${esc(e.message)}</p>`).join('')}</div>
      <button type="button" id="pDelete" class="btn danger small">Apagar elemento</button>`;

    const sym = el.querySelector('#pSym');
    const preset = el.querySelector('#pPreset');
    el.querySelectorAll('[data-pfield]').forEach((input) => {
      input.addEventListener('input', () => {
        cell[input.dataset.pfield] = input.value.trim();
        this.updateHints(cell, def);
        this.changed();
        this.updatePropErrors();
      });
    });
    sym?.addEventListener('input', () => {
      const a = parseAddress(cell.addr ?? '');
      if (!a || !SYMBOL_AREAS.includes(a.area)) return;
      const v = sym.value.trim().slice(0, 32);
      if (v) this.program.symbols[a.key] = v;
      else delete this.program.symbols[a.key];
      this.changed();
    });
    this.updateHints(cell, def);
    preset?.addEventListener('input', () => {
      cell.preset = preset.value === '' ? NaN : Number(preset.value);
      this.changed();
      this.updatePropErrors();
    });
    el.querySelector('#pDelete').addEventListener('click', () => {
      rung.cells[sel.r][sel.c] = null;
      this.changed();
      this.renderProps();
    });
    const first = el.querySelector('[data-pfield]');
    if (focus && first) {
      // Sem rolar a página: o endereço digitado já aparece ao vivo no próprio degrau.
      first.focus({ preventScroll: true });
      first.select();
    }
  }

  /** Explica o que o texto de um campo significa (símbolo, descrição) ou o que está errado. */
  fieldHint(cell, def, f) {
    const raw = cell[f] ?? '';
    const named = (key, fallback) => {
      const d = this.hooks.describe(key);
      return d ? `${d.symbol}${d.desc ? ` — ${d.desc}` : ''}` : fallback;
    };
    if (f !== 'addr') {
      const op = parseOperand(raw);
      if (!op) return { text: 'Constante inteira (−32768 a 32767) ou palavra: IW, MW, T (ms decorridos), C (contagem).', bad: !!raw };
      if (!op.key) return { text: 'Constante.', bad: false };
      if (!WORD_READABLE.includes(op.area)) return { text: `${op.key} é um bit. Use uma constante ou IW, MW, T, C.`, bad: true };
      if (op.area === 'T') return { text: named(op.key, `${op.key}: tempo decorrido (ET) em ms.`), bad: false };
      if (op.area === 'C') return { text: named(op.key, `${op.key}: contagem atual (CV).`), bad: false };
      return { text: named(op.key, op.area === 'IW' ? 'Entrada analógica sem uso nesta máquina (vale 0).' : 'Sem símbolo.'), bad: false };
    }
    const a = parseAddress(raw);
    if (!a) {
      return {
        text: def.operands ? 'Destino: memória de palavra, de MW0 a MW63.' : 'Formato: I0.0 (entrada), Q0.0 (saída), M0.0 (memória), T0, C0.',
        bad: !!raw,
      };
    }
    if (!def.areas.includes(a.area)) return { text: `Este elemento aceita: ${def.areas.join(', ')}.`, bad: true };
    return { text: named(a.key, 'Sem símbolo.'), bad: false };
  }

  updateHints(cell, def) {
    for (const f of cellFields(cell.type)) {
      const el = this.propsEl.querySelector(`[data-phint="${f}"]`);
      if (!el) continue;
      const { text, bad } = this.fieldHint(cell, def, f);
      el.textContent = text;
      el.classList.toggle('bad', bad);
    }
    const symWrap = this.propsEl.querySelector('#pSymWrap');
    const sym = this.propsEl.querySelector('#pSym');
    if (!symWrap) return;
    const a = parseAddress(cell.addr ?? '');
    const editable = !!a && def.areas.includes(a.area) && SYMBOL_AREAS.includes(a.area);
    symWrap.hidden = !editable;
    if (editable && document.activeElement !== sym) sym.value = this.program.symbols[a.key] ?? '';
  }

  updatePropErrors() {
    const box = this.propsEl.querySelector('#pErrs');
    const sel = this.selection;
    if (!box || !sel) return;
    box.innerHTML = this.errors
      .filter((e) => e.rung === sel.ri && e.row === sel.r && e.col === sel.c)
      .map((e) => `<p>${esc(e.message)}</p>`).join('');
  }
}
