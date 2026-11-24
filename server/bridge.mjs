// Ponte entre a página do simulador e os clientes Modbus TCP. A página se apresenta com um papel:
//
// role 'planta' (Controle: CLP externo) — a máquina é uma planta virtual de um CLP de fora. Ela roda AQUI, no
// servidor (PlantRunner), em tempo real e sem depender da aba do navegador; a página é o painel de operação
// (recebe { type: 'plant' } com o estado e manda botões/comandos). Dois sentidos de comunicação:
//   mode 'servidor': o CLP se conecta a este servidor Modbus (o CLP é o mestre)
//     máquina ──(sensores/botões)──▶ entradas discretas ──▶ CLP · máquina ◀──(atuadores)── coils ◀── CLP
//   mode 'cliente': o simulador se conecta ao CLP (ModbusPoller) e lê/escreve a memória dele;
//     o servidor Modbus local responde 0x0B para não haver dois mestres na mesma planta
//
// role 'clp' (Controle: CLP interno + servidor Modbus) — o ladder da página é um CLP escravo Modbus,
// consultado por um supervisório (HMI/SCADA):
//   entradas discretas = I · coils = Q (somente leitura: quem escreve é o ladder)
//   registradores de entrada = IW · registradores holding = MW0–MW63 (leitura e escrita: setpoints)
//
// Escrita em registrador holding: a ponte grava na tabela, avisa a página ({ type: 'hr', seq }) e só volta a
// aceitar os valores de MW publicados pela página depois que ela confirmar ter aplicado aquela escrita (hs ≥ seq).
// Assim uma leitura logo após a escrita nunca mostra o valor antigo.
//
// A ponte não conhece o transporte: a página é qualquer objeto { send(msg), close() }
// (WebSocket no servidor real; chamada direta nos testes).

import { AREA_BITS, ANALOG_REGS, HOLDING_REGS, sanitizeBytes, packArea, keyFromIndex } from '../src/engine/iomap.js';
import { normalizeAddress, parseAddress } from '../src/engine/address.js';
import { MACHINES } from '../src/machines/index.js';
import { PlantRunner } from './plant-runner.mjs';
import { ModbusPoller, validateClientConfig } from './modbus-poller.mjs';

/** Remove caracteres de controle (evita sequências de escape no terminal) e limita o tamanho. */
export const cleanText = (s, n = 60) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, n);

const MAX_WATCHDOG_MS = 10_000;

function sanitizeIo(io) {
  const list = (arr) => (Array.isArray(arr) ? arr.slice(0, AREA_BITS) : [])
    .map((x) => ({ addr: normalizeAddress(x?.addr), symbol: cleanText(x?.symbol, 32), desc: cleanText(x?.desc, 80) }))
    .filter((x) => x.addr);
  const analogs = (Array.isArray(io?.analogs) ? io.analogs.slice(0, ANALOG_REGS) : [])
    .filter((a) => Number.isInteger(a?.reg) && a.reg >= 0 && a.reg < ANALOG_REGS)
    .map((a) => ({
      reg: a.reg, symbol: cleanText(a.symbol, 32), desc: cleanText(a.desc, 80), unit: cleanText(a.unit, 8),
      scale: Number.isFinite(a.scale) && a.scale > 0 ? a.scale : 1,
    }));
  const words = (Array.isArray(io?.words) ? io.words.slice(0, HOLDING_REGS) : [])
    .map((x) => ({ addr: normalizeAddress(x?.addr), symbol: cleanText(x?.symbol, 32), desc: cleanText(x?.desc, 80) }))
    .filter((x) => x.addr && parseAddress(x.addr).area === 'MW');
  return { inputs: list(io?.inputs), outputs: list(io?.outputs), analogs, words };
}

const EMPTY_REGS = new Uint16Array(0);
const PLANT_PUSH_STEPS = 4;     // estado da planta para a página a cada 40 ms (25 quadros/s)
const CLIENT_WATCHDOG_MS = 1000;

