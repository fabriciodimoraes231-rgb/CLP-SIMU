// Modo "o simulador se conecta ao CLP": o simulador é o cliente (mestre) Modbus TCP e o CLP real é o servidor.
// A cada ciclo: escreve os sensores/botões da máquina na memória do CLP → (opcional) escreve os analógicos →
// lê as saídas do programa do CLP e aplica na máquina simulada.
//
// Serve para CLPs que respondem como escravo Modbus TCP sem programação de comunicação (comum em Delta, WEG e
// Altus). O programa do CLP usa as memórias escritas pelo simulador no lugar das entradas físicas.
//
// Áreas configuráveis (endereço Modbus 0-based, como no protocolo; consulte o manual do CLP):
//   entradas  coils (FC 15)                 ou holding (FC 16, 16 bits por registrador, I0.0 = bit 0)
//   saídas    coils (FC 1), entradas discretas (FC 2) ou holding (FC 3, 16 bits por registrador)
//   analógicos holding (FC 16), um registrador por IW (opcional)

import { ModbusClient, ModbusError, EX } from './modbus.mjs';
import { bitIndex, keyFromIndex } from '../src/engine/iomap.js';

export const CLIENT_DEFAULTS = {
  host: '192.168.1.10',
  port: 502,
  unitId: 1,
  periodMs: 50,
  inputs: { table: 'coils', start: 0 },
  outputs: { table: 'coils', start: 0 },
  analogs: null,
};

const INPUT_TABLES = ['coils', 'holding'];
const OUTPUT_TABLES = ['coils', 'discrete', 'holding'];
const RETRY_MS = 2000;

/**
 * IPv4 de rede privada, link-local ou loopback. Por segurança o simulador só se conecta a esses endereços:
 * um CLP de bancada ligado por cabo direto ou numa rede de laboratório.
 */
export function isPrivateIPv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(host ?? '').trim());
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some((x) => x > 255)) return false;
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

/** Quantos pontos a máquina usa: maior índice + 1 (I0.0 = 0 … I1.0 = 8). */
export function machinePoints(machine) {
  const count = (list) => Math.max(0, ...list.map((x) => bitIndex(x.addr) + 1));
  return {
    inputs: count(machine.inputs),
    outputs: count(machine.outputs),
    analogs: Math.max(0, ...(machine.analogs ?? []).map((a) => a.reg + 1)),
  };
}

/**
 * Valida a configuração vinda da página. Retorna { config } ou { error } (mensagem para o usuário).
 * machine é opcional: com ela, confere se as áreas cabem no espaço de endereços.
 */
export function validateClientConfig(raw, machine = null) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const host = String(c.host ?? '').trim();
  if (!isPrivateIPv4(host)) {
    return { error: `IP do CLP inválido: "${host}". Use um IPv4 de rede privada (192.168.x.x, 10.x.x.x, 172.16–31.x.x) ou link-local (169.254.x.x).` };
  }
  if (!intIn(c.port, 1, 65535)) return { error: 'Porta inválida: use de 1 a 65535 (o padrão do Modbus TCP é 502).' };
  if (!intIn(c.unitId, 0, 255)) return { error: 'Unit ID inválido: use de 0 a 255 (geralmente 1).' };
  if (!intIn(c.periodMs, 10, 1000)) return { error: 'Período de troca inválido: use de 10 a 1000 ms.' };
  const area = (a, tables, name) => {
    if (!a || !tables.includes(a.table)) return `${name}: tipo de área inválido.`;
    if (!intIn(a.start, 0, 65535)) return `${name}: endereço inicial inválido (0 a 65535).`;
    return null;
  };
  const err = area(c.inputs, INPUT_TABLES, 'Entradas') ?? area(c.outputs, OUTPUT_TABLES, 'Saídas');
  if (err) return { error: err };
  let analogs = null;
  if (c.analogs) {
    if (!intIn(c.analogs.start, 0, 65535)) return { error: 'Analógicos: endereço inicial inválido (0 a 65535).' };
    analogs = { start: c.analogs.start };
  }
  const config = {
    host, port: c.port, unitId: c.unitId, periodMs: c.periodMs,
    inputs: { table: c.inputs.table, start: c.inputs.start },
    outputs: { table: c.outputs.table, start: c.outputs.start },
    analogs,
  };
  if (machine) {
    const p = machinePoints(machine);
    const size = (table, bits) => (table === 'holding' ? Math.ceil(bits / 16) : bits);
    if (config.inputs.start + size(config.inputs.table, p.inputs) > 65536) return { error: 'Entradas: a área passa do endereço 65535.' };
    if (config.outputs.start + size(config.outputs.table, p.outputs) > 65536) return { error: 'Saídas: a área passa do endereço 65535.' };
    if (analogs && analogs.start + p.analogs > 65536) return { error: 'Analógicos: a área passa do endereço 65535.' };
  }
  return { config };
}

