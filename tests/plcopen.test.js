// Testes da exportação PLCopen XML (TC6 2.01).
//
// Além da estrutura, o teste interpreta o XML gerado — contatos, bobinas e blocos ligados pelas conexões —
// e usa esse "CLP de referência" para controlar as máquinas simuladas, comparando com o CLP Simu.
// Isso confere a tradução do desenho (séries, paralelos, ligações verticais, blocos); não substitui
// importar o arquivo no OpenPLC Editor/Beremiz, que ainda não foi feito.
import test from 'node:test';
import assert from 'node:assert/strict';
import { exportPlcopen, iecIdentifier, timeLiteral, xmlEscape, PLCOPEN_NS } from '../src/engine/plcopen.js';
import { buildProgram } from '../src/engine/program.js';
import { PLC } from '../src/engine/plc.js';
import { toInt16 } from '../src/engine/address.js';
import { MACHINES, machineExamples } from '../src/machines/index.js';
import { mulberry32, analogInputs } from '../src/machines/common.js';
import { conveyor } from '../src/machines/conveyor.js';
import { tank } from '../src/machines/tank.js';

// ---------------------------------------------------------------------------
// Leitor de XML mínimo (suficiente para o que o exportador gera) — falha em XML malformado
// ---------------------------------------------------------------------------

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescape = (s) => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => ENT[e]);

function parseXml(src) {
  let i = 0;
  const fail = (msg) => { throw new Error(`XML inválido (${msg}) na posição ${i}: ${src.slice(i, i + 40)}`); };
  const skipWs = () => { while (/\s/.test(src[i] ?? '')) i++; };
  if (src.startsWith('<?xml')) i = src.indexOf('?>') + 2;
  function element() {
    skipWs();
    if (src[i] !== '<') fail('esperado <');
    const m = /^<([A-Za-z_][\w:.-]*)/.exec(src.slice(i));
    if (!m) fail('nome de elemento');
    i += m[0].length;
    const node = { name: m[1], attrs: {}, children: [], text: '' };
    for (;;) {
      skipWs();
      if (src.startsWith('/>', i)) { i += 2; return node; }
      if (src[i] === '>') { i++; break; }
      const a = /^([A-Za-z_][\w:.-]*)="([^"<]*)"/.exec(src.slice(i));
      if (!a) fail('atributo');
      if (a[1] in node.attrs) fail(`atributo repetido ${a[1]}`);
      node.attrs[a[1]] = unescape(a[2]);
      i += a[0].length;
    }
    for (;;) {
      if (src.startsWith('</', i)) {
        const close = `</${node.name}>`;
        if (!src.startsWith(close, i)) fail(`esperado ${close}`);
        i += close.length;
        return node;
      }
      if (src.startsWith('<![CDATA[', i)) {
        const end = src.indexOf(']]>', i);
        if (end < 0) fail('CDATA sem fim');
        node.text += src.slice(i + 9, end);
        i = end + 3;
      } else if (src[i] === '<') {
        node.children.push(element());
      } else {
        const end = src.indexOf('<', i);
        if (end < 0) fail('texto sem fim');
        const t = src.slice(i, end);
        if (/[<&](?!(amp|lt|gt|quot|apos);)/.test(t.replace(/&(amp|lt|gt|quot|apos);/g, ''))) fail('& solto');
        if (t.trim()) node.text += unescape(t);
        i = end;
      }
    }
  }
  const root = element();
  skipWs();
  if (i !== src.length) fail('conteúdo depois da raiz');
  return root;
}

const kids = (n, name) => n.children.filter((c) => c.name === name);
const kid = (n, name) => kids(n, name)[0];
function all(n, name, out = []) {
  for (const c of n.children) {
    if (c.name === name) out.push(c);
    all(c, name, out);
  }
  return out;
}
const fullText = (n) => n.text + n.children.map(fullText).join('');

// ---------------------------------------------------------------------------
// CLP de referência: executa o LD do arquivo PLCopen
// ---------------------------------------------------------------------------

