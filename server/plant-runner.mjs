// Planta virtual rodando no servidor (Node), em tempo real, independente do navegador.
//
// Nos modos com CLP externo a máquina simulada roda aqui: assim ela não congela quando a aba fica em segundo
// plano e o tempo da física acompanha o relógio, como precisa um CLP de verdade. A página vira o painel de
// operação: mostra o estado que o servidor envia e manda de volta os botões e os comandos extras.

import { analogInputs } from '../src/machines/common.js';

export const STEP_MS = 10;          // passo da física (o mesmo do simulador no navegador)
export const MIN_PRESS_MS = 300;    // pulso mínimo dos botões pulsantes (o CLP lê por varredura/consulta)
const MAX_CATCHUP_MS = 1000;        // atraso máximo recuperado de uma vez (ex.: computador suspenso)

/** Estado da simulação em dados simples (sem funções, como o gerador aleatório), para enviar à página. */
export function simState(sim) {
  return JSON.parse(JSON.stringify(sim, (key, value) => (typeof value === 'function' ? undefined : value)));
}

export class PlantRunner {
  /**
   * machine: definição da máquina (src/machines). opts:
   *   rng        gerador aleatório da simulação (testes usam um com semente)
   *   now        relógio em ms (padrão: performance.now)
   *   realtime   false = não inicia o laço de tempo real (os testes chamam step())
   *   onStep     chamado depois de cada passo de 10 ms
   */
  constructor(machine, { rng, now = () => performance.now(), realtime = true, onStep = () => {} } = {}) {
    this.machine = machine;
    this.sim = machine.createSim(rng ? { rng } : undefined);
    this.now = now;
    this.onStep = onStep;
    this.controls = new Map(machine.controls.map((c) => [c.addr, false]));
    this.pressedAt = new Map();        // addr → simMs do toque
    this.pendingRelease = new Set();   // soltos antes do pulso mínimo
    this.outputs = {};                 // Q que movem a máquina (vindos do CLP)
    this.inputs = {};
    this.analogs = [];
    this.steps = 0;
    this.simMs = 0;
    this.timer = null;
    this.refreshInputs();
    if (realtime) this.start();
  }

  start() {
    if (this.timer) return;
    let last = this.now();
    let acc = 0;
    // O temporizador do Windows tem resolução de ~15 ms: a cada disparo roda quantos passos de 10 ms couberem.
    this.timer = setInterval(() => {
      const t = this.now();
      acc += Math.min(t - last, MAX_CATCHUP_MS);
      last = t;
      while (acc >= STEP_MS) {
        this.step();
        acc -= STEP_MS;
      }
    }, 5);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Um passo de 10 ms: física com as saídas atuais → sensores e botões → entradas. */
  step() {
    this.sim.update(STEP_MS / 1000, this.outputs);
    this.steps++;
    this.simMs += STEP_MS;
    for (const addr of this.pendingRelease) {
      if (this.simMs - (this.pressedAt.get(addr) ?? 0) >= MIN_PRESS_MS) {
        this.pendingRelease.delete(addr);
        this.controls.set(addr, false);
      }
    }
    this.refreshInputs();
    this.onStep(this);
  }

  refreshInputs() {
    const inputs = { ...this.sim.readInputs() };
    for (const c of this.machine.controls) {
      const on = !!this.controls.get(c.addr);
      inputs[c.addr] = c.contact === 'NO' ? on : !on;
    }
    this.inputs = inputs;
    const regs = [];
    for (const [key, v] of Object.entries(analogInputs(this.machine, this.sim))) regs[Number(key.slice(2))] = v;
    this.analogs = Array.from(regs, (v) => v ?? 0);
  }

  /** Botão do painel. Pulsantes ficam acionados pelo menos MIN_PRESS_MS, mesmo num toque rápido. */
  setControl(addr, on) {
    const c = this.machine.controls.find((x) => x.addr === addr);
    if (!c) return false;
    if (c.kind === 'momentary') {
      if (on) {
        this.pendingRelease.delete(addr);
        this.pressedAt.set(addr, this.simMs);
      } else if (this.simMs - (this.pressedAt.get(addr) ?? -Infinity) < MIN_PRESS_MS) {
        this.pendingRelease.add(addr);
        return true;
      }
    }
    this.controls.set(addr, !!on);
    this.refreshInputs();
    return true;
  }

  /** Comando extra da máquina (ex.: "+ Peça alta", "Alimentação automática"). Retorna um aviso ou null. */
  extra(index, value) {
    const x = this.machine.extras?.[index];
    if (!x) return null;
    if (x.type === 'toggle') x.set(this.sim, !!value);
    else if (x.run?.(this.sim) === false) return 'Entrada da esteira ocupada: aguarde a peça avançar.';
    this.refreshInputs();
    return null;
  }

  reset() {
    this.sim.reset();
    this.refreshInputs();
  }

  /** Estado para a página desenhar a máquina e o painel. */
  snapshot() {
    return {
      simMs: this.simMs,
      state: simState(this.sim),
      controls: Object.fromEntries(this.controls),
      extras: (this.machine.extras ?? []).map((x) => (x.type === 'toggle' ? !!x.get(this.sim) : null)),
    };
  }
}