/** Bits → registradores de 16 bits (bit 0 do primeiro registrador = primeiro ponto). */
export function packWords(bits) {
  const regs = new Array(Math.ceil(bits.length / 16)).fill(0);
  bits.forEach((v, i) => { if (v) regs[i >> 4] |= 1 << (i & 15); });
  return regs;
}

export function unpackWords(regs, count) {
  return Array.from({ length: count }, (_, i) => !!((regs[i >> 4] >> (i & 15)) & 1));
}

/** Mensagem para o usuário a partir de um erro de comunicação. */
export function describeError(err, config) {
  const where = `${config.host}:${config.port}`;
  if (err instanceof ModbusError) {
    const hint = {
      [EX.ILLEGAL_FUNCTION]: 'o CLP não aceita esta função; troque o tipo de área (coils ou holding)',
      [EX.ILLEGAL_ADDRESS]: 'endereço fora do mapa do CLP; confira o endereço inicial no manual',
      [EX.ILLEGAL_VALUE]: 'quantidade ou valor recusado pelo CLP',
      [EX.DEVICE_FAILURE]: 'falha interna no CLP',
    }[err.code] ?? `exceção ${err.code}`;
    return `O CLP respondeu com erro na função ${err.fc}: ${hint}.`;
  }
  switch (err?.code) {
    case 'ECONNREFUSED': return `${where} recusou a conexão: confira se o Modbus TCP (servidor) está habilitado no CLP e a porta.`;
    case 'EHOSTUNREACH': case 'ENETUNREACH': return `Sem rota para ${config.host}: confira o cabo e o IP do notebook (mesma faixa do CLP).`;
    case 'ECONNRESET': return `O CLP fechou a conexão (${where}).`;
    default: return err?.message?.includes('Tempo esgotado')
      ? `Sem resposta de ${where}: confira o cabo, os IPs e se o CLP está ligado.`
      : `Falha de comunicação com ${where}: ${err?.message ?? err}`;
  }
}

export class ModbusPoller {
  /**
   * config: configuração validada · runner: PlantRunner (entradas, analógicos e saídas da máquina)
   * opts: { connect, watchdogMs, now, log, onStatus }
   */
  constructor(config, runner, { connect = (o) => ModbusClient.connect(o), watchdogMs = 1000, now = () => Date.now(), log = () => {}, onStatus = () => {} } = {}) {
    this.config = config;
    this.runner = runner;
    this.connectFn = connect;
    this.watchdogMs = watchdogMs;
    this.now = now;
    this.log = log;
    this.onStatus = onStatus;
    this.points = machinePoints(runner.machine);
    this.client = null;
    this.running = false;
    this.state = 'parado';
    this.message = '';
    this.cycles = 0;
    this.errors = 0;
    this.lastCycleMs = null;
    this.lastOk = 0;
    this.tripped = false;
    this.done = null;
    this.wdTimer = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastOk = this.now();
    // Watchdog independente do laço: o laço pode estar esperando reconexão ou uma resposta lenta.
    this.wdTimer = setInterval(() => this.checkWatchdog(), 100);
    this.wdTimer.unref?.();
    this.done = this.loop();
  }

  setStatus(state, message = '') {
    const changed = state !== this.state || message !== this.message;
    this.state = state;
    this.message = message;
    if (changed) this.onStatus(this.status());
  }

  status() {
    return {
      state: this.state, message: this.message, plc: `${this.config.host}:${this.config.port}`,
      cycles: this.cycles, errors: this.errors, lastCycleMs: this.lastCycleMs, periodMs: this.config.periodMs,
      tripped: this.tripped,
    };
  }

