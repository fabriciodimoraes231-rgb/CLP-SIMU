// Aplicação: liga o CLP, o editor ladder e a máquina simulada.

import { PLC } from '../engine/plc.js';
import { compileProgram, normalizeProgram, createProgram, programAddresses } from '../engine/program.js';
import { compareAddress, parseAddress, toInt16 } from '../engine/address.js';
import {
  machineModbusMap, toRegister, wordsToRegisters, applyHoldingWrite, unpackArea, sanitizeBytes, bitIndex,
} from '../engine/iomap.js';
import { MACHINES, machineExamples } from '../machines/index.js';
import { exportPlcopen } from '../engine/plcopen.js';
import { analogInputs } from '../machines/common.js';
import { LadderEditor } from './editor.js';
import { PlantLink } from './plant-link.js';
import { esc, storage, debounce, fmtTimePair } from './util.js';

const SCAN_MS = 10;
const MAX_STEPS_PER_FRAME = 500;
const WATCHDOG_MS = 1000;
const KEY_MACHINE = 'clpsimu:machine';
const KEY_CONTROL = 'clpsimu:control';
const KEY_WATCHDOG = 'clpsimu:watchdog';
const KEY_CLIENT = 'clpsimu:cliente';
const keyProgram = (id) => `clpsimu:program:${id}`;

const $ = (id) => document.getElementById(id);
const els = {
  machineSelect: $('machineSelect'), btnRun: $('btnRun'), btnStop: $('btnStop'), speed: $('speed'),
  status: $('status'), scanInfo: $('scanInfo'), btnExample: $('btnExample'), btnNew: $('btnNew'),
  btnExport: $('btnExport'), fileImport: $('fileImport'), palette: $('palette'), ladder: $('ladder'),
  errors: $('errors'), props: $('props'), machineName: $('machineName'), machineDesc: $('machineDesc'),
  canvas: $('machineCanvas'), controls: $('controls'), extras: $('extras'), stats: $('stats'),
  ioTable: $('ioTable'), addrList: $('addrList'), wordList: $('wordList'), toast: $('toast'),
  exampleList: $('exampleList'), exportList: $('exportList'), exportNotes: $('exportNotes'),
  controlMode: $('controlMode'), modbusPane: $('modbusPane'), modbusStatus: $('modbusStatus'),
  modbusMap: $('modbusMap'), watchdog: $('watchdog'), modbusTitle: $('modbusTitle'), clientForm: $('clientForm'),
};

const state = {
  machine: null,
  sim: null,
  program: null,
  plc: new PLC(),
  running: false,
  speed: 1,
  outputs: {},
  inputs: {},
  controls: new Map(),
  errors: [],
  steps: 0,
  mode: 'interno',
  lastWrite: null, // última escrita do supervisório nas MW (modo servidor)
  extOutputs: {},  // saídas do CLP externo, vindas da planta do servidor
};

// Modos de controle:
//   interno   o ladder da página controla a máquina
//   servidor  o ladder da página, publicado como escravo Modbus para um supervisório (HMI/SCADA)
//   externo   CLP de fora: o CLP se conecta ao simulador (Modbus TCP, porta 5020)
//   cliente   CLP de fora: o simulador se conecta ao CLP (IP do CLP, porta 502)
// Nos dois modos de CLP externo a máquina roda no servidor (tempo real); a página é o painel.
const MODES = ['interno', 'servidor', 'externo', 'cliente'];
state.mode = MODES.includes(storage.get(KEY_CONTROL)) ? storage.get(KEY_CONTROL) : 'interno';

const isExternal = () => state.mode === 'externo' || state.mode === 'cliente';
const isClient = () => state.mode === 'cliente';
const isServer = () => state.mode === 'servidor';
const usesBridge = () => state.mode !== 'interno';

// Configuração do modo "o simulador se conecta ao CLP". Os modelos são pontos de partida: confira os
// endereços Modbus no manual do CLP.
const CLIENT_DEFAULT = {
  host: '192.168.1.10', port: 502, unitId: 1, periodMs: 50,
  inputs: { table: 'coils', start: 0 }, outputs: { table: 'coils', start: 100 }, analogs: null,
};
const CLIENT_PRESETS = {
  generico: { label: 'Genérico', apply: {} },
  delta: {
    label: 'Delta DVP (entradas em M100, saídas em Y0)',
    apply: { inputs: { table: 'coils', start: 2048 + 100 }, outputs: { table: 'coils', start: 1280 }, analogs: { start: 4096 + 100 } },
  },
};
const clientConfig = () => ({ ...CLIENT_DEFAULT, ...(storage.get(KEY_CLIENT) ?? {}) });
// Só conecta com uma configuração que o usuário aplicou (nunca no IP de exemplo, que pode ser outro equipamento).
const appliedClientConfig = () => (storage.get(KEY_CLIENT) ? clientConfig() : null);

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

// ---------------------------------------------------------------------------
// Símbolos e mensagens
// ---------------------------------------------------------------------------

const analogOf = (key) => state.machine?.analogs?.find((a) => `IW${a.reg}` === key) ?? null;

function describe(key) {
  const m = state.machine;
  const io = m && [...m.inputs, ...m.outputs].find((x) => x.addr === key);
  if (io) return { symbol: io.symbol, desc: io.desc, fixed: true };
  const an = analogOf(key);
  if (an) return { symbol: an.symbol, desc: an.desc, fixed: true };
  const s = state.program?.symbols?.[key];
  return s ? { symbol: s, desc: '', fixed: false } : null;
}

let toastTimer;
function notify(msg) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 3500);
}

const editor = new LadderEditor(
  { root: els.ladder, props: els.props, palette: els.palette },
  {
    symbol: (key) => describe(key)?.symbol ?? '',
    describe,
    notify,
    onChange: (errors) => {
      state.errors = errors;
      renderErrors();
      saveProgram();
      refreshProgramViews();
    },
  },
);

// ---------------------------------------------------------------------------
// Programa: salvar, carregar, exportar
// ---------------------------------------------------------------------------

const saveProgram = debounce(() => {
  if (state.machine && state.program) storage.set(keyProgram(state.machine.id), state.program);
}, 400);

