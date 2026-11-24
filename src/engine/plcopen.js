// Exportação do programa ladder para PLCopen XML (TC6 XML, versão 2.01 — namespace tc6_0201),
// o formato de troca usado pelo OpenPLC Editor e pelo Beremiz.
//
// Tradução (CLP Simu → IEC 61131-3 / PLCopen):
//   NA, NF, P, N ............ contact (negated, edge="rising"/"falling")
//   Bobina, negada, S, R .... coil (negated, storage="set"/"reset")
//   TON, TOF ................ bloco TON/TOF (instância = o T), PT como literal de tempo (T#5s)
//   CTU, CTD ................ bloco CTU/CTD (instância = o C). R/LD vêm de uma variável auxiliar "<C>_R",
//                             ligada pelas bobinas Reset (R) do contador
//   Comparação (A >= B) ..... bloco GE/GT/… com EN = energia que chega; a saída OUT continua o degrau
//   MOVE, ADD … MOD ......... bloco com EN = energia do degrau; OUT → variável de destino (outVariable)
//   Fios e ligações verticais viram conexões (várias conexões no mesmo ponto = OU)
// Contatos em T/C leem a saída Q da instância (T0.Q); como número, C é C0.CV e T é T0.ET (TIME).
//
// Variáveis: I/Q com endereço (%IX/%QX), IW/MW com endereço (%IW/%MW), bits M sem endereço (memória interna).
// Os nomes vêm dos símbolos, ajustados às regras de identificador da IEC.

import { ELEMENTS, isCompare, isMath } from './elements.js';
import { compileProgram } from './program.js';
import { parseAddress, compareAddress } from './address.js';

export const PLCOPEN_NS = 'http://www.plcopen.org/xml/tc6_0201';
const XHTML_NS = 'http://www.w3.org/1999/xhtml';

// Palavras reservadas e nomes de funções/blocos padrão: não podem ser usados como nome de variável.
const RESERVED = new Set(`ABS ACOS ACTION ADD AND ARRAY ASIN AT ATAN BOOL BY BYTE CASE CONCAT CONFIGURATION CONSTANT COS CTD CTU CTUD
  DATE DATE_AND_TIME DELETE DINT DIV DO DT DWORD ELSE ELSIF EN END_ACTION END_CASE END_CONFIGURATION END_FOR END_FUNCTION
  END_FUNCTION_BLOCK END_IF END_PROGRAM END_REPEAT END_RESOURCE END_STEP END_STRUCT END_TRANSITION END_TYPE END_VAR END_WHILE
  ENO EQ EXIT EXP EXPT FALSE FIND FOR FROM FUNCTION FUNCTION_BLOCK F_EDGE F_TRIG GE GT IF INITIAL_STEP INSERT INT INTERVAL LD LE
  LEFT LEN LIMIT LINT LN LOG LREAL LT LWORD MAX MID MIN MOD MOVE MUL MUX NE NON_RETAIN NOT OF ON OR PRIORITY PROGRAM PT
  READ_ONLY READ_WRITE REAL REPEAT REPLACE RESOURCE RETAIN RETURN RIGHT ROL ROR RS R_EDGE R_TRIG SEL SHL SHR SIN SINGLE SINT SQRT
  SR STEP STRING STRUCT SUB TAN TASK THEN TIME TIME_OF_DAY TO TOD TOF TON TP TRANSITION TRUE TRUNC TYPE UDINT UINT ULINT
  UNTIL USINT VAR VAR_ACCESS VAR_CONFIG VAR_EXTERNAL VAR_GLOBAL VAR_INPUT VAR_IN_OUT VAR_OUTPUT VAR_TEMP WHILE WITH WORD
  WSTRING XOR`.split(/\s+/).filter(Boolean));

/** Nome de variável IEC a partir de um símbolo: sem acentos, só letras/dígitos/_, sem "__" nem _ nas pontas. */
export function iecIdentifier(text) {
  const s = String(text ?? '')
    .normalize('NFKD').replace(/\p{M}/gu, '')
    .replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!s) return '';
  return /^[0-9]/.test(s) ? `V_${s}` : s;
}