export class PlantBridge {
  /**
   * opts: log, statusIntervalMs, now · realtime (false nos testes: a planta só anda com runner.step())
   * createRng (gerador da simulação, testes) · pollerOptions (repassadas ao ModbusPoller)
   */
  constructor({
    log = () => {}, statusIntervalMs = 250, now = () => Date.now(), realtime = true, createRng = null, pollerOptions = {},
  } = {}) {
    this.log = log;
    this.now = now;
    this.realtime = realtime;
    this.createRng = createRng;
    this.pollerOptions = pollerOptions;
    this.runner = null;   // planta do servidor (role 'planta')
    this.poller = null;   // cliente Modbus do modo 'cliente'
    this.plant = null;
    this.clients = new Map();
    this.lastRequest = 0;
    this.requests = 0;
    this.watchdogMs = 0;
    this.tripped = false;
    this.modbusAddress = null;
    this.hrSeq = 0;      // escritas em registradores holding enviadas à página
    this.lastWrite = null;
    const holding = new Uint16Array(HOLDING_REGS);
    this.holding = holding;
    const bridge = this;
    this.model = {
      coils: new Uint8Array(AREA_BITS),
      discreteInputs: new Uint8Array(AREA_BITS),
      inputRegisters: new Uint16Array(ANALOG_REGS),
      // Planta virtual não tem registradores holding; sem página conectada a resposta é 0x0B.
      get holdingRegisters() { return bridge.role === 'planta' ? EMPTY_REGS : holding; },
      isAvailable: () => this.plant !== null && !(this.role === 'planta' && this.plant.mode === 'cliente'),
      writable: (table) => !(table === 'coils' && this.role === 'clp'),
      onRequest: () => { this.lastRequest = this.now(); this.requests++; },
      onWrite: (table, start, qty) => {
        if (table === 'holdingRegisters') {
          this.pushHolding(start, qty);
          return;
        }
        this.tripped = false;
        this.applyCoils();
      },
    };
    this.modbusHooks = {
      onConnect: (info) => {
        this.clients.set(info.remote, info);
        this.log(`Modbus: cliente ${info.remote} conectado (${this.clients.size} ativo${this.clients.size > 1 ? 's' : ''})`);
        this.pushStatus();
      },
      onDisconnect: (info) => {
        this.clients.delete(info.remote);
        this.log(`Modbus: cliente ${info.remote} desconectado após ${info.requests} requisições`);
        this.pushStatus();
      },
      onReject: (info, reason) => this.log(`Modbus: conexão de ${info.remote} recusada (${reason ?? 'limite de clientes'})`),
    };
    this.timer = setInterval(() => this.tick(), statusIntervalMs);
    this.timer.unref?.();
  }

  /** Papel da página conectada: 'planta', 'clp' ou null (sem página ou antes do "hello"). */
  get role() { return this.plant?.role ?? null; }

  // ---- planta ---------------------------------------------------------------

  /** Conecta a planta. Uma planta nova substitui a anterior (outra aba do navegador). */
  connectPlant({ send, close = () => {} }) {
    if (this.plant) {
      const old = this.plant;
      this.plant = null;
      try { old.send({ type: 'replaced' }); } catch { /* conexão já fechada */ }
      old.close();
      this.log('Planta: outra aba assumiu a conexão');
    }
    const plant = { send, close, machine: null, io: null, role: null, mode: null, client: null, clientError: null };
    this.plant = plant;
    this.resetTables();
    return {
      receive: (msg) => this.receive(plant, msg),
      disconnect: () => this.disconnectPlant(plant),
    };
  }

  disconnectPlant(plant) {
    if (this.plant !== plant) return;
    this.plant = null;
    this.stopPlant();
    this.resetTables();
    this.log('Planta desconectada: entradas zeradas, clientes Modbus recebem a exceção 0x0B');
  }