const refreshProgramViews = debounce(() => {
  buildIoTable();
  buildAddrList();
  refreshServerIo();
}, 250);

/** No modo servidor, as MW do mapa Modbus acompanham o programa (usadas ou com símbolo). */
function refreshServerIo() {
  if (!isServer() || !state.machine) return;
  link.setIo(ioFor(state.machine));
  buildModbusMap();
}

function setProgram(program) {
  state.program = program;
  state.errors = compileProgram(program).errors;
  editor.setProgram(program);
  renderErrors();
  buildIoTable();
  buildAddrList();
  refreshServerIo();
  storage.set(keyProgram(state.machine.id), program);
}

function renderErrors() {
  const errs = state.errors;
  if (!errs.length) {
    els.errors.hidden = true;
    els.errors.innerHTML = '';
    return;
  }
  const shown = errs.slice(0, 8);
  els.errors.hidden = false;
  els.errors.innerHTML = `<strong>${errs.length} ${errs.length === 1 ? 'problema' : 'problemas'} no programa</strong>`
    + `<ul>${shown.map((e, i) => `<li><button type="button" data-err="${i}">Degrau ${e.rung + 1}, linha ${e.row + 1}, coluna ${e.col + 1}: ${esc(e.message)}</button></li>`).join('')}</ul>`
    + (errs.length > shown.length ? `<p class="muted">… e mais ${errs.length - shown.length}.</p>` : '');
}