/** Nome padrão quando não há símbolo: I0.3 → I0_3, MW2 → MW2. */
const fallbackName = (key) => key.replace('.', '_');

/** Endereço IEC (located variable) aceito pelo OpenPLC. Bits M ficam sem endereço. */
function iecLocation(a) {
  switch (a.area) {
    case 'I': return `%IX${a.byte}.${a.bit}`;
    case 'Q': return `%QX${a.byte}.${a.bit}`;
    case 'IW': return `%IW${a.index}`;
    case 'MW': return `%MW${a.index}`;
    default: return null;
  }
}

/** Literal de tempo IEC: 5000 → T#5s, 1500 → T#1500ms. */
export const timeLiteral = (ms) => (ms % 1000 === 0 ? `T#${ms / 1000}s` : `T#${ms}ms`);

// ---------------------------------------------------------------------------
// Serialização XML mínima (árvore → texto indentado)
// ---------------------------------------------------------------------------

const XML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
// Caracteres de controle não são permitidos em XML 1.0 (exceto tab, LF e CR).
const clean = (s) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '');
export const xmlEscape = (s) => clean(s).replace(/[&<>"']/g, (ch) => XML_ESC[ch]);
const cdata = (s) => `<![CDATA[${clean(s).replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;

const el = (name, attrs = {}, ...children) => ({ name, attrs, children: children.flat().filter(Boolean) });
const text = (value) => ({ text: value });
const raw = (value) => ({ raw: value });

function serialize(node, depth = 0) {
  const pad = '  '.repeat(depth);
  const attrs = Object.entries(node.attrs)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => ` ${k}="${xmlEscape(v)}"`).join('');
  if (!node.children.length) return `${pad}<${node.name}${attrs}/>`;
  if (node.children.every((c) => c.text !== undefined || c.raw !== undefined)) {
    const body = node.children.map((c) => (c.raw !== undefined ? c.raw : xmlEscape(c.text))).join('');
    return `${pad}<${node.name}${attrs}>${body}</${node.name}>`;
  }
  const inner = node.children.map((c) => serialize(c, depth + 1)).join('\n');
  return `${pad}<${node.name}${attrs}>\n${inner}\n${pad}</${node.name}>`;
}

const xhtml = (s) => el('xhtml:p', {}, raw(cdata(s)));
const pos = (x, y) => el('position', { x: Math.round(x), y: Math.round(y) });
const rel = (x, y) => el('relPosition', { x: Math.round(x), y: Math.round(y) });

// ---------------------------------------------------------------------------
// Geometria (unidades do PLCopen; o editor de destino pode reorganizar o desenho)
// ---------------------------------------------------------------------------

const G = {
  x0: 40,         // trilho esquerdo
  cellW: 140,     // largura de uma célula da grade
  rowH: 110,      // altura de uma linha (cabe um bloco com 3 entradas)
  line: 40,       // linha de energia, a partir do topo da linha
  comment: 40,    // faixa do comentário do degrau
  gap: 30,        // espaço entre degraus
  contact: { w: 21, h: 20 },
  block: { w: 70 },
  variable: { w: 60, h: 20 },
};
const cellLeft = (c) => G.x0 + 30 + c * G.cellW;

/** Caminho ortogonal da entrada (destino) até a saída (origem), como o Beremiz grava. */
function wirePath(inPt, outPt) {
  if (Math.abs(inPt.y - outPt.y) < 0.5) return [pos(inPt.x, inPt.y), pos(outPt.x, outPt.y)];
  const mx = outPt.x + Math.max(8, (inPt.x - outPt.x) / 2);
  return [pos(inPt.x, inPt.y), pos(mx, inPt.y), pos(mx, outPt.y), pos(outPt.x, outPt.y)];
}

// ---------------------------------------------------------------------------
// Exportação
// ---------------------------------------------------------------------------

/**
 * Converte o programa para PLCopen XML.
 * opts = { machine, now: Date, projectName }
 * Retorna { xml, notes: [{ level: 'aviso'|'info', text }] } ou { errors } se o programa tiver problemas.
 */
export function exportPlcopen(program, { machine = null, now = new Date(), projectName } = {}) {
  const { errors, compiled } = compileProgram(program);
  if (errors.length) return { errors };
  const notes = new Map(); // texto → nível (sem repetir)
  const note = (level, msg) => { if (!notes.has(msg)) notes.set(msg, level); };
  const { cols, rungs } = compiled;

  // ---- uso de cada endereço ------------------------------------------------
  const blockType = new Map();   // 'T0' → 'TON', 'C0' → 'CTU'
  const resets = new Map();      // 'C0' → número de bobinas Reset
  const keys = new Set();
  const opKeys = (cell) => [cell.key, cell.in1?.key, cell.in2?.key].filter(Boolean);
  rungs.forEach((rung) => rung.cells.forEach((row) => row.forEach((cell) => {
    if (!cell || cell.type === 'WIRE') return;
    for (const k of opKeys(cell)) keys.add(k);
    if (ELEMENTS[cell.type].preset) blockType.set(cell.key, cell.type);
    if (cell.type === 'RESET' && 'TC'.includes(cell.key[0])) resets.set(cell.key, (resets.get(cell.key) ?? 0) + 1);
  })));

  // ---- nomes -----------------------------------------------------------------
  const io = machine ? [...machine.inputs, ...machine.outputs] : [];
  const symbolOf = (key) => io.find((x) => x.addr === key)?.symbol
    ?? machine?.analogs?.find((a) => `IW${a.reg}` === key)?.symbol
    ?? program.symbols?.[key] ?? '';
  const descOf = (key) => io.find((x) => x.addr === key)?.desc
    ?? machine?.analogs?.find((a) => `IW${a.reg}` === key)?.desc ?? '';
  const taken = new Set();
  const names = new Map();
  const claim = (wanted, key) => {
    let name = wanted;
    if (!name || RESERVED.has(name.toUpperCase()) || taken.has(name.toUpperCase())) {
      const base = fallbackName(key);
      name = wanted && !taken.has(`${wanted}_${base}`.toUpperCase()) ? `${wanted}_${base}` : base;
      if (wanted) note('info', `O símbolo "${symbolOf(key) || wanted}" (${key}) não é um nome válido ou livre na IEC; a variável se chama ${name}.`);
    }
    let n = name;
    for (let i = 2; taken.has(n.toUpperCase()); i++) n = `${name}_${i}`;
    taken.add(n.toUpperCase());
    return n;
  };
  const sortedKeys = [...keys].sort(compareAddress);
  for (const key of sortedKeys) {
    const sym = symbolOf(key);
    const id = iecIdentifier(sym);
    if (sym && id !== sym) note('info', `O símbolo "${sym}" (${key}) foi ajustado para o nome IEC ${id || fallbackName(key)}.`);
    names.set(key, claim(id, key));
  }
  const resetVar = new Map(); // 'C0' → nome da variável auxiliar de reset
  for (const key of [...resets.keys()].filter((k) => k[0] === 'C').sort(compareAddress)) {
    resetVar.set(key, claim(`${names.get(key)}_R`, `${key}_R`));
  }

  // ---- avisos de tradução -----------------------------------------------------
  for (const [key, n] of resets) {
    if (key[0] === 'T') {
      note('aviso', `Reset (R) de temporizador (${key}) não tem equivalente na IEC 61131-3: o TON/TOF zera quando a entrada IN desliga. Essas bobinas não foram exportadas.`);
    } else if (n > 1) {
      note('aviso', `${key} tem ${n} bobinas Reset (R) em degraus diferentes. Na exportação elas escrevem na mesma variável ${resetVar.get(key)}; a última vence. Junte-as num degrau só (em paralelo).`);
    }
  }
  for (const key of keys) {
    if ('TC'.includes(key[0]) && !blockType.has(key)) {
      note('aviso', `${key} é usado sem bloco ${key[0] === 'T' ? 'TON/TOF' : 'CTU/CTD'}; foi declarado como ${key[0] === 'T' ? 'TON' : 'CTU'}.`);
    }
  }
  if ([...blockType.values()].includes('CTD')) {
    note('info', 'CTD: no CLP Simu o contador começa em PV; na IEC começa em 0 até um pulso na entrada LD (ligada às bobinas Reset do contador).');
  }
  if ([...resets.keys()].some((k) => k[0] === 'C')) {
    note('info', 'Reset de contador vira a variável auxiliar <contador>_R ligada à entrada R (CTU) ou LD (CTD). Se o degrau do Reset vier depois do contador, o efeito aparece na varredura seguinte.');
  }

  // ---- expressões dos operandos ----------------------------------------------
  const varOf = (key) => {
    const n = names.get(key);
    if (key[0] === 'T') return `${n}.Q`;
    if (key[0] === 'C') return `${n}.Q`;
    return n;
  };
  /** Operando numérico → expressão IEC e tipo ('INT' ou 'TIME'). */
  const operandExpr = (op, other, where) => {
    if (!op.key) {
      // Constante comparada com um tempo (T): vira literal de tempo, para o tipo bater.
      if (other?.key?.[0] === 'T') return { expr: timeLiteral(op.value), type: 'TIME' };
      return { expr: String(op.value), type: 'INT' };
    }
    const n = names.get(op.key);
    if (op.key[0] === 'C') return { expr: `${n}.CV`, type: 'INT' };
    if (op.key[0] === 'T') {
      if (other && other.key && other.key[0] !== 'T') {
        note('aviso', `${where}: ${op.key} (tempo) comparado com ${other.key} (inteiro). Exportado como ${n}.ET (TIME); converta no editor de destino.`);
      }
      return { expr: `${n}.ET`, type: 'TIME' };
    }
    return { expr: n, type: 'INT' };
  };

  // ---- corpo LD ----------------------------------------------------------------
  let nextId = 1;
  const newId = () => nextId++;
  const body = [];
  let y = 20;
  const railRightX = cellLeft(cols) + 160;

  rungs.forEach((rung, ri) => {
    const comment = program.rungs[ri]?.comment ?? '';
    const where = `Degrau ${ri + 1}`;
    const rows = rung.cells.length;
    if (comment.trim()) {
      body.push(el('comment', { localId: newId(), height: G.comment - 10, width: railRightX - G.x0 },
        pos(G.x0, y), el('content', {}, xhtml(`${ri + 1}. ${comment}`))));
    }
    const top = y + G.comment;
    const lineY = (r) => top + r * G.rowH + G.line;

    // Trilho esquerdo: um ponto de saída por linha.
    const railY = lineY(0) - 20;
    const railH = lineY(rows - 1) - railY + 20;
    const leftId = newId();
    body.push(el('leftPowerRail', { localId: leftId, height: railH, width: 10 }, pos(G.x0, railY),
      Array.from({ length: rows }, (_, r) => el('connectionPointOut', { formalParameter: '' }, rel(10, lineY(r) - railY)))));

    // Primeiro passo: posição e ponto de saída de energia de cada elemento.
    const out = rung.cells.map((row) => row.map(() => null)); // { id, param, x, y }
    const placed = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cell = rung.cells[r][c];
        if (!cell || cell.type === 'WIRE') continue;
        if (cell.type === 'RESET' && cell.key[0] === 'T') continue; // sem equivalente (aviso acima)
        const cx = cellLeft(c) + G.cellW / 2;
        const ly = lineY(r);
        const item = { cell, r, c, id: newId(), ly };
        if (ELEMENTS[cell.type].kind === 'contact' && !isCompare(cell.type)) {
          item.x = cx - G.contact.w / 2;
          item.inPt = { x: item.x, y: ly };
          out[r][c] = { id: item.id, x: item.x + G.contact.w, y: ly };
        } else if (ELEMENTS[cell.type].kind === 'output' && !ELEMENTS[cell.type].preset && !isMath(cell.type)) {
          item.x = cx - G.contact.w / 2;
          item.inPt = { x: item.x, y: ly };
          item.outPt = { x: item.x + G.contact.w, y: ly };
        } else {
          item.x = cellLeft(c) + 50;
          item.inPt = { x: item.x, y: ly };
          if (isCompare(cell.type)) out[r][c] = { id: item.id, param: 'OUT', x: item.x + G.block.w, y: ly + 20 };
        }
        placed.push(item);
      }
    }

    // Fontes de energia de um nó (r, c): trilho, saídas de elementos e fios, com as ligações verticais (OU).
    const group = (r, c) => {
      if (c === 0) return [r];
      let a = r;
      while (a > 0 && rung.vlinks[a - 1][c]) a--;
      let b = r;
      while (b < rows - 1 && rung.vlinks[b][c]) b++;
      return Array.from({ length: b - a + 1 }, (_, i) => a + i);
    };
    const sourcesMemo = new Map();
    const sources = (r, c) => {
      const k = `${r},${c}`;
      if (sourcesMemo.has(k)) return sourcesMemo.get(k);
      sourcesMemo.set(k, []); // proteção contra ciclos (não há, a grade só anda para a direita)
      let list = [];
      if (c === 0) {
        list = [{ id: leftId, x: G.x0 + 10, y: lineY(r) }];
      } else {
        for (const rr of group(r, c)) {
          const prev = rung.cells[rr][c - 1];
          if (!prev) continue;
          if (prev.type === 'WIRE') list.push(...sources(rr, c - 1));
          else if (out[rr][c - 1]) list.push(out[rr][c - 1]);
        }
      }
      const seen = new Set();
      list = list.filter((s) => {
        const id = `${s.id}:${s.param ?? ''}`;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      sourcesMemo.set(k, list);
      return list;
    };

    const connIn = (inPt, srcs, relX, relY) => el('connectionPointIn', {}, rel(relX, relY),
      srcs.map((s) => el('connection', { refLocalId: s.id, formalParameter: s.param }, wirePath(inPt, s))));
    const inVariable = (expr, pinX, pinY) => {
      const id = newId();
      const x = pinX - G.variable.w - 20;
      body.push(el('inVariable', { localId: id, height: G.variable.h, width: G.variable.w, negated: 'false' },
        pos(x, pinY - G.variable.h / 2),
        el('connectionPointOut', {}, rel(G.variable.w, G.variable.h / 2)),
        el('expression', {}, text(expr))));
      return { id, x: x + G.variable.w, y: pinY };
    };

    const rightPoints = [];
    for (const item of placed) {
      const { cell, r, c, id, ly } = item;
      const srcs = sources(r, c);
      if (!srcs.length) note('aviso', `${where}, linha ${r + 1}, coluna ${c + 1}: elemento sem ligação à esquerda (nunca recebe energia).`);
      const def = ELEMENTS[cell.type];

      if (def.kind === 'contact' && !isCompare(cell.type)) {
        const edge = cell.type === 'P' ? 'rising' : cell.type === 'N' ? 'falling' : undefined;
        body.push(el('contact', { localId: id, height: G.contact.h, width: G.contact.w, negated: String(cell.type === 'NC'), edge },
          pos(item.x, ly - G.contact.h / 2),
          connIn(item.inPt, srcs, 0, G.contact.h / 2),
          el('connectionPointOut', {}, rel(G.contact.w, G.contact.h / 2)),
          el('variable', {}, text(varOf(cell.key)))));
        continue;
      }

      if (def.kind === 'output' && !def.preset && !isMath(cell.type)) {
        // Bobina; Reset de contador escreve na variável auxiliar <C>_R (bobina comum).
        const isCounterReset = cell.type === 'RESET' && cell.key[0] === 'C';
        const storage = !isCounterReset && cell.type === 'SET' ? 'set' : !isCounterReset && cell.type === 'RESET' ? 'reset' : undefined;
        const variable = isCounterReset ? resetVar.get(cell.key) : varOf(cell.key);
        body.push(el('coil', { localId: id, height: G.contact.h, width: G.contact.w, negated: String(cell.type === 'NCOIL'), storage },
          pos(item.x, ly - G.contact.h / 2),
          connIn(item.inPt, srcs, 0, G.contact.h / 2),
          el('connectionPointOut', {}, rel(G.contact.w, G.contact.h / 2)),
          el('variable', {}, text(variable))));
        rightPoints.push({ id, x: item.outPt.x, y: ly });
        continue;
      }

      // Blocos: comparação, aritmética, temporizadores e contadores.
      let typeName = cell.type;
      let instanceName;
      let inputs;   // [{ param, power } | { param, expr }]
      let outputs;  // nomes das saídas
      let destination = null;
      if (def.preset) {
        instanceName = names.get(cell.key);
        if (cell.type === 'TON' || cell.type === 'TOF') {
          inputs = [{ param: 'IN', power: true }, { param: 'PT', expr: timeLiteral(cell.preset) }];
          outputs = ['Q', 'ET'];
        } else {
          const up = cell.type === 'CTU';
          inputs = [
            { param: up ? 'CU' : 'CD', power: true },
            { param: up ? 'R' : 'LD', expr: resetVar.get(cell.key) ?? 'FALSE' },
            { param: 'PV', expr: String(cell.preset) },
          ];
          outputs = ['Q', 'CV'];
        }
      } else if (isCompare(cell.type)) {
        const a = operandExpr(cell.in1, cell.in2, where);
        const b = operandExpr(cell.in2, cell.in1, where);
        inputs = [{ param: 'EN', power: true }, { param: 'IN1', expr: a.expr }, { param: 'IN2', expr: b.expr }];
        outputs = ['ENO', 'OUT'];
      } else {
        const ops = cell.type === 'MOVE' ? [cell.in1] : [cell.in1, cell.in2];
        const exprs = ops.map((op, i) => operandExpr(op, null, where));
        if (exprs.some((e) => e.type === 'TIME')) {
          note('aviso', `${where}: ${cell.type} com tempo (T) como operando. Exportado como .ET (TIME), que não é INT; converta no editor de destino.`);
        }
        inputs = [{ param: 'EN', power: true },
          ...exprs.map((e, i) => ({ param: cell.type === 'MOVE' ? 'IN' : `IN${i + 1}`, expr: e.expr }))];
        outputs = ['ENO', 'OUT'];
        destination = names.get(cell.key);
        typeName = cell.type;
      }
      const pins = Math.max(inputs.length, outputs.length);
      const h = 20 + pins * 20;
      const bx = item.x;
      const by = ly - 20;
      const pinY = (i) => by + 20 + i * 20;
      const inputVars = inputs.map((inp, i) => {
        const pt = { x: bx, y: pinY(i) };
        const srcList = inp.power ? srcs : [inVariable(inp.expr, bx, pinY(i))];
        return el('variable', { formalParameter: inp.param }, connIn(pt, srcList, 0, pinY(i) - by));
      });
      const outputVars = outputs.map((o, i) => el('variable', { formalParameter: o },
        el('connectionPointOut', {}, rel(G.block.w, pinY(i) - by))));
      body.push(el('block', {
        localId: id, width: G.block.w, height: h, typeName, instanceName, executionOrderId: 0,
      }, pos(bx, by), el('inputVariables', {}, inputVars), el('inOutVariables'), el('outputVariables', {}, outputVars)));

      if (destination) {
        const outY = pinY(1);
        const vx = bx + G.block.w + 20;
        body.push(el('outVariable', { localId: newId(), height: G.variable.h, width: G.variable.w, negated: 'false' },
          pos(vx, outY - G.variable.h / 2),
          connIn({ x: vx, y: outY }, [{ id, param: 'OUT', x: bx + G.block.w, y: outY }], 0, G.variable.h / 2),
          el('expression', {}, text(destination))));
      }
    }

    // Trilho direito: recebe as bobinas.
    if (rightPoints.length) {
      body.push(el('rightPowerRail', { localId: newId(), height: railH, width: 10 }, pos(railRightX, railY),
        rightPoints.map((p) => connIn({ x: railRightX, y: p.y }, [p], 0, p.y - railY))));
    }
    y = top + rows * G.rowH + G.gap;
  });

  // ---- variáveis ---------------------------------------------------------------
  const typeOf = (key) => {
    const a = parseAddress(key);
    if (a.area === 'IW' || a.area === 'MW') return el('INT');
    if (a.area === 'T') return el('derived', { name: blockType.get(key) ?? 'TON' });
    if (a.area === 'C') return el('derived', { name: blockType.get(key) ?? 'CTU' });
    return el('BOOL');
  };
  const variables = sortedKeys.map((key) => {
    const desc = descOf(key);
    const a = parseAddress(key);
    return el('variable', { name: names.get(key), address: iecLocation(a) ?? undefined },
      el('type', {}, typeOf(key)),
      el('documentation', {}, xhtml(`${key}${desc ? ` — ${desc}` : ''} (CLP Simu)`)));
  });
  for (const [key, name] of resetVar) {
    variables.push(el('variable', { name }, el('type', {}, el('BOOL')),
      el('documentation', {}, xhtml(`Reset de ${key}: ligado pelas bobinas Reset (R) do contador (CLP Simu)`))));
  }

  // ---- projeto -----------------------------------------------------------------
  const id = iecIdentifier(machine?.id ?? 'programa') || 'programa';
  const pouName = `CLPSimu_${id}`;
  const stamp = now.toISOString().replace(/\.\d+Z$/, '');
  const project = el('project', { xmlns: PLCOPEN_NS, 'xmlns:xhtml': XHTML_NS, 'xmlns:xsd': 'http://www.w3.org/2001/XMLSchema' },
    el('fileHeader', {
      companyName: 'CLP Simu', productName: 'CLP Simu', productVersion: '0.1.0', creationDateTime: stamp,
      contentDescription: 'Programa exportado do simulador CLP Simu (protótipo). Revise e teste no ambiente de destino antes de usar.',
    }),
    el('contentHeader', { name: projectName ?? (machine ? `CLP Simu – ${machine.name}` : 'CLP Simu'), modificationDateTime: stamp },
      el('coordinateInfo', {},
        el('fbd', {}, el('scaling', { x: 10, y: 10 })),
        el('ld', {}, el('scaling', { x: 10, y: 10 })),
        el('sfc', {}, el('scaling', { x: 10, y: 10 })))),
    el('types', {},
      el('dataTypes'),
      el('pous', {},
        el('pou', { name: pouName, pouType: 'program' },
          el('interface', {}, el('localVars', {}, variables)),
          el('body', {}, el('LD', {}, body)),
          el('documentation', {}, xhtml(machine
            ? `Programa ladder da máquina "${machine.name}", exportado do CLP Simu. Ciclo de varredura do simulador: 10 ms.`
            : 'Programa ladder exportado do CLP Simu.'))))),
    el('instances', {},
      el('configurations', {},
        el('configuration', { name: 'Config0' },
          el('resource', { name: 'Res0' },
            el('task', { name: 'tarefa_principal', priority: 0, interval: 'T#10ms' },
              el('pouInstance', { name: 'instancia0', typeName: pouName })))))));

  const uses = (test) => rungs.some((r) => r.cells.some((row) => row.some((c) => c && test(c.type))));
  if (uses(isMath)) {
    note('info', 'Blocos MOVE/ADD/… recebem a energia do degrau em EN. Confira no editor de destino se, com EN desligado, o destino fica inalterado (como no CLP Simu).');
  }
  if (uses(isCompare)) {
    note('info', 'Comparações viram blocos (GE, LT…) com EN ligado à energia que chega; a saída OUT continua o degrau.');
  }

  const xml = `<?xml version="1.0" encoding="utf-8"?>\n${serialize(project)}\n`;
  const order = { aviso: 0, info: 1 };
  return {
    xml,
    pouName,
    notes: [...notes].map(([msg, level]) => ({ level, text: msg })).sort((a, b) => order[a.level] - order[b.level]),
  };
}
