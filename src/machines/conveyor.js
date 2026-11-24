// Máquina 1 — Esteira com separação de peças (vista de cima).
// Peças ALTAS devem ser empurradas pelo cilindro para a caixa de rejeito;
// peças BAIXAS seguem até o fim da esteira.

import { buildProgram } from '../engine/program.js';
import { clamp, overlap, rrect, label, lamp, floorGrid, scenePalette } from './common.js';

const W = 600;
const H = 320;
const BELT = { x0: 40, x1: 520, y0: 120, y1: 190 };
const BOX = { w: 44, d: 50 };
const BOX_Y = (BELT.y0 + BELT.y1) / 2 - BOX.d / 2;
const S_IN_X = 110;   // sensor de entrada
const S_POS_X = 340;  // sensor de posição + sensor de altura
const ROD = { x: 312, w: 48, yRet: 112, stroke: 92 }; // cabeça do cilindro: [x - w/2, x + w/2]
const BELT_SPEED = 110; // px/s
const CYL_TIME = 0.5;   // s para o curso completo
const GAP = 2;
const BIN_MAX = 24;

class ConveyorSim {
  constructor({ rng = Math.random } = {}) {
    this.rng = rng;
    this.autoFeed = true;
    this.feedInterval = 2.2;
    this.reset();
  }

  reset() {
    this.boxes = [];
    this.cyl = 0;              // 0 = recuado, 1 = avançado
    this.beltOffset = 0;
    this.feedTimer = this.feedInterval;
    this.nextId = 1;
    this.out = {};
    this.stats = { rejectTall: 0, rejectShort: 0, endTall: 0, endShort: 0 };
    this.rejectBin = [];
    this.endBin = [];
  }

  entryFree() {
    return this.boxes.every((b) => b.x > BELT.x0 + BOX.w + 16);
  }

  spawn(kind) {
    if (!this.entryFree()) return false;
    this.boxes.push({ id: this.nextId++, x: BELT.x0 + 4, y: BOX_Y, tall: kind === 'tall' });
    return true;
  }

  headY() {
    return ROD.yRet + this.cyl * ROD.stroke;
  }

  update(dt, out) {
    this.out = out;
    const motor = !!out['Q0.0'];
    const valve = !!out['Q0.1'];

    // Cilindro de simples ação: avança com o solenoide, recua por mola.
    this.cyl = clamp(this.cyl + (valve ? dt : -dt) / CYL_TIME, 0, 1);
    const head = this.headY();
    const rodL = ROD.x - ROD.w / 2;
    const rodR = ROD.x + ROD.w / 2;

    // Peça sob a cabeça do cilindro é empurrada para fora da esteira.
    for (const b of this.boxes) {
      b.held = false;
      if (overlap(b.x, b.x + BOX.w, rodL, rodR) >= BOX.w * 0.3 && head > b.y) {
        b.y = head;
        b.held = true;
      }
    }

    if (motor) {
      this.beltOffset = (this.beltOffset + BELT_SPEED * dt) % 24;
      const step = BELT_SPEED * dt;
      const order = [...this.boxes].sort((a, b) => b.x - a.x); // da frente para trás
      let limit = Infinity;
      for (const b of order) {
        if (!b.held) {
          let nx = b.x + step;
          if (nx + BOX.w > limit) nx = Math.max(b.x, limit - BOX.w);
          // Haste abaixada bloqueia as peças que vêm atrás.
          const rodBlocks = head > b.y + 4 && b.x + BOX.w <= rodL + 1;
          if (rodBlocks && nx + BOX.w > rodL) nx = Math.max(b.x, rodL - BOX.w);
          b.x = nx;
        }
        limit = b.x - GAP;
      }
    }

    // Peças que caem: na caixa de rejeito (empurradas) ou no fim da esteira.
    this.boxes = this.boxes.filter((b) => {
      if (b.y + BOX.d / 2 > BELT.y1) {
        this.stats[b.tall ? 'rejectTall' : 'rejectShort']++;
        this.rejectBin.push(b.tall);
        if (this.rejectBin.length > BIN_MAX) this.rejectBin.shift();
        return false;
      }
      if (b.x + BOX.w / 2 > BELT.x1) {
        this.stats[b.tall ? 'endTall' : 'endShort']++;
        this.endBin.push(b.tall);
        if (this.endBin.length > BIN_MAX) this.endBin.shift();
        return false;
      }
      return true;
    });

    if (this.autoFeed) {
      this.feedTimer += dt;
      if (this.feedTimer >= this.feedInterval && this.spawn(this.rng() < 0.4 ? 'tall' : 'short')) {
        this.feedTimer = 0;
      }
    }
  }