els.errors.addEventListener('click', (e) => {
  const b = e.target.closest('[data-err]');
  if (!b || state.running) return;
  const err = state.errors[Number(b.dataset.err)];
  if (!err) return;
  editor.select(err.rung, err.row, err.col);
  els.ladder.querySelector(`[data-ri="${err.rung}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
});

function loadExample(ex) {
  if (state.running) return;
  if (!window.confirm(`Substituir o programa atual pelo exemplo "${ex.name}"?`)) return;
  setProgram(ex.program());
  notify('Programa de exemplo carregado. Clique em RUN e depois em LIGA.');
}

// Menus suspensos (exemplos, exportação): fecham com Esc ou clique fora; só um aberto por vez.
const menus = [];

function setupMenu(button, list) {
  const menu = {
    get isOpen() { return !list.hidden; },
    open() {
      for (const m of menus) m.close();
      list.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      // Alinhado ao botão, mas sem passar da borda direita da janela (telas estreitas).
      list.style.left = '0px';
      const over = list.getBoundingClientRect().right - (document.documentElement.clientWidth - 8);
      if (over > 0) list.style.left = `${-over}px`;
      list.querySelector('button')?.focus();
    },
    close() {
      list.hidden = true;
      button.setAttribute('aria-expanded', 'false');
    },
    toggle() { if (menu.isOpen) menu.close(); else menu.open(); },
  };
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    menu.close();
    button.focus();
  });
  document.addEventListener('click', (e) => {
    if (menu.isOpen && !button.parentElement.contains(e.target)) menu.close();
  });
  menus.push(menu);
  return menu;
}

const closeMenus = () => menus.forEach((m) => m.close());
const exampleMenu = setupMenu(els.btnExample, els.exampleList);
const exportMenu = setupMenu(els.btnExport, els.exportList);

function renderExampleMenu() {
  const list = machineExamples(state.machine);
  els.btnExample.textContent = list.length > 1 ? 'Carregar exemplo ▾' : 'Carregar exemplo';
  els.btnExample.setAttribute('aria-haspopup', list.length > 1 ? 'true' : 'false');
  els.exampleList.innerHTML = list.length > 1
    ? list.map((x, i) => `<button type="button" data-example="${i}"><b>${esc(x.name)}</b>${x.desc ? `<small>${esc(x.desc)}</small>` : ''}</button>`).join('')
    : '';
  exampleMenu.close();
}

els.btnExample.addEventListener('click', () => {
  if (state.running) return;
  const list = machineExamples(state.machine);
  if (list.length === 1) loadExample(list[0]);
  else exampleMenu.toggle();
});
els.exampleList.addEventListener('click', (e) => {
  const b = e.target.closest('[data-example]');
  if (!b) return;
  exampleMenu.close();
  loadExample(machineExamples(state.machine)[Number(b.dataset.example)]);
});

els.btnNew.addEventListener('click', () => {
  if (state.running) return;
  if (!window.confirm('Apagar o programa atual e começar do zero?')) return;
  setProgram(createProgram());
});

function download(filename, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function exportPlcopenFile() {
  const result = exportPlcopen(state.program, { machine: state.machine });
  if (result.errors) {
    notify('Corrija os problemas do programa antes de exportar para PLCopen XML.');
    return;
  }
  const filename = `programa-${state.machine.id}.xml`;
  download(filename, result.xml, 'application/xml');
  const warn = result.notes.filter((n) => n.level === 'aviso').length;
  els.exportNotes.innerHTML = `
    <div class="notes-head">
      <strong>Exportado para PLCopen XML: ${esc(filename)}</strong>
      <button type="button" class="btn small ghost" data-close-notes aria-label="Fechar as observações da exportação">✕</button>
    </div>
    <p>Formato de troca da IEC 61131-3 (TC6 XML 2.01), usado pelo OpenPLC Editor e pelo Beremiz. Programa
      <code>${esc(result.pouName)}</code>, tarefa de 10 ms. Importação nesses editores <b>ainda não testada</b>:
      confira o desenho e compile lá antes de usar.${warn ? ` <b>${warn} ${warn === 1 ? 'ponto precisa' : 'pontos precisam'} de atenção.</b>` : ''}</p>
    ${result.notes.length ? `<ul>${result.notes.map((n) => `<li class="${n.level}">${n.level === 'aviso' ? '<b>Atenção:</b> ' : ''}${esc(n.text)}</li>`).join('')}</ul>` : ''}`;
  els.exportNotes.hidden = false;
}

els.btnExport.addEventListener('click', () => exportMenu.toggle());
els.exportList.addEventListener('click', (e) => {
  const b = e.target.closest('[data-export]');
  if (!b) return;
  exportMenu.close();
  if (b.dataset.export === 'plcopen') exportPlcopenFile();
  else download(`programa-${state.machine.id}.json`, JSON.stringify(state.program, null, 2), 'application/json');
});
els.exportNotes.addEventListener('click', (e) => {
  if (e.target.closest('[data-close-notes]')) els.exportNotes.hidden = true;
});

els.fileImport.addEventListener('change', async () => {
  const file = els.fileImport.files?.[0];
  els.fileImport.value = '';
  if (!file || state.running) return;
  if (file.size > 2_000_000) { notify('Arquivo grande demais (máx. 2 MB).'); return; }
  try {
    const program = normalizeProgram(JSON.parse(await file.text()));
    if (!program) throw new Error('formato');
    setProgram(program);
    notify(`Programa "${file.name}" importado.`);
  } catch {
    notify('Não foi possível ler o arquivo: não é um programa exportado por este simulador.');
  }
});

// ---------------------------------------------------------------------------
// RUN / STOP
// ---------------------------------------------------------------------------

function run() {
  if (state.running) return;
  const errors = state.plc.load(state.program);
  if (errors.length) {
    state.errors = errors;
    editor.setErrors(errors);
    renderErrors();
    notify('Corrija os problemas do programa antes de executar.');
    return;
  }
  state.running = true;
  state.outputs = {};
  closeMenus();
  editor.setRunning(true, state.plc);
  updateRunUi();
}

function stop() {
  if (!state.running) return;
  state.running = false;
  state.outputs = {};
  editor.setRunning(false);
  updateRunUi();
}

function updateRunUi() {
  const ext = isExternal();
  els.btnRun.disabled = state.running || ext;
  els.btnRun.title = ext ? 'Com CLP externo quem controla a máquina é o CLP, via Modbus' : '';
  els.btnStop.disabled = !state.running;
  els.status.textContent = ext ? 'EXTERNO' : state.running ? 'RUN' : 'STOP';
  els.status.className = `status ${ext ? 'ext' : state.running ? 'run' : 'stop'}`;
  for (const b of [els.btnExample, els.btnNew, els.machineSelect, els.controlMode]) b.disabled = state.running;
  els.fileImport.disabled = state.running;
  els.fileImport.closest('label').classList.toggle('disabled', state.running);
  els.speed.disabled = ext;
  els.speed.title = ext ? 'Com CLP externo a máquina roda em tempo real no servidor: velocidade fixa em 1×' : '';
  if (ext) els.speed.value = '1';
  els.modbusPane.hidden = !usesBridge();
  els.modbusTitle.textContent = {
    servidor: 'CLP interno · servidor Modbus TCP',
    externo: 'CLP externo · o CLP se conecta ao simulador',
    cliente: 'CLP externo · o simulador se conecta ao CLP',
  }[state.mode] ?? '';
  els.modbusPane.querySelectorAll('[data-mode]').forEach((el) => { el.hidden = el.dataset.mode !== state.mode; });
  document.body.classList.toggle('is-running', state.running);
  document.body.classList.toggle('is-external', ext);
}

els.btnRun.addEventListener('click', run);
els.btnStop.addEventListener('click', stop);
els.speed.addEventListener('change', () => { state.speed = Number(els.speed.value) || 1; });

// ---------------------------------------------------------------------------
// Modbus TCP: planta virtual de um CLP externo, ou CLP interno como servidor para um supervisório
// ---------------------------------------------------------------------------

const link = new PlantLink({
  onChange: (kind, msg) => {
    if (kind === 'state' || kind === 'replaced') renderModbusStatus();
    if (kind === 'hr') applySupervisorWrite(msg);
    if (kind === 'plant') applyPlant(msg);
    if (kind === 'notice') notify(msg.text);
  },
});

/** Estado da planta que roda no servidor → espelho local (desenho, painel, tabelas). */
function applyPlant(msg) {
  if (!isExternal()) return;
  Object.assign(state.sim, msg.state);
  const inputs = unpackArea(sanitizeBytes(msg.i) ?? [], 'I');
  (Array.isArray(msg.a) ? msg.a : []).forEach((v, i) => { inputs[`IW${i}`] = v; });
  state.inputs = inputs;
  state.extOutputs = link.outputs;
  // Botões e opções do painel acompanham o servidor (inclusive o pulso mínimo de 300 ms).
  els.controls.querySelectorAll('[data-ctl]').forEach((b) => {
    const on = !!msg.controls?.[controlOf(b).addr];
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
  els.extras.querySelectorAll('input[data-extra]').forEach((input) => {
    const v = msg.extras?.[Number(input.dataset.extra)];
    if (typeof v === 'boolean' && document.activeElement !== input) input.checked = v;
  });
}

const watchdogMs = () => (els.watchdog.checked ? WATCHDOG_MS : 0);

/** MW expostas no mapa Modbus: as usadas no programa ou com símbolo. */
function modbusWords() {
  const p = state.program;
  if (!p) return [];
  const keys = new Set([...programAddresses(p), ...Object.keys(p.symbols ?? {})]);
  return [...keys].filter((k) => parseAddress(k)?.area === 'MW').sort(compareAddress)
    .map((addr) => ({ addr, symbol: p.symbols?.[addr] ?? '', desc: '' }));
}

function ioFor(machine) {
  const pick = ({ addr, symbol, desc }) => ({ addr, symbol, desc });
  return {
    inputs: machine.inputs.map(pick),
    outputs: machine.outputs.map(pick),
    analogs: (machine.analogs ?? []).map(({ reg, symbol, desc, unit, scale }) => ({ reg, symbol, desc, unit, scale })),
    words: isServer() ? modbusWords() : [],
  };
}

function helloFor(machine) {
  return {
    type: 'hello',
    role: isServer() ? 'clp' : 'planta',
    mode: isClient() ? 'cliente' : 'servidor',
    client: isClient() ? appliedClientConfig() : null,
    machine: { id: machine.id, name: machine.name },
    io: ioFor(machine),
    watchdogMs: isServer() ? 0 : watchdogMs(),
  };
}

/** Escrita do supervisório nos registradores holding: grava nas MW do CLP e confirma para a ponte. */
function applySupervisorWrite(msg) {
  const done = isServer() ? applyHoldingWrite(state.plc.words, msg) : null;
  link.ackHolding(msg.seq);
  if (!done) return;
  state.lastWrite = { items: done, at: new Date() };
  renderModbusStatus();
  updateModbusMap();
  updateIoTable();
  if (state.running) editor.refreshSvgs();
}

/** Valores analógicos da máquina na escala dos registradores (índice = registrador). */
function analogRegisters() {
  const regs = [];
  for (const a of state.machine.analogs ?? []) regs[a.reg] = toRegister(a.read(state.sim), a.scale);
  return Array.from(regs, (v) => v ?? 0);
}

/** Saídas que movem a máquina: do CLP interno em RUN ou do CLP externo (planta do servidor). */
function currentOutputs() {
  if (isExternal()) return state.extOutputs;
  return state.running ? state.outputs : {};
}

function setControlMode(mode) {
  const next = MODES.includes(mode) ? mode : 'interno';
  stop();
  state.mode = next;
  state.lastWrite = null;
  state.extOutputs = {};
  storage.set(KEY_CONTROL, next);
  els.controlMode.value = next;
  if (usesBridge()) link.open(helloFor(state.machine));
  else link.close();
  if (!isExternal()) state.speed = Number(els.speed.value) || 1;
  resetMachineView();
  renderClientForm();
  updateRunUi();
  buildModbusMap();
  renderModbusStatus();
}

els.controlMode.addEventListener('change', () => setControlMode(els.controlMode.value));
els.watchdog.checked = storage.get(KEY_WATCHDOG) !== false;
els.watchdog.addEventListener('change', () => {
  storage.set(KEY_WATCHDOG, els.watchdog.checked);
  link.setWatchdog(watchdogMs());
});
els.modbusStatus.addEventListener('click', (e) => {
  if (e.target.closest('[data-action="retake"]')) link.open(helloFor(state.machine));
});

// ---- formulário do modo "o simulador se conecta ao CLP" ----------------------------------

function renderClientForm(draft = null) {
  const f = els.clientForm;
  if (!isClient()) {
    f.innerHTML = '';
    return;
  }
  const c = draft ?? clientConfig();
  const opt = (value, label, cur) => `<option value="${value}"${value === cur ? ' selected' : ''}>${label}</option>`;
  f.innerHTML = `
    <div class="cf-grid">
      <label>IP do CLP<input name="host" value="${esc(c.host)}" inputmode="decimal" spellcheck="false" autocomplete="off"></label>
      <label>Porta<input name="port" type="number" min="1" max="65535" value="${c.port}"></label>
      <label>Unit ID<input name="unitId" type="number" min="0" max="255" value="${c.unitId}"></label>
      <label>Troca a cada (ms)<input name="periodMs" type="number" min="10" max="1000" value="${c.periodMs}"></label>
      <label>Entradas (I) vão para
        <select name="inTable">${opt('coils', 'Coils (FC 15)', c.inputs.table)}${opt('holding', 'Holding, 16 bits/reg (FC 16)', c.inputs.table)}</select></label>
      <label>a partir do endereço<input name="inStart" type="number" min="0" max="65535" value="${c.inputs.start}"></label>
      <label>Saídas (Q) vêm de
        <select name="outTable">${opt('coils', 'Coils (FC 1)', c.outputs.table)}${opt('discrete', 'Entradas discretas (FC 2)', c.outputs.table)}${opt('holding', 'Holding, 16 bits/reg (FC 3)', c.outputs.table)}</select></label>
      <label>a partir do endereço<input name="outStart" type="number" min="0" max="65535" value="${c.outputs.start}"></label>
      ${state.machine.analogs?.length ? `
        <label class="chk cf-wide"><input type="checkbox" name="anOn" ${c.analogs ? 'checked' : ''}> Escrever os analógicos (IW) em holding (FC 16)</label>
        <label>a partir do endereço<input name="anStart" type="number" min="0" max="65535" value="${c.analogs?.start ?? 0}"></label>` : ''}
    </div>
    <div class="cf-actions">
      <label>Modelo <select name="preset">${Object.entries(CLIENT_PRESETS).map(([k, p]) => opt(k, esc(p.label), '')).join('')}</select></label>
      <button type="button" class="btn small" data-action="preset">Preencher</button>
      <button type="submit" class="btn small run">Aplicar e conectar</button>
    </div>
    <p class="mb-sub">Endereços Modbus começando em 0, como no protocolo. Confira no manual do CLP (alguns manuais
      numeram a partir de 1 ou usam 40001 para o primeiro registrador holding).</p>`;
}

function readClientForm() {
  const f = els.clientForm;
  const v = (name) => f.elements[name]?.value ?? '';
  const n = (name) => Number(v(name));
  return {
    host: v('host').trim(), port: n('port'), unitId: n('unitId'), periodMs: n('periodMs'),
    inputs: { table: v('inTable'), start: n('inStart') },
    outputs: { table: v('outTable'), start: n('outStart') },
    analogs: f.elements.anOn?.checked ? { start: n('anStart') } : null,
  };
}

els.clientForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const c = readClientForm();
  storage.set(KEY_CLIENT, c);
  link.setClient(c);
  buildModbusMap();
  notify(`Conectando ao CLP em ${c.host}:${c.port}…`);
});
els.clientForm.addEventListener('click', (e) => {
  if (!e.target.closest('[data-action="preset"]')) return;
  const preset = CLIENT_PRESETS[els.clientForm.elements.preset.value];
  const draft = { ...readClientForm(), ...preset.apply };
  renderClientForm(draft);
  notify('Modelo preenchido. Confira os endereços no manual do CLP e clique em Aplicar e conectar.');
});

const fmtMs = (ms) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1).replace('.', ',')} s`);

const fmtClockTime = (d) => d.toLocaleTimeString('pt-BR');

function renderModbusStatus() {
  if (!usesBridge()) return;
  const server = isServer();
  const st = link.status;
  const line = (tone, html) => `<p class="mb-line ${tone}"><span class="dot" aria-hidden="true"></span><span>${html}</span></p>`;
  let html = '';
  switch (link.state) {
    case 'connecting':
      html = line('wait', 'Conectando ao servidor local…');
      break;
    case 'unavailable':
      html = line('bad', 'Servidor local indisponível. Rode <code>npm start</code> na pasta do CLP Simu; a página tenta de novo a cada 2 s.');
      break;
    case 'replaced':
      html = line('wait', `Outra aba assumiu ${server ? 'a conexão Modbus' : 'a planta virtual'}. <button type="button" class="btn small" data-action="retake">Assumir nesta aba</button>`);
      break;
    case 'open': {
      if (!st) {
        html = line('wait', 'Conectado. Aguardando o servidor…');
        break;
      }
      if (isClient()) {
        html = clientStatusHtml(st, line);
        break;
      }
      if (!st.modbus) {
        html = line('bad', 'Servidor Modbus desligado (porta em uso ou <code>MODBUS_PORT=off</code>). Veja o terminal do <code>npm start</code>.');
        break;
      }
      const addr = `<code>${esc(st.modbus.host)}:${esc(st.modbus.port)}</code>`;
      const n = st.clients.length;
      html = n
        ? line('ok', `Servidor Modbus TCP em ${addr} · ${n} cliente${n > 1 ? 's' : ''} (${st.clients.map(esc).join(', ')})`)
          + `<p class="mb-sub">${st.requests.toLocaleString('pt-BR')} requisições · última há ${st.idleMs == null ? '—' : fmtMs(st.idleMs)}</p>`
        : line('wait', `Servidor Modbus TCP em ${addr} · aguardando ${server ? 'um supervisório (HMI/SCADA)' : 'um CLP externo'} se conectar`);
      if (!server && st.tripped) html += line('bad', 'Watchdog atuou: saídas desligadas por falta de comunicação. Voltam quando o CLP escrever de novo.');
      if (server && !state.running) html += line('wait', 'CLP em STOP: as coils ficam em 0. No RUN as MW voltam a 0 (partida a frio).');
      if (server && state.lastWrite) {
        const w = state.lastWrite;
        const items = w.items.slice(0, 3).map(({ key, value }) => {
          const sym = describe(key)?.symbol;
          return `<code>${esc(key)}</code>${sym ? ` ${esc(sym)}` : ''} ← ${value}`;
        }).join(', ') + (w.items.length > 3 ? ` e mais ${w.items.length - 3}` : '');
        html += `<p class="mb-sub">Última escrita do supervisório: ${items} · ${fmtClockTime(w.at)}</p>`;
      }
      break;
    }
    default:
      break;
  }
  if (els.modbusStatus.innerHTML !== html) els.modbusStatus.innerHTML = html;
}

/** Situação do modo "o simulador se conecta ao CLP". */
function clientStatusHtml(st, line) {
  if (st.clientError) return line('bad', `Configuração recusada: ${esc(st.clientError)}`);
  const p = st.poller;
  if (!p) return line('wait', 'Preencha os dados do CLP e clique em <b>Aplicar e conectar</b>.');
  const plc = `<code>${esc(p.plc)}</code>`;
  let html;
  if (p.state === 'ok') {
    html = line('ok', `Trocando dados com o CLP ${plc} a cada ${p.periodMs} ms`)
      + `<p class="mb-sub">${p.cycles.toLocaleString('pt-BR')} trocas · última levou ${p.lastCycleMs ?? '—'} ms · ${p.errors} erro(s)</p>`;
  } else if (p.state === 'conectando') {
    html = line('wait', `Conectando ao CLP ${plc}…`);
  } else if (p.state === 'erro') {
    html = line('bad', esc(p.message));
  } else {
    html = line('wait', 'Comunicação parada.');
  }
  if (p.tripped) html += line('bad', 'Watchdog: sem resposta do CLP por 1 s. A máquina está parada até a comunicação voltar.');
  return html;
}

/** Endereço no CLP de um ponto do simulador, no modo cliente (ex.: "coil 2148", "HR 10.3"). */
function clientAddress(c, kind, key) {
  if (kind === 'IR') return c.analogs ? `HR ${c.analogs.start + Number(key.slice(2))}` : '—';
  const area = kind === 'DI' ? c.inputs : c.outputs;
  const i = bitIndex(key);
  if (area.table === 'holding') return `HR ${area.start + (i >> 4)}.${i & 15}`;
  return `${area.table === 'discrete' ? 'DI' : 'coil'} ${area.start + i}`;
}

let mbRows = [];

function buildModbusMap() {
  const m = state.machine;
  if (!m) return;
  els.modbusPane.querySelectorAll('[data-machine-id]').forEach((el) => { el.textContent = m.id; });
  if (!usesBridge()) {
    els.modbusMap.innerHTML = '';
    mbRows = [];
    return;
  }
  const words = isServer() ? modbusWords() : [];
  const rows = machineModbusMap(m, words);
  if (isClient()) {
    const c = clientConfig();
    for (const r of rows) {
      r.plcAddr = clientAddress(c, r.table, r.table === 'IR' ? `IW${r.index}` : r.addr);
      r.ref = r.plcAddr;
    }
  }
  const groups = isClient()
    ? [
      ['DI', 'Entradas da máquina → o simulador escreve no CLP'],
      ['COIL', 'Saídas do programa do CLP → o simulador lê'],
      ['IR', 'Analógicos → o simulador escreve no CLP'],
    ]
    : isServer()
    ? [
      ['DI', 'Entradas discretas · FC 2 (entradas I)'],
      ['COIL', 'Coils · FC 1 (saídas Q, só leitura: quem escreve é o ladder)'],
      ['IR', 'Registradores de entrada · FC 4 (IW, analógicos)'],
      ['HR', 'Registradores holding · FC 3, 6, 16 (MW, leitura e escrita)'],
    ]
    : [
      ['DI', 'Entradas discretas · FC 2 (o CLP lê)'],
      ['COIL', 'Coils · FC 1, 5, 15 (o CLP escreve)'],
      ['IR', 'Registradores de entrada · FC 4 (analógicos)'],
    ];
  const short = { DI: 'DI', COIL: 'Coil', IR: 'IR', HR: 'HR' };
  els.modbusMap.innerHTML = `
    <table class="io mb-map">
      <thead><tr><th scope="col">Modbus</th><th scope="col">${isClient() ? 'No CLP' : 'Ref.'}</th><th scope="col">End.</th><th scope="col">Símbolo</th><th scope="col">Estado</th></tr></thead>
      <tbody>${groups.filter(([t]) => rows.some((r) => r.table === t)).map(([t, title]) => `
        <tr class="grp"><th colspan="5" scope="colgroup">${title}</th></tr>
        ${rows.filter((r) => r.table === t).map((r, i) => `
          <tr data-mb="${t}:${i}"><td class="mono">${isClient() ? (t === 'DI' ? 'escreve' : t === 'COIL' ? 'lê' : 'escreve') : `${short[t]} ${r.index}`}</td><td class="mono${isClient() ? '' : ' muted'}">${esc(r.ref)}</td>
            <td class="mono">${esc(r.addr ?? '—')}</td><td title="${esc(r.desc)}">${esc(r.symbol)}</td>
            <td>${t === 'IR' || t === 'HR' ? '' : '<span class="led"></span>'}<span class="val"></span></td></tr>`).join('')}`).join('')}
        ${isServer() && !words.length ? `
          <tr class="grp"><th colspan="5" scope="colgroup">Registradores holding · FC 3, 6, 16</th></tr>
          <tr><td colspan="5" class="muted">O programa não usa MW. Holding 0–63 = MW0–MW63.</td></tr>` : ''}
      </tbody>
    </table>`;
  const byTable = { DI: [], COIL: [], IR: [], HR: [] };
  for (const r of rows) byTable[r.table].push(r);
  mbRows = [...els.modbusMap.querySelectorAll('tr[data-mb]')].map((tr) => {
    const [t, i] = tr.dataset.mb.split(':');
    const r = byTable[t][Number(i)];
    const analog = t === 'IR' ? (m.analogs ?? []).find((a) => a.reg === r.index) : null;
    return { r, analog, led: tr.querySelector('.led'), val: tr.querySelector('.val') };
  });
  updateModbusMap();
}

function updateModbusMap() {
  if (!mbRows.length) return;
  const out = currentOutputs();
  for (const row of mbRows) {
    const { r, analog } = row;
    let txt;
    if (r.table === 'IR') {
      const raw = toRegister(analog.read(state.sim), analog.scale);
      txt = `${raw} · ${(raw / analog.scale).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} ${analog.unit}`;
    } else if (r.table === 'HR') {
      txt = String(state.plc.readWord(r.addr));
    } else {
      const on = r.table === 'DI' ? !!state.inputs[r.addr] : !!out[r.addr];
      row.led.classList.toggle('on', on);
      txt = on ? '1' : '0';
    }
    if (row.val.textContent !== txt) row.val.textContent = txt;
  }
}

// ---------------------------------------------------------------------------
// Máquina
// ---------------------------------------------------------------------------

function setMachine(id) {
  stop();
  const machine = MACHINES.find((m) => m.id === id) ?? MACHINES[0];
  state.machine = machine;
  state.sim = machine.createSim();
  state.controls = new Map(machine.controls.map((c) => [c.addr, false]));
  state.inputs = {};
  els.machineSelect.value = machine.id;
  storage.set(KEY_MACHINE, machine.id);
  els.machineName.textContent = machine.name;
  els.machineDesc.textContent = machine.description;
  renderControls();
  renderExtras();
  renderExampleMenu();
  resizeCanvas();
  setProgram(normalizeProgram(storage.get(keyProgram(machine.id))) ?? machine.exampleProgram());
  state.lastWrite = null;
  state.extOutputs = {};
  els.exportNotes.hidden = true;
  if (usesBridge()) link.setHello(helloFor(machine));
  renderClientForm();
  buildModbusMap();
}

/** Volta o espelho local da máquina ao estado inicial (ao trocar de modo). */
function resetMachineView() {
  state.sim = state.machine.createSim();
  state.inputs = {};
  state.controls = new Map(state.machine.controls.map((c) => [c.addr, false]));
  renderControls();
  renderExtras();
}

els.machineSelect.innerHTML = MACHINES.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');
els.machineSelect.addEventListener('change', () => setMachine(els.machineSelect.value));

function renderControls() {
  pendingRelease.clear();
  els.controls.innerHTML = state.machine.controls.map((c, i) => `
    <button type="button" class="opbtn ${esc(c.color)}" data-ctl="${i}" aria-pressed="false"
      title="${esc(c.addr)} · contato ${c.contact === 'NO' ? 'NA' : 'NF'}${c.kind === 'latch' ? ' · com trava (clique para travar/destravar)' : ' · pulsante (segure)'}">
      <span class="cap" aria-hidden="true"></span>
      <span class="op-label">${esc(c.label)}</span>
      <span class="op-addr">${esc(c.addr)} · ${c.contact === 'NO' ? 'NA' : 'NF'}</span>
    </button>`).join('');
}

const controlOf = (el) => state.machine.controls[Number(el.dataset.ctl)];

// Pulso mínimo para botões pulsantes, medido em ciclos de varredura (e não em tempo de tela):
// um toque rápido sempre chega ao CLP, mesmo com a página lenta.
// No modo externo o pulso é maior: o CLP de fora lê as entradas por consulta periódica (polling).
const minPressSteps = () => (isExternal() ? 30 : 15);
const pressedAt = new Map();      // addr → state.steps no momento do toque
const pendingRelease = new Map(); // addr → { btn, c }

function applyControl(btn, c, on) {
  state.controls.set(c.addr, on);
  btn.classList.toggle('active', on);
  btn.setAttribute('aria-pressed', String(on));
}

function setControl(btn, c, on) {
  if (isExternal()) {
    // A máquina roda no servidor, que também garante o pulso mínimo do botão.
    applyControl(btn, c, on);
    link.sendControl(c.addr, on);
    return;
  }
  pendingRelease.delete(c.addr);
  if (c.kind === 'momentary') {
    if (on) {
      pressedAt.set(c.addr, state.steps);
    } else if (state.steps - (pressedAt.get(c.addr) ?? -Infinity) < minPressSteps()) {
      pendingRelease.set(c.addr, { btn, c });
      return;
    }
  }
  applyControl(btn, c, on);
}

function processPendingReleases() {
  for (const [addr, { btn, c }] of pendingRelease) {
    if (state.steps - (pressedAt.get(addr) ?? 0) >= minPressSteps()) {
      pendingRelease.delete(addr);
      applyControl(btn, c, false);
    }
  }
}

els.controls.addEventListener('pointerdown', (e) => {
  const b = e.target.closest('[data-ctl]');
  if (!b) return;
  const c = controlOf(b);
  if (c.kind !== 'momentary') return;
  setControl(b, c, true);
  b.setPointerCapture?.(e.pointerId);
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  els.controls.addEventListener(type, (e) => {
    const b = e.target.closest('[data-ctl]');
    if (!b) return;
    const c = controlOf(b);
    if (c.kind === 'momentary' && state.controls.get(c.addr)) setControl(b, c, false);
  });
}
els.controls.addEventListener('click', (e) => {
  const b = e.target.closest('[data-ctl]');
  if (!b) return;
  const c = controlOf(b);
  if (c.kind === 'latch') setControl(b, c, !state.controls.get(c.addr));
});
els.controls.addEventListener('keydown', (e) => {
  if (e.key !== ' ' && e.key !== 'Enter') return;
  const b = e.target.closest('[data-ctl]');
  if (!b) return;
  const c = controlOf(b);
  if (c.kind !== 'momentary') return;
  e.preventDefault();
  if (!e.repeat) setControl(b, c, true);
});
els.controls.addEventListener('keyup', (e) => {
  if (e.key !== ' ' && e.key !== 'Enter') return;
  const b = e.target.closest('[data-ctl]');
  if (!b) return;
  const c = controlOf(b);
  if (c.kind === 'momentary') setControl(b, c, false);
});

function renderExtras() {
  const extras = state.machine.extras ?? [];
  els.extras.innerHTML = extras.map((x, i) => (x.type === 'toggle'
    ? `<label class="chk"><input type="checkbox" data-extra="${i}" ${x.get(state.sim) ? 'checked' : ''}> ${esc(x.label)}</label>`
    : `<button type="button" class="btn small" data-extra="${i}">${esc(x.label)}</button>`)).join('')
    + '<button type="button" class="btn small ghost" data-extra="reset" title="Volta a máquina ao estado inicial (não altera o programa)">Reiniciar máquina</button>';
}

els.extras.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-extra]');
  if (!b) return;
  if (b.dataset.extra === 'reset') {
    if (isExternal()) link.sendReset();
    else state.sim.reset();
    return;
  }
  if (isExternal()) {
    link.sendExtra(Number(b.dataset.extra));
    return;
  }
  const x = state.machine.extras[Number(b.dataset.extra)];
  if (x?.run && x.run(state.sim) === false) notify('Entrada da esteira ocupada: aguarde a peça avançar.');
});
els.extras.addEventListener('change', (e) => {
  const input = e.target.closest('input[data-extra]');
  if (!input) return;
  if (isExternal()) link.sendExtra(Number(input.dataset.extra), input.checked);
  else state.machine.extras[Number(input.dataset.extra)]?.set(state.sim, input.checked);
});