  receive(plant, msg) {
    if (plant !== this.plant || !msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'hello': {
        plant.machine = { id: cleanText(msg.machine?.id, 32), name: cleanText(msg.machine?.name) };
        plant.io = sanitizeIo(msg.io);
        plant.role = msg.role === 'clp' ? 'clp' : 'planta';
        plant.mode = plant.role === 'planta' ? (msg.mode === 'cliente' ? 'cliente' : 'servidor') : null;
        this.setWatchdog(plant.role === 'clp' ? 0 : msg.watchdogMs);
        this.stopPlant();
        this.resetTables();
        const name = plant.machine.name || plant.machine.id || 'máquina sem nome';
        if (plant.role === 'clp') {
          this.applyInputs(msg);
          this.log(`CLP interno conectado como servidor Modbus: ${name}`);
        } else {
          this.startPlant(plant, msg.client);
          this.log(plant.mode === 'cliente'
            ? `Planta no servidor: ${name} · o simulador se conecta ao CLP`
            : `Planta no servidor: ${name} · aguardando o CLP no Modbus TCP`);
        }
        this.pushStatus();
        break;
      }
      case 'inputs':
        if (plant.role === 'clp') this.applyInputs(msg);
        break;
      case 'io':
        if (plant.role) plant.io = sanitizeIo(msg.io);
        break;
      case 'config':
        this.setWatchdog(msg.watchdogMs);
        if (plant.role === 'planta' && plant.mode === 'cliente' && msg.client) this.startPoller(plant, msg.client);
        this.pushStatus();
        break;
      case 'control':
        if (typeof msg.addr === 'string' && this.runner?.setControl(normalizeAddress(msg.addr), !!msg.on)) {
          this.applyPlantInputs(this.runner); // o botão aparece na tabela Modbus na hora
        }
        break;
      case 'extra': {
        if (!this.runner || !Number.isInteger(msg.index)) break;
        const text = this.runner.extra(msg.index, msg.value);
        this.applyPlantInputs(this.runner);
        if (text) plant.send({ type: 'notice', text });
        break;
      }
      case 'reset':
        if (!this.runner) break;
        this.runner.reset();
        this.applyPlantInputs(this.runner);
        break;
      default:
        break;
    }
  }

  // ---- planta no servidor ----------------------------------------------------------

  startPlant(plant, clientConfig) {
    const machine = MACHINES.find((m) => m.id === plant.machine.id);
    if (!machine) {
      plant.send({ type: 'notice', level: 'erro', text: `Máquina "${plant.machine.id}" desconhecida no servidor. Reinicie o npm start.` });
      return;
    }
    let pushCount = 0;
    this.runner = new PlantRunner(machine, {
      realtime: this.realtime,
      rng: this.createRng?.(),
      onStep: (runner) => {
        this.applyPlantInputs(runner);
        if (++pushCount % PLANT_PUSH_STEPS === 0) this.pushPlant();
      },
    });
    this.applyPlantInputs(this.runner);
    if (plant.mode === 'cliente' && clientConfig) this.startPoller(plant, clientConfig);
    this.pushPlant();
  }

  /** (Re)inicia o cliente Modbus com uma configuração nova vinda da página. */
  startPoller(plant, rawConfig) {
    if (!this.runner) return;
    this.poller?.stop();
    this.poller = null;
    const { config, error } = validateClientConfig(rawConfig, this.runner.machine);
    plant.client = config ?? null;
    plant.clientError = error ?? null;
    this.runner.outputs = {};
    if (error) {
      this.log(`Configuração do CLP recusada: ${error}`);
      return;
    }
    this.poller = new ModbusPoller(config, this.runner, {
      log: this.log, watchdogMs: CLIENT_WATCHDOG_MS, onStatus: () => this.pushStatus(), ...this.pollerOptions,
    });
    this.poller.start();
  }

  stopPlant() {
    this.runner?.stop();
    const poller = this.poller;
    this.poller = null;
    this.runner = null;
    poller?.stop().catch(() => {});
  }

  /** Sensores, botões e analógicos da planta → tabelas Modbus (e tela). */
  applyPlantInputs(runner) {
    for (let i = 0; i < AREA_BITS; i++) this.model.discreteInputs[i] = 0;
    for (const [k, v] of Object.entries(runner.inputs)) {
      const a = parseAddress(k);
      if (v && a?.area === 'I') this.model.discreteInputs[a.byte * 8 + a.bit] = 1;
    }
    runner.analogs.slice(0, ANALOG_REGS).forEach((v, i) => { this.model.inputRegisters[i] = v; });
  }

