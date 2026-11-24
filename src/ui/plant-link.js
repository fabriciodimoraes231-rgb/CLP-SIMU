// Ligação desta página com o servidor local (ponte Modbus). Transporte: WebSocket em /bridge (mesma origem).
//  role 'planta' (CLP externo): a página envia sensores/botões e analógicos; o servidor devolve as coils
//                               escritas pelo CLP externo via Modbus TCP.
//  role 'clp' (CLP interno + servidor Modbus): a página envia também as saídas Q e as memórias MW;
//                               o servidor repassa as escritas do supervisório nos registradores holding.

import { packArea, unpackArea, sanitizeBytes } from '../engine/iomap.js';

const RETRY_MS = 2000;
const ANALOG_MIN_INTERVAL = 100; // ms entre envios só de valores numéricos (mudam a cada ciclo)

export class PlantLink {
  /**
   * onChange(kind, msg): 'state' | 'status' | 'replaced' | 'hr' (escrita do supervisório)
   *   | 'plant' (estado da planta que roda no servidor) | 'notice' (aviso do servidor)
   */
  constructor({ onChange } = {}) {
    this.onChange = onChange;
    this.ws = null;
    this.wanted = false;
    this.state = 'off'; // off | connecting | open | unavailable | replaced
    this.hello = null;
    this.outputs = {};
    this.status = null;
    this.retry = null;
    this.sentI = '';
    this.sentA = '';
    this.lastAnalog = 0;
    this.hrApplied = 0; // última escrita em registrador holding já aplicada nas MW
  }

  /** Marca a escrita `seq` como aplicada: a próxima publicação libera os valores de MW na ponte. */
  ackHolding(seq) {
    this.hrApplied = Math.max(this.hrApplied, seq);
    this.sentA = ''; // força o envio
  }

  get connected() { return this.state === 'open'; }

  open(hello) {
    this.hello = hello;
    this.wanted = true;
    // Já conectado (troca entre CLP externo e servidor Modbus): basta se reapresentar.
    if (this.ws?.readyState === WebSocket.OPEN) this.setHello(hello);
    else this.connect();
  }

  /** Troca de máquina: a ponte zera a tabela de E/S ao receber um novo "hello". */
  setHello(hello) {
    this.hello = hello;
    this.outputs = {};
    this.sentI = '';
    this.sentA = '';
    this.hrApplied = 0; // a ponte zera a contagem de escritas a cada "hello"
    this.send(hello);
  }

  /** Atualiza a descrição de E/S (símbolos das MW) sem zerar as tabelas da ponte. */
  setIo(io) {
    if (this.hello) this.hello.io = io;
    this.send({ type: 'io', io });
  }

  setWatchdog(ms) {
    if (this.hello) this.hello.watchdogMs = ms;
    this.send({ type: 'config', watchdogMs: ms });
  }

  close() {
    this.wanted = false;
    clearTimeout(this.retry);
    this.outputs = {};
    this.status = null;
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.setState('off');
  }

  connect() {
    clearTimeout(this.retry);
    if (!this.wanted || this.ws) return;
    let ws;
    try {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/bridge`);
    } catch {
      this.setState('unavailable');
      this.retry = setTimeout(() => this.connect(), RETRY_MS);
      return;
    }
    this.ws = ws;
    this.setState('connecting');
    ws.onopen = () => {
      this.sentI = '';
      this.sentA = '';
      this.hrApplied = 0;
      this.setState('open');
      this.send(this.hello);
    };
    ws.onmessage = (e) => this.receive(e.data);
    ws.onerror = () => {};
    ws.onclose = () => {
      this.ws = null;
      this.outputs = {};
      this.status = null;
      if (this.state === 'replaced') return;
      if (!this.wanted) {
        this.setState('off');
        return;
      }
      this.setState('unavailable');
      this.retry = setTimeout(() => this.connect(), RETRY_MS);
    };
  }

  receive(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    switch (msg?.type) {
      case 'coils': {
        const q = sanitizeBytes(msg.q);
        if (q) this.outputs = unpackArea(q, 'Q');
        break;
      }
      case 'status':
        this.status = msg;
        break;
      case 'hr':
        if (!Number.isInteger(msg.seq)) return;
        break;
      case 'plant':
        if (!msg.state || typeof msg.state !== 'object') return;
        this.outputs = unpackArea(sanitizeBytes(msg.q) ?? [], 'Q');
        break;
      case 'notice':
        if (typeof msg.text !== 'string') return;
        break;
      case 'replaced':
        this.wanted = false;
        this.outputs = {};
        this.state = 'replaced';
        break;
      default:
        return;
    }
    this.onChange?.(msg.type, msg);
  }

  /**
   * Envia o estado quando algum bit muda; valores numéricos (analógicos, MW) no máximo a cada 100 ms.
   * outputs/words só no papel 'clp': saídas Q do ladder e os 64 registradores das MW.
   */
  publish({ inputs, analogs, outputs = null, words = null }) {
    if (this.state !== 'open') return;
    const i = packArea(inputs, 'I');
    const q = outputs ? packArea(outputs, 'Q') : null;
    const sigI = `${i.join(',')}|${q?.join(',') ?? ''}`;
    const sigA = `${analogs.join(',')}|${words?.join(',') ?? ''}|${this.hrApplied}`;
    const now = performance.now();
    const bits = sigI !== this.sentI;
    const numbers = sigA !== this.sentA && (now - this.lastAnalog >= ANALOG_MIN_INTERVAL || this.sentA === '');
    if (!bits && !numbers) return;
    this.sentI = sigI;
    if (sigA !== this.sentA) this.lastAnalog = now;
    this.sentA = sigA;
    const msg = { type: 'inputs', i, a: analogs };
    if (q) msg.q = q;
    if (words) {
      msg.h = words;
      msg.hs = this.hrApplied;
    }
    this.send(msg);
  }

  // Painel de operação da planta que roda no servidor (modos com CLP externo).
  sendControl(addr, on) { this.send({ type: 'control', addr, on: !!on }); }
  sendExtra(index, value) { this.send({ type: 'extra', index, value }); }
  sendReset() { this.send({ type: 'reset' }); }

  /** Nova configuração do modo "o simulador se conecta ao CLP" (o servidor reinicia a conexão). */
  setClient(client) {
    if (this.hello) this.hello.client = client;
    this.send({ type: 'config', watchdogMs: this.hello?.watchdogMs ?? 0, client });
  }

  send(msg) {
    if (msg && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.onChange?.('state');
  }
}