  async loop() {
    const sleep = (ms) => new Promise((ok) => { setTimeout(ok, ms).unref?.(); });
    while (this.running) {
      if (!this.client || this.client.closed) {
        this.setStatus('conectando', `Conectando em ${this.config.host}:${this.config.port}…`);
        try {
          this.client = await this.connectFn({
            host: this.config.host, port: this.config.port, unitId: this.config.unitId, timeoutMs: 1000,
          });
          if (!this.running) break;
          this.log(`Simulador conectado ao CLP ${this.config.host}:${this.config.port}`);
        } catch (err) {
          this.client = null;
          this.errors++;
          this.checkWatchdog();
          this.setStatus('erro', describeError(err, this.config));
          await sleep(RETRY_MS);
          continue;
        }
      }
      const t0 = this.now();
      try {
        await this.cycle();
        this.cycles++;
        this.lastOk = this.now();
        this.lastCycleMs = this.lastOk - t0;
        if (this.tripped) this.log('Comunicação com o CLP restabelecida');
        this.tripped = false;
        this.setStatus('ok', '');
      } catch (err) {
        this.errors++;
        this.setStatus('erro', describeError(err, this.config));
        // Exceção Modbus: a conexão continua; erro de rede/tempo: reconecta.
        if (!(err instanceof ModbusError)) {
          this.client?.close();
          this.client = null;
        }
        this.checkWatchdog();
        if (err instanceof ModbusError) await sleep(500);
      }
      this.checkWatchdog();
      await sleep(Math.max(0, this.config.periodMs - (this.now() - t0)));
    }
  }

  /** Sem troca bem-sucedida por watchdogMs: a máquina para (saídas em 0). */
  checkWatchdog() {
    if (this.now() - this.lastOk > this.watchdogMs && !this.tripped) {
      this.tripped = true;
      this.runner.outputs = {};
      this.log(`Watchdog: ${this.watchdogMs} ms sem resposta do CLP, saídas da máquina desligadas`);
      this.onStatus(this.status());
    }
  }

  inputBits() {
    const bits = new Array(this.points.inputs).fill(false);
    for (const [k, v] of Object.entries(this.runner.inputs)) {
      const i = bitIndex(k);
      if (i >= 0 && i < bits.length) bits[i] = !!v;
    }
    return bits;
  }

  /** Um ciclo de troca de dados, com requisições em sequência (muitos CLPs não aceitam várias em paralelo). */
  async cycle() {
    const c = this.config;
    const client = this.client;
    const bits = this.inputBits();
    if (bits.length) {
      if (c.inputs.table === 'coils') await client.writeCoils(c.inputs.start, bits);
      else await client.writeRegisters(c.inputs.start, packWords(bits));
    }
    if (c.analogs && this.points.analogs) {
      await client.writeRegisters(c.analogs.start, this.runner.analogs.slice(0, this.points.analogs));
    }
    const n = this.points.outputs;
    if (!n) return;
    let outs;
    if (c.outputs.table === 'coils') outs = await client.readCoils(c.outputs.start, n);
    else if (c.outputs.table === 'discrete') outs = await client.readDiscreteInputs(c.outputs.start, n);
    else outs = unpackWords(await client.readHoldingRegisters(c.outputs.start, Math.ceil(n / 16)), n);
    const outputs = {};
    outs.forEach((v, i) => { if (v) outputs[keyFromIndex('Q', i)] = true; });
    this.runner.outputs = outputs;
  }

  /**
   * Para a troca de dados. Antes de desconectar, zera as entradas no CLP (best effort): botões NF passam a valer
   * 0, como se o DESLIGA estivesse apertado, e nenhum sensor fica "preso" ligado no programa do CLP.
   */
  async stop() {
    this.running = false;
    clearInterval(this.wdTimer);
    const client = this.client;
    this.client = null;
    this.runner.outputs = {};
    if (client && !client.closed) {
      try {
        const zeros = new Array(this.points.inputs).fill(false);
        if (zeros.length) {
          if (this.config.inputs.table === 'coils') await client.writeCoils(this.config.inputs.start, zeros);
          else await client.writeRegisters(this.config.inputs.start, packWords(zeros));
        }
      } catch { /* CLP fora do ar: nada a fazer */ }
      client.close();
    }
    await this.done?.catch(() => {});
    this.setStatus('parado', '');
  }
}