function controlInputs() {
  const out = {};
  for (const c of state.machine.controls) {
    const on = !!state.controls.get(c.addr);
    out[c.addr] = c.contact === 'NO' ? on : !on;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Canvas
// ---------------------------------------------------------------------------

function resizeCanvas() {
  const { w, h } = state.machine.size;
  const cssW = els.canvas.clientWidth || w;
  const cssH = (cssW * h) / w;
  els.canvas.style.height = `${cssH}px`;
  const dpr = window.devicePixelRatio || 1;
  els.canvas.width = Math.round(cssW * dpr);
  els.canvas.height = Math.round(cssH * dpr);
}

new ResizeObserver(() => { if (state.machine) resizeCanvas(); }).observe(els.canvas);

function drawMachine() {
  const ctx = els.canvas.getContext('2d');
  const scale = els.canvas.width / state.machine.size.w;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  state.machine.render(ctx, state.sim, { dark: darkQuery.matches });
}

// ---------------------------------------------------------------------------
// Tabela de E/S
// ---------------------------------------------------------------------------

let ioRows = [];

function buildIoTable() {
  const m = state.machine;
  if (!m || !state.program) return;
  const used = [...programAddresses(state.program)];
  const pick = (area) => used.filter((k) => parseAddress(k)?.area === area).sort(compareAddress);
  const analogs = [...new Set([...(m.analogs ?? []).map((a) => `IW${a.reg}`), ...pick('IW')])].sort(compareAddress);
  const groups = [
    ['Entradas', m.inputs.map((x) => x.addr)],
    ['Saídas', m.outputs.map((x) => x.addr)],
    ['Entradas analógicas (IW)', analogs],
    ['Memórias', pick('M')],
    ['Memórias de palavra (MW)', pick('MW')],
    ['Temporizadores', pick('T')],
    ['Contadores', pick('C')],
  ];
  els.ioTable.innerHTML = `
    <table class="io">
      <thead><tr><th scope="col">End.</th><th scope="col">Símbolo</th><th scope="col">Estado</th></tr></thead>
      <tbody>${groups.filter(([, keys]) => keys.length).map(([title, keys]) => `
        <tr class="grp"><th colspan="3" scope="colgroup">${title}</th></tr>
        ${keys.map((k) => {
          const d = describe(k);
          const word = parseAddress(k)?.word;
          return `<tr data-key="${esc(k)}"><td class="mono">${esc(k)}</td><td title="${esc(d?.desc ?? '')}">${esc(d?.symbol ?? '—')}</td><td>${word ? '' : '<span class="led"></span>'}<span class="val"></span></td></tr>`;
        }).join('')}`).join('')}
      </tbody>
    </table>`;
  ioRows = [...els.ioTable.querySelectorAll('tr[data-key]')].map((tr) => ({
    key: tr.dataset.key, led: tr.querySelector('.led'), val: tr.querySelector('.val'),
  }));
  updateIoTable();
}

function updateIoTable() {
  const plc = state.plc;
  for (const row of ioRows) {
    const k = row.key;
    let on = false;
    let val = '';
    // Palavras primeiro: "IW0" e "MW0" começam com as mesmas letras das áreas de bits.
    if (k.startsWith('IW')) {
      const raw = toInt16(state.inputs[k] ?? 0);
      const an = analogOf(k);
      val = an ? `${raw} · ${(raw / an.scale).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} ${an.unit}` : String(raw);
    } else if (k.startsWith('MW')) val = state.running ? String(plc.readWord(k)) : '';
    else if (k[0] === 'I') on = !!state.inputs[k];
    else if (k[0] === 'Q') on = !!currentOutputs()[k];
    else if (k[0] === 'M') on = state.running && plc.read(k);
    else if (k[0] === 'T') {
      const t = state.running ? plc.timers.get(k) : null;
      on = !!t?.q;
      val = t ? fmtTimePair(t.et, t.pt) : '';
    } else if (k[0] === 'C') {
      const c = state.running ? plc.counters.get(k) : null;
      on = !!c?.q;
      val = c ? `${c.cv} / ${c.pv}` : '';
    }
    row.led?.classList.toggle('on', on);
    if (row.val.textContent !== val) row.val.textContent = val;
  }
}

/** Sugestões dos campos de endereço: bits/T/C para contatos e bobinas; palavras para comparação e aritmética. */
function buildAddrList() {
  const m = state.machine;
  const symKeys = Object.keys(state.program.symbols ?? {});
  const used = [...programAddresses(state.program)];
  const isWordOperand = (k) => ['IW', 'MW', 'T', 'C'].includes(parseAddress(k)?.area);
  const options = (keys) => [...new Set(keys)].sort(compareAddress)
    .map((k) => `<option value="${esc(k)}">${esc(describe(k)?.symbol ?? '')}</option>`).join('');
  els.addrList.innerHTML = options([
    ...m.inputs.map((x) => x.addr), ...m.outputs.map((x) => x.addr),
    ...symKeys.filter((k) => !parseAddress(k)?.word),
  ]);
  els.wordList.innerHTML = options([
    ...(m.analogs ?? []).map((a) => `IW${a.reg}`),
    ...[...symKeys, ...used].filter(isWordOperand),
  ]);
}

// ---------------------------------------------------------------------------
// Laço principal: física → entradas → varredura do CLP → saídas
// ---------------------------------------------------------------------------

function step() {
  state.steps++;
  state.sim.update(SCAN_MS / 1000, currentOutputs());
  state.inputs = { ...state.sim.readInputs(), ...controlInputs(), ...analogInputs(state.machine, state.sim) };
  if (state.running && !isExternal()) state.outputs = state.plc.scan(state.inputs, SCAN_MS);
  if (pendingRelease.size) processPendingReleases();
}

function updateStatusLine() {
  const plc = state.plc;
  if (isClient()) {
    const p = link.status?.poller;
    els.scanInfo.textContent = !link.connected ? 'servidor local desconectado'
      : !p ? 'CLP não configurado'
        : p.state === 'ok' ? `máquina no servidor · CLP ${p.plc} · troca a cada ${p.periodMs} ms`
          : `CLP ${p.plc}: ${p.state === 'conectando' ? 'conectando…' : 'sem comunicação'}`;
    return;
  }
  if (isExternal()) {
    const st = link.status;
    let txt = 'ponte desconectada';
    if (link.connected && !st?.modbus) txt = 'Modbus indisponível';
    else if (link.connected) txt = `máquina no servidor · Modbus ${st.modbus.host}:${st.modbus.port} · ${st.clients.length ? `${st.clients.length} cliente(s)` : 'aguardando o CLP'}`;
    els.scanInfo.textContent = txt;
    return;
  }
  let txt = state.running
    ? `ciclo ${SCAN_MS} ms · ${plc.scanCount.toLocaleString('pt-BR')} varreduras · ${formatClock(plc.elapsed)}`
      + (plc.mathFaults ? ` · ${plc.mathFaults.toLocaleString('pt-BR')} divisões por zero` : '')
    : 'saídas desligadas';
  if (isServer()) {
    const st = link.status;
    txt += link.connected && st?.modbus
      ? ` · Modbus ${st.modbus.port}: ${st.clients.length ? `${st.clients.length} cliente(s)` : 'sem supervisório'}`
      : ' · Modbus desconectado';
  }
  els.scanInfo.textContent = txt;
}

const formatClock = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

function updateStats() {
  els.stats.innerHTML = state.sim.statsLines()
    .map((s) => `<div class="stat ${esc(s.tone ?? '')}"><span>${esc(s.label)}</span><b>${esc(s.value)}</b></div>`)
    .join('');
}

let last = performance.now();
let acc = 0;
let lastLadder = 0;
let lastPanel = 0;

function frame(now) {
  // Até 1 s de recuperação por quadro: abas lentas seguem em tempo real; abas suspensas não "pulam".
  const elapsed = Math.min(now - last, 1000);
  last = now;
  // Com CLP externo a máquina roda no servidor: aqui só se desenha o estado recebido.
  acc = isExternal() ? 0 : acc + elapsed * state.speed;
  let n = 0;
  while (acc >= SCAN_MS && n < MAX_STEPS_PER_FRAME) {
    step();
    acc -= SCAN_MS;
    n++;
  }
  if (n >= MAX_STEPS_PER_FRAME) acc = 0;
  if (isServer() && n) {
    link.publish({ inputs: state.inputs, analogs: analogRegisters(), outputs: currentOutputs(), words: wordsToRegisters(state.plc.words) });
  }
  drawMachine();
  if (state.running && now - lastLadder > 60) {
    lastLadder = now;
    editor.refreshSvgs();
  }
  if (now - lastPanel > 120) {
    lastPanel = now;
    updateIoTable();
    updateStatusLine();
    updateStats();
    if (usesBridge()) {
      updateModbusMap();
      renderModbusStatus();
    }
  }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Início
// ---------------------------------------------------------------------------

// Altura da barra superior quando ela é fixa (a paleta e o painel lateral grudam logo abaixo).
const topbar = document.querySelector('.topbar');
new ResizeObserver(() => {
  const fixed = getComputedStyle(topbar).position === 'sticky';
  document.documentElement.style.setProperty('--topbar-h', `${fixed ? topbar.offsetHeight : 0}px`);
}).observe(topbar);

setMachine(storage.get(KEY_MACHINE) ?? MACHINES[0].id);
els.controlMode.value = state.mode;
if (usesBridge()) link.open(helloFor(state.machine));
renderClientForm();
updateRunUi();
buildModbusMap();
renderModbusStatus();
requestAnimationFrame(frame);