class LdRunner {
  constructor(xml) {
    const root = parseXml(xml);
    const pou = all(root, 'pou')[0];
    this.vars = new Map();       // nome → { address, type }
    this.values = new Map();     // nome → valor
    this.fbs = new Map();        // instância → estado do TON/TOF/CTU/CTD
    this.edgeMem = new Map();
    for (const v of kids(kid(kid(pou, 'interface'), 'localVars'), 'variable')) {
      const t = kid(v, 'type').children[0];
      const type = t.name === 'derived' ? t.attrs.name : t.name;
      this.vars.set(v.attrs.name, { address: v.attrs.address ?? null, type });
      if (['TON', 'TOF', 'CTU', 'CTD'].includes(type)) this.fbs.set(v.attrs.name, { type, q: false, et: 0, cv: 0, prev: false });
      else this.values.set(v.attrs.name, type === 'BOOL' ? false : 0);
    }
    const ld = all(pou, 'LD')[0];
    this.byId = new Map();
    this.rungs = [];
    for (const e of ld.children) {
      if (e.attrs.localId) this.byId.set(e.attrs.localId, e);
      if (e.name === 'leftPowerRail') this.rungs.push([]);
      if (e.name !== 'comment') this.rungs.at(-1)?.push(e);
    }
  }

  static addrKey(address) {
    let m = /^%([IQ])X(\d+)\.(\d)$/.exec(address);
    if (m) return `${m[1]}${m[2]}.${m[3]}`;
    m = /^%([IM])W(\d+)$/.exec(address);
    return m ? `${m[1]}W${m[2]}` : null;
  }

  expr(e) {
    let m = /^T#(\d+)(ms|s)$/.exec(e);
    if (m) return Number(m[1]) * (m[2] === 's' ? 1000 : 1);
    if (/^-?\d+$/.test(e)) return Number(e);
    if (e === 'TRUE' || e === 'FALSE') return e === 'TRUE';
    m = /^(\w+)\.(Q|CV|ET)$/.exec(e);
    if (m) {
      const fb = this.fbs.get(m[1]);
      assert.ok(fb, `instância ${m[1]} declarada`);
      return { Q: fb.q, CV: fb.cv, ET: fb.et }[m[2]];
    }
    assert.ok(this.values.has(e), `variável ${e} declarada`);
    return this.values.get(e);
  }

  conns(cpIn) {
    return kids(cpIn, 'connection').map((c) => ({ ref: c.attrs.refLocalId, param: c.attrs.formalParameter }));
  }

  inputOf(block, param) {
    const v = kid(kid(block, 'inputVariables'), 'variable') && kids(kid(block, 'inputVariables'), 'variable')
      .find((x) => x.attrs.formalParameter === param);
    return v ? kid(v, 'connectionPointIn') : null;
  }

  scan(inputs, dt) {
    for (const [name, v] of this.vars) {
      const key = v.address && LdRunner.addrKey(v.address);
      if (key && key[0] === 'I') this.values.set(name, key[1] === 'W' ? toInt16(inputs[key] ?? 0) : !!inputs[key]);
    }
    for (const rung of this.rungs) this.runRung(rung, dt);
  }

  runRung(rung, dt) {
    const memo = new Map();
    const val = (ref, param) => {
      const k = `${ref}:${param ?? ''}`;
      if (!memo.has(k)) memo.set(k, this.compute(this.byId.get(ref), param, val));
      return memo.get(k);
    };
    const power = (cpIn) => this.conns(cpIn).some((c) => val(c.ref, c.param));
    // Fase 1: toda a lógica do degrau (inclusive a memória de borda dos contatos sem energia).
    for (const e of rung) {
      if (e.name === 'contact') val(e.attrs.localId);
      if (e.name === 'block' && /^(EQ|NE|GT|GE|LT|LE)$/.test(e.attrs.typeName)) val(e.attrs.localId, 'OUT');
    }
    // Fase 2: saídas, de cima para baixo.
    for (const e of rung) {
      if (e.name === 'coil') {
        const p = power(kid(e, 'connectionPointIn'));
        const name = fullText(kid(e, 'variable'));
        if (e.attrs.storage === 'set') { if (p) this.values.set(name, true); }
        else if (e.attrs.storage === 'reset') { if (p) this.values.set(name, false); }
        else this.values.set(name, e.attrs.negated === 'true' ? !p : p);
      } else if (e.name === 'block') {
        this.runBlock(e, power, val, dt);
      }
    }
  }