  readInputs() {
    const at = (x) => this.boxes.filter((b) => b.x <= x && b.x + BOX.w >= x);
    const atPos = at(S_POS_X);
    return {
      'I0.2': at(S_IN_X).length > 0,
      'I0.3': atPos.length > 0,
      'I0.4': this.cyl <= 0.02,
      'I0.5': this.cyl >= 0.98,
      'I0.7': atPos.some((b) => b.tall),
    };
  }

  statsLines() {
    const s = this.stats;
    const errors = s.rejectShort + s.endTall;
    return [
      { label: 'Altas no rejeito', value: String(s.rejectTall) },
      { label: 'Baixas na saída', value: String(s.endShort) },
      { label: 'Erros de separação', value: String(errors), tone: errors ? 'bad' : 'good' },
      { label: 'Peças na esteira', value: String(this.boxes.length) },
    ];
  }
}

// ---------------------------------------------------------------------------
// Desenho
// ---------------------------------------------------------------------------

function drawBin(ctx, P, x, y, w, h, title, items) {
  ctx.fillStyle = P.bin;
  rrect(ctx, x, y, w, h, 6);
  ctx.fill();
  ctx.strokeStyle = P.binEdge;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.stroke();
  ctx.setLineDash([]);
  const s = 11;
  const perRow = Math.max(1, Math.floor((w - 8) / (s + 3)));
  items.forEach((tall, i) => {
    const cx = x + 5 + (i % perRow) * (s + 3);
    const cy = y + h - 5 - s - Math.floor(i / perRow) * (s + 3);
    if (cy < y + 16) return;
    ctx.fillStyle = tall ? P.boxTall : P.boxShort;
    ctx.fillRect(cx, cy, s, s);
  });
  label(ctx, title, x + w / 2, y + 9, { color: P.muted, size: 10, align: 'center' });
}

function drawBox(ctx, P, b) {
  if (b.tall) {
    ctx.fillStyle = 'rgba(0,0,0,.28)';
    rrect(ctx, b.x + 5, b.y + 5, BOX.w, BOX.d, 4);
    ctx.fill();
  }
  ctx.fillStyle = b.tall ? P.boxTall : P.boxShort;
  rrect(ctx, b.x, b.y, BOX.w, BOX.d, 4);
  ctx.fill();
  ctx.strokeStyle = P.boxEdge;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.strokeStyle = 'rgba(0,0,0,.18)';
  ctx.beginPath();
  ctx.moveTo(b.x + BOX.w / 2, b.y + 2);
  ctx.lineTo(b.x + BOX.w / 2, b.y + BOX.d - 2);
  ctx.stroke();
  label(ctx, b.tall ? 'ALTA' : 'baixa', b.x + BOX.w / 2, b.y + BOX.d / 2, {
    color: P.boxText, size: 9, align: 'center', weight: 700,
  });
}

function photoEye(ctx, P, x, active, extraLed) {
  ctx.strokeStyle = active ? P.beamOn : P.beamOff;
  ctx.lineWidth = active ? 2 : 1.5;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(x, BELT.y0 - 4);
  ctx.lineTo(x, BELT.y1 + 4);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = P.metalDark;
  rrect(ctx, x - 4, BELT.y0 - 15, extraLed === undefined ? 8 : 18, 11, 2);
  ctx.fill();
  rrect(ctx, x - 4, BELT.y1 + 4, 8, 7, 2);
  ctx.fill();
  lamp(ctx, x, BELT.y0 - 9.5, 2.6, active, P.beamOn, P.off);
  if (extraLed !== undefined) lamp(ctx, x + 9, BELT.y0 - 9.5, 2.6, extraLed, '#f59e0b', P.off);
}