  /** Coils escritas pelo CLP (mestre) → saídas que movem a planta. */
  applyCoils() {
    if (this.role !== 'planta' || this.plant.mode !== 'servidor' || !this.runner) return;
    const out = {};
    for (let i = 0; i < AREA_BITS; i++) if (this.model.coils[i]) out[keyFromIndex('Q', i)] = true;
    this.runner.outputs = out;
  }

  pushPlant() {
    const r = this.runner;
    if (!r || !this.plant) return;
    this.plant.send({
      type: 'plant', ...r.snapshot(),
      i: packArea(r.inputs, 'I'), q: packArea(r.outputs, 'Q'), a: r.analogs,
    });
  }

  applyInputs(msg) {
    const bytes = sanitizeBytes(msg.i);
    if (bytes) {
      for (let i = 0; i < AREA_BITS; i++) this.model.discreteInputs[i] = (bytes[i >> 3] >> (i & 7)) & 1;
    }
    if (Array.isArray(msg.a)) {
      msg.a.slice(0, ANALOG_REGS).forEach((v, i) => {
        if (Number.isInteger(v) && v >= 0 && v <= 0xffff) this.model.inputRegisters[i] = v;
      });
    }
    const q = sanitizeBytes(msg.q);
    if (q) {
      for (let i = 0; i < AREA_BITS; i++) this.model.coils[i] = (q[i >> 3] >> (i & 7)) & 1;
    }
    // Valores de MW só valem depois que a página aplicou todas as escritas do supervisório.
    if (Array.isArray(msg.h) && Number.isInteger(msg.hs) && msg.hs >= this.hrSeq) {
      msg.h.slice(0, HOLDING_REGS).forEach((v, i) => {
        if (Number.isInteger(v) && v >= 0 && v <= 0xffff) this.holding[i] = v;
      });
    }
  }

  /** Repassa à página uma escrita do supervisório nos registradores holding (MW). */
  pushHolding(start, qty) {
    if (this.role !== 'clp') return;
    this.hrSeq++;
    const values = Array.from(this.holding.subarray(start, start + qty));
    this.lastWrite = { start, values, at: this.now() };
    this.plant.send({ type: 'hr', seq: this.hrSeq, start, values });
  }

  setWatchdog(ms) {
    const v = Number(ms);
    this.watchdogMs = Number.isFinite(v) ? Math.max(0, Math.min(MAX_WATCHDOG_MS, Math.round(v))) : 0;
  }

  resetTables() {
    this.model.coils.fill(0);
    this.model.discreteInputs.fill(0);
    this.model.inputRegisters.fill(0);
    this.holding.fill(0);
    this.hrSeq = 0;
    this.lastWrite = null;
    this.tripped = false;
  }

  // ---- watchdog e estado ------------------------------------------------------

  tick() {
    if (!this.plant) return;
    const idle = this.now() - this.lastRequest;
    if (this.role === 'planta' && this.plant.mode === 'servidor' && this.watchdogMs > 0 && idle > this.watchdogMs
      && this.model.coils.some((v) => v)) {
      this.model.coils.fill(0);
      this.tripped = true;
      this.log(`Watchdog: ${this.watchdogMs} ms sem comunicação Modbus, saídas desligadas`);
      this.applyCoils();
    }
    this.pushStatus();
  }

  status() {
    return {
      type: 'status',
      role: this.role,
      mode: this.plant?.mode ?? null,
      modbus: this.modbusAddress,
      clients: [...this.clients.keys()],
      requests: this.requests,
      idleMs: this.lastRequest ? this.now() - this.lastRequest : null,
      watchdogMs: this.watchdogMs,
      tripped: this.tripped,
      client: this.plant?.client ?? null,
      clientError: this.plant?.clientError ?? null,
      poller: this.poller?.status() ?? null,
    };
  }

  pushStatus() {
    if (this.plant) this.plant.send(this.status());
  }

  /** Resumo público (GET /api/planta) — usado pelas ferramentas de linha de comando. */
  snapshot() {
    return {
      connected: !!this.plant,
      role: this.role,
      mode: this.plant?.mode ?? null,
      machine: this.plant?.machine ?? null,
      io: this.plant?.io ?? null,
      modbus: this.modbusAddress,
      clients: this.clients.size,
    };
  }

  close() {
    clearInterval(this.timer);
    this.stopPlant();
  }
}