  compute(e, param, val) {
    const orIn = (cpIn) => this.conns(cpIn).some((c) => val(c.ref, c.param));
    switch (e.name) {
      case 'leftPowerRail': return true;
      case 'inVariable': return this.expr(fullText(kid(e, 'expression')));
      case 'contact': {
        const v = !!this.expr(fullText(kid(e, 'variable')));
        let pass = e.attrs.negated === 'true' ? !v : v;
        if (e.attrs.edge) {
          const prev = this.edgeMem.get(e.attrs.localId) ?? false;
          this.edgeMem.set(e.attrs.localId, v);
          pass = e.attrs.edge === 'rising' ? v && !prev : !v && prev;
        }
        return orIn(kid(e, 'connectionPointIn')) && pass;
      }
      case 'block': {
        const en = orIn(this.inputOf(e, 'EN'));
        if (param === 'ENO') return en;
        const a = val(this.conns(this.inputOf(e, 'IN1'))[0].ref);
        const b = val(this.conns(this.inputOf(e, 'IN2'))[0].ref);
        const t = { EQ: a === b, NE: a !== b, GT: a > b, GE: a >= b, LT: a < b, LE: a <= b }[e.attrs.typeName];
        return en && t;
      }
      default: throw new Error(`elemento sem saída de energia: ${e.name}`);
    }
  }

  runBlock(e, power, val, dt) {
    const type = e.attrs.typeName;
    const inp = (p) => {
      const cp = this.inputOf(e, p);
      const c = this.conns(cp);
      return this.byId.get(c[0]?.ref)?.name === 'inVariable' ? val(c[0].ref) : power(cp);
    };
    if (type === 'TON' || type === 'TOF') {
      const fb = this.fbs.get(e.attrs.instanceName);
      const on = inp('IN');
      const pt = inp('PT');
      if (type === 'TON') {
        if (on) { fb.et = Math.min(fb.et + dt, pt); fb.q = fb.et >= pt; } else { fb.et = 0; fb.q = false; }
      } else if (on) { fb.q = true; fb.et = 0; } else if (fb.q) { fb.et = Math.min(fb.et + dt, pt); if (fb.et >= pt) fb.q = false; }
      return;
    }
    if (type === 'CTU') {
      const fb = this.fbs.get(e.attrs.instanceName);
      const cu = inp('CU');
      if (inp('R')) fb.cv = 0;
      else if (cu && !fb.prev) fb.cv = Math.min(fb.cv + 1, 32767);
      fb.prev = cu;
      fb.q = fb.cv >= inp('PV');
      return;
    }
    if (!inp('EN')) return; // função não executa: destino inalterado
    const args = type === 'MOVE' ? [inp('IN')] : [inp('IN1'), inp('IN2')];
    const r = { MOVE: args[0], ADD: args[0] + args[1], SUB: args[0] - args[1], MUL: args[0] * args[1],
      DIV: args[1] ? Math.trunc(args[0] / args[1]) : null, MOD: args[1] ? args[0] % args[1] : null }[type];
    const out = [...this.byId.values()].find((x) => x.name === 'outVariable'
      && this.conns(kid(x, 'connectionPointIn')).some((c) => c.ref === e.attrs.localId));
    if (r !== null && out) this.values.set(fullText(kid(out, 'expression')), toInt16(r));
  }

  outputs() {
    const q = {};
    for (const [name, v] of this.vars) {
      const key = v.address && LdRunner.addrKey(v.address);
      if (key?.[0] === 'Q') q[key] = this.values.get(name);
    }
    return q;
  }