function render(ctx, sim, { dark }) {
  const P = scenePalette(dark);
  const out = sim.out;
  const inp = sim.readInputs();
  floorGrid(ctx, P, W, H);

  drawBin(ctx, P, ROD.x - 52, 214, 104, 96, 'Rejeito (altas)', sim.rejectBin);
  drawBin(ctx, P, 530, 104, 64, 104, 'Saída (baixas)', sim.endBin);

  // Estrutura e lona da esteira
  ctx.fillStyle = P.metalDark;
  rrect(ctx, BELT.x0 - 12, BELT.y0 - 6, BELT.x1 - BELT.x0 + 24, BELT.y1 - BELT.y0 + 12, 10);
  ctx.fill();
  ctx.fillStyle = P.belt;
  ctx.fillRect(BELT.x0, BELT.y0, BELT.x1 - BELT.x0, BELT.y1 - BELT.y0);
  ctx.save();
  ctx.beginPath();
  ctx.rect(BELT.x0, BELT.y0, BELT.x1 - BELT.x0, BELT.y1 - BELT.y0);
  ctx.clip();
  ctx.strokeStyle = P.beltStripe;
  ctx.lineWidth = 3;
  for (let x = BELT.x0 - 24 + sim.beltOffset; x < BELT.x1 + 24; x += 24) {
    ctx.beginPath();
    ctx.moveTo(x, BELT.y0);
    ctx.lineTo(x + 10, (BELT.y0 + BELT.y1) / 2);
    ctx.lineTo(x, BELT.y1);
    ctx.stroke();
  }
  ctx.restore();
  ctx.fillStyle = P.metal;
  rrect(ctx, BELT.x0 - 10, BELT.y0 - 3, 10, BELT.y1 - BELT.y0 + 6, 4);
  ctx.fill();
  rrect(ctx, BELT.x1, BELT.y0 - 3, 10, BELT.y1 - BELT.y0 + 6, 4);
  ctx.fill();

  // Motor
  const motorOn = !!out['Q0.0'];
  ctx.strokeStyle = P.metalDark;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(BELT.x0 - 5, 90);
  ctx.lineTo(BELT.x0 - 5, BELT.y0 - 3);
  ctx.stroke();
  lamp(ctx, BELT.x0 - 5, 80, 14, motorOn, P.on, P.off);
  label(ctx, 'M', BELT.x0 - 5, 80, { color: motorOn ? '#fff' : P.metalDark, size: 12, align: 'center', weight: 700 });
  label(ctx, 'Motor Q0.0', BELT.x0 - 5, 56, { color: P.muted, size: 10, align: 'center' });

  for (const b of sim.boxes) drawBox(ctx, P, b);

  // Sensores
  photoEye(ctx, P, S_IN_X, inp['I0.2']);
  label(ctx, 'S1 entrada · I0.2', S_IN_X, BELT.y1 + 20, { color: P.muted, size: 10, align: 'center' });
  photoEye(ctx, P, S_POS_X, inp['I0.3'], inp['I0.7']);
  label(ctx, 'S2 posição · I0.3', S_POS_X + 20, BELT.y1 + 14, { color: P.muted, size: 10 });
  label(ctx, 'S3 altura · I0.7', S_POS_X + 20, BELT.y1 + 27, { color: P.muted, size: 10 });

  // Cilindro
  const head = sim.headY();
  const cx = ROD.x;
  ctx.fillStyle = P.metal;
  rrect(ctx, cx - 18, 20, 36, 74, 5);
  ctx.fill();
  ctx.strokeStyle = P.metalEdge;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = P.rod;
  ctx.fillRect(cx - 4, 94, 8, Math.max(0, head - 8 - 94));
  ctx.fillStyle = P.metalDark;
  rrect(ctx, cx - ROD.w / 2, head - 8, ROD.w, 8, 2);
  ctx.fill();
  label(ctx, 'Cilindro', cx, 57, { color: P.text, size: 10, align: 'center', weight: 600 });
  lamp(ctx, cx - 26, 28, 4, inp['I0.4'], P.on, P.off);
  lamp(ctx, cx - 26, 86, 4, inp['I0.5'], P.on, P.off);
  label(ctx, 'recuado I0.4', cx - 34, 28, { color: P.muted, size: 10, align: 'right' });
  label(ctx, 'avançado I0.5', cx - 34, 86, { color: P.muted, size: 10, align: 'right' });
  const valve = !!out['Q0.1'];
  ctx.fillStyle = valve ? P.on : P.off;
  rrect(ctx, cx + 22, 32, 24, 16, 3);
  ctx.fill();
  label(ctx, 'Y1', cx + 34, 40, { color: valve ? '#fff' : P.metalDark, size: 9, align: 'center', weight: 700 });
  label(ctx, 'solenoide Q0.1', cx + 52, 40, { color: P.muted, size: 10 });

  // Coluna luminosa
  ctx.fillStyle = P.metalDark;
  ctx.fillRect(573, 16, 4, 70);
  lamp(ctx, 575, 26, 9, !!out['Q0.2'], P.on, P.greenOff);
  lamp(ctx, 575, 50, 9, !!out['Q0.3'], P.red, P.redOff);
  label(ctx, 'Q0.2', 560, 26, { color: P.muted, size: 10, align: 'right' });
  label(ctx, 'Q0.3', 560, 50, { color: P.muted, size: 10, align: 'right' });
}