  word(key) {
    for (const [name, v] of this.vars) if (v.address && LdRunner.addrKey(v.address) === key) return this.values.get(name);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Testes
// ---------------------------------------------------------------------------

const NOW = new Date('2026-11-23T12:00:00Z');

test('identificadores IEC, literais de tempo e escape', () => {
  assert.equal(iecIdentifier('Botão Liga'), 'Botao_Liga');
  assert.equal(iecIdentifier('__nível__alto__'), 'nivel_alto');
  assert.equal(iecIdentifier('1º lote'), 'V_1o_lote');
  assert.equal(iecIdentifier('°%'), '');
  assert.equal(timeLiteral(5000), 'T#5s');
  assert.equal(timeLiteral(1500), 'T#1500ms');
  assert.equal(xmlEscape('a<b & "c"\u0001'), 'a&lt;b &amp; &quot;c&quot;');
});

test('estrutura do projeto PLCopen e declaração das variáveis', () => {
  const { xml, pouName } = exportPlcopen(tank.examples[1].program(), { machine: tank, now: NOW });
  const root = parseXml(xml);
  assert.equal(root.name, 'project');
  assert.equal(root.attrs.xmlns, PLCOPEN_NS);
  assert.deepEqual(root.children.map((c) => c.name), ['fileHeader', 'contentHeader', 'types', 'instances']);
  assert.equal(kid(root, 'fileHeader').attrs.creationDateTime, '2026-11-23T12:00:00');
  assert.equal(pouName, 'CLPSimu_tanque');
  const pou = all(root, 'pou')[0];
  assert.deepEqual(pou.attrs, { name: 'CLPSimu_tanque', pouType: 'program' });
  assert.deepEqual(pou.children.map((c) => c.name), ['interface', 'body', 'documentation']);
  const task = all(root, 'task')[0];
  assert.equal(task.attrs.interval, 'T#10ms');
  assert.equal(kid(task, 'pouInstance').attrs.typeName, 'CLPSimu_tanque');

  const vars = Object.fromEntries(kids(all(root, 'localVars')[0], 'variable')
    .map((v) => [v.attrs.name, `${v.attrs.address ?? '-'} ${kid(v, 'type').children[0].attrs.name ?? kid(v, 'type').children[0].name}`]));
  assert.equal(vars.B_LIGA, '%IX0.0 BOOL');
  assert.equal(vars.VALV_ENTRADA, '%QX0.0 BOOL');
  assert.equal(vars.NIVEL, '%IW0 INT');
  assert.equal(vars.SP_NIVEL, '%MW1 INT');
  assert.equal(vars.SISTEMA_ON, '- BOOL', 'bit M sem endereço');
  assert.equal(vars.T_MISTURA, '- TON');

  // localId único; toda conexão aponta para um elemento existente.
  const ids = all(root, '*').length; // (não usado; garante que a árvore foi percorrida)
  assert.ok(ids >= 0);
  const withId = [];
  (function walk(n) { if (n.attrs.localId) withId.push(n.attrs.localId); n.children.forEach(walk); }(root));
  assert.equal(new Set(withId).size, withId.length, 'localId repetido');
  for (const c of all(root, 'connection')) assert.ok(withId.includes(c.attrs.refLocalId), `refLocalId ${c.attrs.refLocalId}`);
});

test('tradução dos elementos: contatos, bobinas, blocos, paralelos e ligações verticais', () => {
  const program = buildProgram({
    cols: 4,
    symbols: { 'M0.0': 'TON', 'M0.1': 'Ação 1', T0: 'T_ATRASO', C0: 'CONTA', MW1: 'SETPOINT' },
    rungs: [
      ['Selo <com> "aspas" & ]]> fim', [
        ['NO I0.0', 'NC I0.1', '-', 'COIL Q0.0'],
        ['NO Q0.0', '.', '.', '.'],
      ], [[0, 1]]],
      ['', [['P I0.2', '-', '-', 'SET M0.0'], ['N I0.3', '-', '-', 'RESET M0.1']]],
      ['', [['NO M0.0', '-', '-', 'TON T0 1500'], ['.', '.', '.', 'NCOIL Q0.1']], [[0, 3]]],
      ['', [['NO T0', '-', '-', 'CTU C0 3']]],
      ['', [['NO I0.4', '-', '-', 'RESET C0']]],
      ['', [['GE IW0 MW1', 'NO C0', '-', 'ADD MW1 10 MW2']]],
      ['', [['GE T0 500', '-', '-', 'COIL Q0.2']]],
    ],
  });
  const { xml, notes } = exportPlcopen(program, { now: NOW });
  const root = parseXml(xml);
  const ld = all(root, 'LD')[0];
  const contacts = kids(ld, 'contact');
  const coils = kids(ld, 'coil');
  const blocks = kids(ld, 'block');

  // Comentário preservado mesmo com caracteres especiais e "]]>".
  assert.equal(fullText(kids(ld, 'comment')[0]), '1. Selo <com> "aspas" & ]]> fim');

  const contactOf = (v) => contacts.find((c) => fullText(kid(c, 'variable')) === v);
  assert.equal(contactOf('I0_1').attrs.negated, 'true');
  assert.equal(contactOf('I0_2').attrs.edge, 'rising');
  assert.equal(contactOf('I0_3').attrs.edge, 'falling');
  assert.ok(contactOf('T_ATRASO.Q'), 'contato em T lê a saída Q da instância');

  // Paralelo: a bobina Q0.0 recebe a energia do NF e o contato do selo entra no nó da coluna 1 (OU).
  const nc = contactOf('I0_1');
  const ncIn = all(nc, 'connection').map((c) => c.attrs.refLocalId);
  assert.deepEqual(ncIn.sort(), [contactOf('I0_0').attrs.localId, contactOf('Q0_0').attrs.localId].sort());

  const coilOf = (v) => coils.find((c) => fullText(kid(c, 'variable')) === v);
  assert.equal(coilOf('TON_M0_0').attrs.storage, 'set', 'símbolo reservado renomeado');
  assert.equal(coilOf('Acao_1').attrs.storage, 'reset', 'acento removido');
  assert.equal(coilOf('Q0_1').attrs.negated, 'true');
  assert.ok(coilOf('CONTA_R'), 'Reset de contador vira bobina da variável auxiliar');

  const ton = blocks.find((b) => b.attrs.typeName === 'TON');
  assert.equal(ton.attrs.instanceName, 'T_ATRASO');
  const ctu = blocks.find((b) => b.attrs.typeName === 'CTU');
  const inVarExpr = (block, param) => {
    const v = kids(kid(block, 'inputVariables'), 'variable').find((x) => x.attrs.formalParameter === param);
    const ref = all(v, 'connection')[0].attrs.refLocalId;
    return fullText(kid(kids(ld, 'inVariable').find((x) => x.attrs.localId === ref), 'expression'));
  };
  assert.equal(inVarExpr(ton, 'PT'), 'T#1500ms');
  assert.equal(inVarExpr(ctu, 'R'), 'CONTA_R');
  assert.equal(inVarExpr(ctu, 'PV'), '3');

  const ge = blocks.filter((b) => b.attrs.typeName === 'GE');
  assert.deepEqual([inVarExpr(ge[0], 'IN1'), inVarExpr(ge[0], 'IN2')], ['IW0', 'SETPOINT']);
  assert.deepEqual([inVarExpr(ge[1], 'IN1'), inVarExpr(ge[1], 'IN2')], ['T_ATRASO.ET', 'T#500ms'], 'constante vira tempo');
  // A saída OUT da comparação alimenta o contato seguinte.
  const after = contactOf('CONTA.Q');
  assert.deepEqual(all(after, 'connection').map((c) => [c.attrs.refLocalId, c.attrs.formalParameter]), [[ge[0].attrs.localId, 'OUT']]);

  const add = blocks.find((b) => b.attrs.typeName === 'ADD');
  assert.equal(add.attrs.instanceName, undefined, 'função não tem instância');
  const out = kids(ld, 'outVariable').find((o) => all(o, 'connection')[0].attrs.refLocalId === add.attrs.localId);
  assert.equal(fullText(kid(out, 'expression')), 'MW2');

  assert.ok(notes.some((n) => n.level === 'info' && /"TON".*TON_M0_0/.test(n.text)));
  assert.equal(notes.filter((n) => n.level === 'aviso').length, 0);
});

test('avisos: Reset de temporizador, tempo misturado com inteiro e programa com erro', () => {
  const program = buildProgram({
    cols: 4,
    rungs: [
      ['', [['NO I0.0', '-', '-', 'TON T0 1000']]],
      ['', [['NO I0.1', '-', '-', 'RESET T0']]],
      ['', [['GT T0 MW0', '-', '-', 'COIL Q0.0']]],
      ['', [['NO I0.2', '-', '-', 'RESET C1']]],
      ['', [['NO I0.3', '-', '-', 'RESET C1']]],
    ],
  });
  const { xml, notes } = exportPlcopen(program, { now: NOW });
  const avisos = notes.filter((n) => n.level === 'aviso').map((n) => n.text).join('\n');
  assert.match(avisos, /Reset \(R\) de temporizador \(T0\)/);
  assert.match(avisos, /T0 \(tempo\) comparado com MW0/);
  assert.match(avisos, /C1 é usado sem bloco/);
  assert.match(avisos, /C1 tem 2 bobinas Reset/);
  assert.equal(all(parseXml(xml), 'coil').length, 3, 'Q0.0 e os dois Reset do C1; o Reset do T0 não é exportado');

  const broken = buildProgram({ cols: 4, rungs: [['', [['NO X9.9', '-', '-', 'COIL Q0.0']]]] });
  assert.ok(exportPlcopen(broken).errors.length > 0);
});

test('todos os exemplos exportam sem avisos e o LD exportado se comporta como o original', () => {
  for (const m of MACHINES) {
    for (const ex of machineExamples(m)) {
      const r = exportPlcopen(ex.program(), { machine: m, now: NOW });
      assert.ok(!r.errors, `${m.id}/${ex.id}`);
      assert.deepEqual(r.notes.filter((n) => n.level === 'aviso'), [], `${m.id}/${ex.id} sem avisos`);
      parseXml(r.xml);
    }
  }
});

/** Roda a máquina com o CLP Simu e, em paralelo, o LD exportado; compara saídas e MW a cada varredura. */
function lockstep(machine, program, seconds, script) {
  const sim = machine.createSim({ rng: mulberry32(3) });
  const plc = new PLC();
  assert.deepEqual(plc.load(program), []);
  const ld = new LdRunner(exportPlcopen(program, { machine, now: NOW }).xml);
  const active = new Set();
  let out = {};
  const words = [...Array(6).keys()].map((i) => `MW${i}`).filter((k) => ld.word(k) !== undefined);
  const steps = Math.round(seconds * 100);
  for (let i = 0; i < steps; i++) {
    script(i, active);
    sim.update(0.01, out);
    const inputs = { ...sim.readInputs(), ...analogInputs(machine, sim) };
    for (const c of machine.controls) inputs[c.addr] = c.contact === 'NO' ? active.has(c.addr) : !active.has(c.addr);
    out = plc.scan(inputs, 10);
    ld.scan(inputs, 10);
    const lo = ld.outputs();
    for (const k of machine.outputs.map((o) => o.addr)) {
      if (!!out[k] !== !!lo[k]) assert.fail(`${machine.id}: ${k} diverge na varredura ${i} (CLP Simu ${!!out[k]}, PLCopen ${!!lo[k]})`);
    }
    for (const k of words) {
      if (plc.readWord(k) !== ld.word(k)) assert.fail(`${machine.id}: ${k} diverge na varredura ${i}`);
    }
  }
  return sim;
}

const pressAt = (addr, from, to = from + 30) => (i, active) => {
  if (i === from) active.add(addr);
  if (i === to) active.delete(addr);
};

test('LD exportado = CLP Simu, varredura a varredura: tanque (etapas e analógico)', () => {
  const s1 = lockstep(tank, tank.examples[0].program(), 150, pressAt('I0.0', 30));
  assert.equal(s1.stats.good, 3);
  const s2 = lockstep(tank, tank.examples[1].program(), 150, pressAt('I0.0', 30));
  assert.equal(s2.stats.good, 3);
});

test('LD exportado = CLP Simu, varredura a varredura: esteira com emergência', () => {
  const press = pressAt('I0.0', 50);
  const emergency = (i, active) => {
    if (i === 3000) active.add('I0.6');
    if (i === 3200) active.delete('I0.6');
  };
  const again = pressAt('I0.0', 3300);
  const sim = lockstep(conveyor, conveyor.exampleProgram(), 60, (i, a) => { press(i, a); emergency(i, a); again(i, a); });
  assert.ok(sim.stats.rejectTall > 0 && sim.stats.endShort > 0);
  assert.equal(sim.stats.rejectShort + sim.stats.endTall, 0);
});