// ---------------------------------------------------------------------------
// Definição da máquina
// ---------------------------------------------------------------------------

export const conveyor = {
  id: 'esteira',
  name: 'Esteira com separação de peças',
  description: 'Peças altas devem ser empurradas pelo cilindro para a caixa de rejeito; peças baixas seguem até a saída. A esteira para enquanto o cilindro trabalha.',
  size: { w: W, h: H },
  inputs: [
    { addr: 'I0.0', symbol: 'B_LIGA', desc: 'Botão LIGA (NA)' },
    { addr: 'I0.1', symbol: 'B_DESLIGA', desc: 'Botão DESLIGA (NF: 1 em repouso)' },
    { addr: 'I0.2', symbol: 'S_ENTRADA', desc: 'Sensor de entrada (peça presente)' },
    { addr: 'I0.3', symbol: 'S_POSICAO', desc: 'Sensor de posição em frente ao cilindro' },
    { addr: 'I0.4', symbol: 'CIL_RECUADO', desc: 'Fim de curso: cilindro recuado' },
    { addr: 'I0.5', symbol: 'CIL_AVANCADO', desc: 'Fim de curso: cilindro avançado' },
    { addr: 'I0.6', symbol: 'EMERGENCIA', desc: 'Botão de emergência (NF: 1 em repouso)' },
    { addr: 'I0.7', symbol: 'S_ALTA', desc: 'Sensor de altura (peça alta na posição)' },
    { addr: 'I1.0', symbol: 'B_RESET', desc: 'Botão RESET (NA)' },
  ],
  outputs: [
    { addr: 'Q0.0', symbol: 'MOTOR', desc: 'Motor da esteira' },
    { addr: 'Q0.1', symbol: 'CIL_AVANCA', desc: 'Solenoide do cilindro (avança; recua por mola)' },
    { addr: 'Q0.2', symbol: 'LAMP_VERDE', desc: 'Lâmpada verde (em operação)' },
    { addr: 'Q0.3', symbol: 'LAMP_VERMELHA', desc: 'Lâmpada vermelha (parado / alarme)' },
  ],
  controls: [
    { addr: 'I0.0', label: 'LIGA', kind: 'momentary', contact: 'NO', color: 'green' },
    { addr: 'I0.1', label: 'DESLIGA', kind: 'momentary', contact: 'NC', color: 'red' },
    { addr: 'I1.0', label: 'RESET', kind: 'momentary', contact: 'NO', color: 'blue' },
    { addr: 'I0.6', label: 'EMERGÊNCIA', kind: 'latch', contact: 'NC', color: 'emergency' },
  ],
  extras: [
    { type: 'button', label: '+ Peça baixa', run: (sim) => sim.spawn('short') },
    { type: 'button', label: '+ Peça alta', run: (sim) => sim.spawn('tall') },
    { type: 'toggle', label: 'Alimentação automática', get: (sim) => sim.autoFeed, set: (sim, v) => { sim.autoFeed = v; } },
  ],
  createSim: (opts) => new ConveyorSim(opts),
  render,
  exampleProgram: () => buildProgram({
    symbols: {
      'M0.0': 'SISTEMA_ON', 'M0.1': 'CICLO_REJEITO',
      T0: 'T_AVANCO', T1: 'T_PISCA_ON', T2: 'T_PISCA_OFF', C0: 'CONT_REJEITO',
    },
    rungs: [
      ['Liga/desliga com selo. DESLIGA e EMERGÊNCIA são NF (valem 1 em repouso). Caixa de rejeito cheia (C0) desliga.', [
        ['NO I0.0', 'NO I0.1', 'NO I0.6', 'NC C0', '-', '-', 'COIL M0.0'],
        ['NO M0.0', '.', '.', '.', '.', '.', '.'],
      ], [[0, 1]]],
      ['Peça ALTA parada na posição com o cilindro recuado: inicia o ciclo de rejeito.', [
        ['NO M0.0', 'NO I0.3', 'NO I0.7', 'NO I0.4', '-', '-', 'SET M0.1'],
      ]],
      ['Solenoide do cilindro. A emergência corta o avanço.', [
        ['NO M0.1', 'NO I0.6', '-', '-', '-', '-', 'COIL Q0.1'],
      ]],
      ['Mantém o cilindro avançado por 0,5 s.', [
        ['NO M0.1', 'NO I0.5', '-', '-', '-', '-', 'TON T0 500'],
      ]],
      ['Fim do ciclo de rejeito: tempo concluído OU emergência.', [
        ['NO T0', '-', '-', '-', '-', '-', 'RESET M0.1'],
        ['NC I0.6', '.', '.', '.', '.', '.', '.'],
      ], [[0, 1]]],
      ['Conta as peças rejeitadas (borda de subida do fim de curso avançado).', [
        ['P I0.5', '-', '-', '-', '-', '-', 'CTU C0 5'],
      ]],
      ['RESET zera o contador (caixa de rejeito esvaziada).', [
        ['NO I1.0', '-', '-', '-', '-', '-', 'RESET C0'],
      ]],
      ['Motor: sistema ligado, fora do ciclo de rejeito e cilindro recuado.', [
        ['NO M0.0', 'NC M0.1', 'NO I0.4', '-', '-', '-', 'COIL Q0.0'],
      ]],
      ['Lâmpada verde: sistema em operação.', [
        ['NO M0.0', '-', '-', '-', '-', '-', 'COIL Q0.2'],
      ]],
      ['Oscilador (pisca-pisca): T1 e T2 se alternam a cada 0,5 s.', [
        ['NC T2', '-', '-', '-', '-', '-', 'TON T1 500'],
      ]],
      ['', [
        ['NO T1', '-', '-', '-', '-', '-', 'TON T2 500'],
      ]],
      ['Lâmpada vermelha: fixa com o sistema parado; pisca com a caixa de rejeito cheia.', [
        ['NC M0.0', 'NC C0', '-', '-', '-', '-', 'COIL Q0.3'],
        ['NO C0', 'NO T1', '.', '.', '.', '.', '.'],
      ], [[0, 2]]],
    ],
  }),
};
