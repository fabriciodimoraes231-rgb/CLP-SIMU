// Máquina 2 — Tanque de mistura com aquecimento (processo em bateladas).
// Ciclo esperado: encher até o nível alto → aquecer até 60 °C → misturar 5 s → esvaziar.

import { buildProgram } from '../engine/program.js';
import { clamp, rrect, label, lamp, floorGrid, scenePalette, mixColor } from './common.js';

const W = 600;
const H = 320;
const TANK = { x0: 210, x1: 370, y0: 60, y1: 280 };
const INNER = { x0: TANK.x0 + 4, x1: TANK.x1 - 4, y0: TANK.y0 + 4, y1: TANK.y1 - 4 };
const AMBIENT = 22;
const FILL_RATE = 10;   // %/s
const DRAIN_RATE = 15;  // %/s
const HEAT_RATE = 4;    // °C/s
const COOL_K = 0.004;   // 1/s
const LSL = 10;         // %
const LSH = 90;         // %
const TSH = 60;         // °C
const MIX_OK = 4.5;     // s de mistura com o líquido quente
const BATCH_START = 20; // % a partir do qual o enchimento conta como um lote

class TankSim {
  constructor() { this.reset(); }

  reset() {
    this.level = 0;
    this.temp = AMBIENT;
    this.angle = 0;
    this.flow = 0;
    this.out = {};
    this.overflow = false;
    this.batch = { started: false, full: false, maxTemp: AMBIENT, mixHot: 0 };
    this.stats = { good: 0, bad: 0, overflow: false };
  }

  update(dt, out) {
    this.out = out;
    const fill = !!out['Q0.0'];
    const mix = !!out['Q0.1'];
    const heat = !!out['Q0.2'];
    const drain = !!out['Q0.3'];

    if (fill) {
      const add = Math.min(FILL_RATE * dt, 100 - this.level);
      if (add > 0) {
        this.temp = (this.temp * this.level + AMBIENT * add) / (this.level + add);
        this.level += add;
      } else {
        this.overflow = true;
        this.stats.overflow = true;
      }
    }
    if (drain) this.level = Math.max(0, this.level - DRAIN_RATE * dt);
    if (heat && this.level > 5) this.temp += HEAT_RATE * dt;
    this.temp += (AMBIENT - this.temp) * COOL_K * dt;
    if (this.level < 0.5) this.temp += (AMBIENT - this.temp) * 0.5 * dt;
    this.temp = clamp(this.temp, 0, 100);
    if (mix) this.angle += 9 * dt;
    this.flow += dt;

    // Avaliação da batelada (para o painel de resultados). Um lote começa quando o nível passa de 20 %
    // e é avaliado ao esvaziar: no padrão = encheu até 85 %, chegou a 60 °C e misturou quente por 4,5 s.
    const b = this.batch;
    if (this.level >= BATCH_START) b.started = true;
    if (this.level >= 85) b.full = true;
    if (b.full && this.level >= 80) b.maxTemp = Math.max(b.maxTemp, this.temp);
    if (b.full && mix && this.level >= 80 && this.temp >= 55) b.mixHot += dt;
    if (b.started && this.level <= LSL) {
      if (b.full && b.maxTemp >= TSH && b.mixHot >= MIX_OK) this.stats.good++;
      else this.stats.bad++;
      this.batch = { started: false, full: false, maxTemp: this.temp, mixHot: 0 };
    }
  }

  readInputs() {
    return {
      'I0.2': this.level > LSL,
      'I0.3': this.level >= LSH,
      'I0.4': this.temp >= TSH,
    };
  }

  statsLines() {
    return [
      { label: 'Nível', value: `${this.level.toFixed(0)} %` },
      { label: 'Temperatura', value: `${this.temp.toFixed(1).replace('.', ',')} °C` },
      { label: 'Lotes no padrão', value: String(this.stats.good), tone: 'good' },
      { label: 'Lotes fora do padrão', value: String(this.stats.bad), tone: this.stats.bad ? 'bad' : '' },
      ...(this.stats.overflow ? [{ label: 'Transbordo', value: 'SIM', tone: 'bad' }] : []),
    ];
  }
}

function valve(ctx, P, x, y, open, vertical = false) {
  ctx.save();
  ctx.translate(x, y);
  if (vertical) ctx.rotate(Math.PI / 2);
  ctx.beginPath();
  ctx.moveTo(-10, -8); ctx.lineTo(10, 8); ctx.lineTo(10, -8); ctx.lineTo(-10, 8); ctx.closePath();
  ctx.fillStyle = open ? P.on : P.off;
  ctx.fill();
  ctx.strokeStyle = P.metalEdge;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

function render(ctx, sim, { dark }) {
  const P = scenePalette(dark);
  const out = sim.out;
  const inp = sim.readInputs();
  floorGrid(ctx, P, W, H);

  const liquid = mixColor(P.water, P.hot, (sim.temp - AMBIENT) / (70 - AMBIENT));
  const levelY = INNER.y1 - (sim.level / 100) * (INNER.y1 - INNER.y0);

  // Tubulação de entrada
  ctx.strokeStyle = P.metal;
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.moveTo(30, 34); ctx.lineTo(250, 34); ctx.lineTo(250, TANK.y0 + 6);
  ctx.stroke();
  valve(ctx, P, 130, 34, !!out['Q0.0']);
  label(ctx, 'Válvula entrada Q0.0', 130, 16, { color: P.muted, size: 10, align: 'center' });

  // Tubulação de saída
  ctx.beginPath();
  ctx.moveTo(330, TANK.y1 - 4); ctx.lineTo(330, 300); ctx.lineTo(590, 300);
  ctx.stroke();
  valve(ctx, P, 440, 300, !!out['Q0.3']);
  label(ctx, 'Válvula saída Q0.3', 440, 282, { color: P.muted, size: 10, align: 'center' });

  // Corpo do tanque e líquido
  ctx.fillStyle = P.glass;
  rrect(ctx, TANK.x0, TANK.y0, TANK.x1 - TANK.x0, TANK.y1 - TANK.y0, 10);
  ctx.fill();
  ctx.save();
  rrect(ctx, INNER.x0, INNER.y0, INNER.x1 - INNER.x0, INNER.y1 - INNER.y0, 7);
  ctx.clip();
  ctx.fillStyle = liquid;
  ctx.globalAlpha = 0.85;
  ctx.fillRect(INNER.x0, levelY, INNER.x1 - INNER.x0, INNER.y1 - levelY);
  ctx.globalAlpha = 1;
  if (out['Q0.0']) {
    ctx.strokeStyle = mixColor(P.water, P.water, 0);
    ctx.lineWidth = 5;
    ctx.setLineDash([6, 4]);
    ctx.lineDashOffset = -sim.flow * 60;
    ctx.beginPath();
    ctx.moveTo(250, TANK.y0 + 6);
    ctx.lineTo(250, levelY);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();
  ctx.strokeStyle = P.metalEdge;
  ctx.lineWidth = 3;
  rrect(ctx, TANK.x0, TANK.y0, TANK.x1 - TANK.x0, TANK.y1 - TANK.y0, 10);
  ctx.stroke();

  // Resistência de aquecimento
  const heat = !!out['Q0.2'];
  ctx.strokeStyle = heat ? '#f97316' : P.metal;
  ctx.lineWidth = 3;
  ctx.save();
  if (heat) { ctx.shadowColor = '#f97316'; ctx.shadowBlur = 8; }
  ctx.beginPath();
  for (let i = 0, x = 228; x <= 352; i++, x += 8) {
    const y = i % 2 ? 262 : 270;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();
  label(ctx, 'Aquecedor Q0.2', 290, TANK.y1 + 12, { color: P.muted, size: 10, align: 'center' });

  // Misturador
  const mixOn = !!out['Q0.1'];
  ctx.strokeStyle = P.metalEdge;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(300, 50); ctx.lineTo(300, 236);
  ctx.stroke();
  const blade = Math.cos(sim.angle) * 26;
  ctx.fillStyle = P.metalDark;
  ctx.fillRect(300 - Math.abs(blade), 232, Math.abs(blade) * 2, 8);
  const blade2 = Math.sin(sim.angle) * 26;
  ctx.fillRect(300 - Math.abs(blade2), 232, Math.abs(blade2) * 2, 8);
  ctx.fillStyle = mixOn ? P.on : P.off;
  rrect(ctx, 286, 30, 28, 24, 4);
  ctx.fill();
  label(ctx, 'M', 300, 42, { color: mixOn ? '#fff' : P.metalDark, size: 12, align: 'center', weight: 700 });
  label(ctx, 'Misturador Q0.1', 322, 42, { color: P.muted, size: 10 });

  // Chaves de nível
  const ySensor = (pct) => INNER.y1 - (pct / 100) * (INNER.y1 - INNER.y0);
  for (const [pct, on, txt] of [[LSH, inp['I0.3'], 'Nível alto I0.3'], [LSL, inp['I0.2'], 'Nível baixo I0.2']]) {
    const y = ySensor(pct);
    ctx.fillStyle = P.metalDark;
    ctx.fillRect(TANK.x1, y - 4, 14, 8);
    lamp(ctx, TANK.x1 + 22, y, 4.5, on, P.on, P.off);
    label(ctx, txt, TANK.x1 + 32, y, { color: P.muted, size: 10 });
  }

  // Termômetro
  const tx = 168;
  ctx.fillStyle = P.bin;
  rrect(ctx, tx - 7, 80, 14, 170, 7);
  ctx.fill();
  ctx.strokeStyle = P.binEdge;
  ctx.lineWidth = 1;
  ctx.stroke();
  const tFrac = clamp(sim.temp / 100, 0, 1);
  ctx.fillStyle = liquid;
  rrect(ctx, tx - 4, 247 - tFrac * 164, 8, tFrac * 164, 4);
  ctx.fill();
  const yT = 247 - (TSH / 100) * 164;
  ctx.strokeStyle = P.red;
  ctx.beginPath(); ctx.moveTo(tx - 12, yT); ctx.lineTo(tx + 12, yT); ctx.stroke();
  lamp(ctx, tx - 22, yT, 4.5, inp['I0.4'], P.on, P.off);
  label(ctx, '60 °C I0.4', tx - 30, yT, { color: P.muted, size: 10, align: 'right' });
  label(ctx, `${sim.temp.toFixed(1).replace('.', ',')} °C`, tx, 266, { color: P.text, size: 12, align: 'center', weight: 700 });
  label(ctx, `${sim.level.toFixed(0)} %`, (TANK.x0 + TANK.x1) / 2 - 36, Math.min(levelY + 14, INNER.y1 - 30), {
    color: sim.level > 8 ? '#fff' : P.text, size: 12, align: 'center', weight: 700,
  });

  // Lâmpada de operação
  lamp(ctx, 560, 120, 10, !!out['Q0.4'], P.on, P.greenOff);
  label(ctx, 'Em operação Q0.4', 560, 142, { color: P.muted, size: 10, align: 'center' });

  if (sim.overflow) {
    label(ctx, 'TRANSBORDO!', (TANK.x0 + TANK.x1) / 2, TANK.y0 - 10, { color: P.red, size: 14, align: 'center', weight: 800 });
  }
}

export const tank = {
  id: 'tanque',
  name: 'Tanque de mistura com aquecimento',
  description: 'Processo em bateladas: encher até o nível alto, aquecer até 60 °C, misturar por 5 s e esvaziar. O painel avalia se cada lote saiu no padrão.',
  size: { w: W, h: H },
  inputs: [
    { addr: 'I0.0', symbol: 'B_LIGA', desc: 'Botão LIGA (NA)' },
    { addr: 'I0.1', symbol: 'B_DESLIGA', desc: 'Botão DESLIGA (NF: 1 em repouso)' },
    { addr: 'I0.2', symbol: 'NIVEL_BAIXO', desc: 'Chave de nível baixo (1 = líquido acima de 10%)' },
    { addr: 'I0.3', symbol: 'NIVEL_ALTO', desc: 'Chave de nível alto (1 = 90% ou mais)' },
    { addr: 'I0.4', symbol: 'TEMP_OK', desc: 'Termostato (1 = 60 °C ou mais)' },
    { addr: 'I0.5', symbol: 'B_RESET', desc: 'Botão RESET (NA)' },
  ],
  outputs: [
    { addr: 'Q0.0', symbol: 'VALV_ENTRADA', desc: 'Válvula de entrada' },
    { addr: 'Q0.1', symbol: 'MISTURADOR', desc: 'Motor do misturador' },
    { addr: 'Q0.2', symbol: 'AQUECEDOR', desc: 'Resistência de aquecimento' },
    { addr: 'Q0.3', symbol: 'VALV_SAIDA', desc: 'Válvula de saída' },
    { addr: 'Q0.4', symbol: 'LAMP_OPERACAO', desc: 'Lâmpada "em operação"' },
  ],
  // Valores analógicos expostos como registradores de entrada Modbus (modo CLP externo).
  analogs: [
    { reg: 0, symbol: 'NIVEL', desc: 'Nível do tanque em 0,1 % (0–1000)', unit: '%', scale: 10, read: (sim) => sim.level },
    { reg: 1, symbol: 'TEMPERATURA', desc: 'Temperatura em 0,1 °C (220 = 22,0 °C)', unit: '°C', scale: 10, read: (sim) => sim.temp },
  ],
  controls: [
    { addr: 'I0.0', label: 'LIGA', kind: 'momentary', contact: 'NO', color: 'green' },
    { addr: 'I0.1', label: 'DESLIGA', kind: 'momentary', contact: 'NC', color: 'red' },
    { addr: 'I0.5', label: 'RESET', kind: 'momentary', contact: 'NO', color: 'blue' },
  ],
  extras: [],
  createSim: () => new TankSim(),
  render,
  exampleProgram: sequenceProgram,
  examples: [
    { id: 'etapas', name: 'Sequência por etapas (sensores digitais)',
      desc: 'Bits de etapa M1.x, TON e CTU. Usa os sensores de nível e o termostato.', program: sequenceProgram },
    { id: 'analogico', name: 'Controle analógico (nível e temperatura)',
      desc: 'Lê IW0/IW1 e usa comparações, MOVE, ADD e DIV com setpoints em MW.', program: analogProgram },
  ],
};

function sequenceProgram() {
  return buildProgram({
    symbols: {
      'M0.0': 'SISTEMA_ON', 'M1.0': 'ETAPA_ENCHER', 'M1.1': 'ETAPA_AQUECER',
      'M1.2': 'ETAPA_MISTURAR', 'M1.3': 'ETAPA_ESVAZIAR', T0: 'T_MISTURA', C0: 'CONT_LOTES',
    },
    rungs: [
      ['Liga/desliga com selo. Depois de 3 lotes (C0) o sistema desliga sozinho.', [
        ['NO I0.0', 'NO I0.1', 'NC C0', '-', '-', '-', 'COIL M0.0'],
        ['NO M0.0', '.', '.', '.', '.', '.', '.'],
      ], [[0, 1]]],
      ['Etapa 1 – ENCHER: começa um lote com o tanque vazio e nenhuma etapa ativa.', [
        ['NO M0.0', 'NC I0.2', 'NC M1.1', 'NC M1.2', 'NC M1.3', '-', 'SET M1.0'],
      ]],
      ['Nível alto atingido: passa para a etapa 2 – AQUECER.', [
        ['NO M1.0', 'NO I0.3', '-', '-', '-', '-', 'SET M1.1'],
        ['.', '.', '.', '.', '.', '.', 'RESET M1.0'],
      ], [[0, 6]]],
      ['Temperatura atingida: passa para a etapa 3 – MISTURAR.', [
        ['NO M1.1', 'NO I0.4', '-', '-', '-', '-', 'SET M1.2'],
        ['.', '.', '.', '.', '.', '.', 'RESET M1.1'],
      ], [[0, 6]]],
      ['Tempo de mistura: 5 s.', [
        ['NO M1.2', '-', '-', '-', '-', '-', 'TON T0 5000'],
      ]],
      ['Mistura concluída: passa para a etapa 4 – ESVAZIAR.', [
        ['NO T0', '-', '-', '-', '-', '-', 'SET M1.3'],
        ['.', '.', '.', '.', '.', '.', 'RESET M1.2'],
      ], [[0, 6]]],
      ['Tanque vazio: fim do lote e contagem.', [
        ['NO M1.3', 'NC I0.2', '-', '-', '-', '-', 'RESET M1.3'],
        ['.', '.', '.', '.', '.', '.', 'CTU C0 3'],
      ], [[0, 6]]],
      ['RESET zera o contador de lotes.', [
        ['NO I0.5', '-', '-', '-', '-', '-', 'RESET C0'],
      ]],
      ['Válvula de entrada.', [
        ['NO M1.0', '-', '-', '-', '-', '-', 'COIL Q0.0'],
      ]],
      ['Misturador: liga no aquecimento e na mistura.', [
        ['NO M1.1', '-', '-', '-', '-', '-', 'COIL Q0.1'],
        ['NO M1.2', '.', '.', '.', '.', '.', '.'],
      ], [[0, 1]]],
      ['Aquecedor.', [
        ['NO M1.1', '-', '-', '-', '-', '-', 'COIL Q0.2'],
      ]],
      ['Válvula de saída.', [
        ['NO M1.3', '-', '-', '-', '-', '-', 'COIL Q0.3'],
      ]],
      ['Lâmpada de operação.', [
        ['NO M0.0', '-', '-', '-', '-', '-', 'COIL Q0.4'],
      ]],
    ],
  });
}

// Mesmo processo, agora com os valores analógicos (IW0 = nível em 0,1 %, IW1 = temperatura em 0,1 °C).
// Os setpoints ficam em MW1–MW3: no modo "CLP interno + servidor Modbus" um supervisório pode alterá-los
// (registradores holding 1–3); o próprio ladder corrige valores fora da faixa.
function analogProgram() {
  return buildProgram({
    symbols: {
      'M0.0': 'SISTEMA_ON', 'M1.0': 'ETAPA_ENCHER', 'M1.1': 'ETAPA_AQUECER',
      'M1.2': 'ETAPA_MISTURAR', 'M1.3': 'ETAPA_ESVAZIAR', 'M2.0': 'INICIALIZADO', T0: 'T_MISTURA',
      MW0: 'LOTES', MW1: 'SP_NIVEL', MW2: 'SP_TEMP', MW3: 'META_LOTES', MW4: 'TEMP_C', MW5: 'NIVEL_PCT',
    },
    rungs: [
      ['Inicialização (só na 1ª varredura após o RUN): nível 88,0 % (880), temperatura 65,0 °C (650) e meta de 3 lotes. '
        + 'Depois disso os setpoints podem ser alterados pelo supervisório.', [
        ['NC M2.0', '-', '-', '-', '-', '-', 'MOVE 880 MW1'],
        ['.', '.', '.', '.', '.', '.', 'MOVE 650 MW2'],
        ['.', '.', '.', '.', '.', '.', 'MOVE 3 MW3'],
        ['.', '.', '.', '.', '.', '.', 'SET M2.0'],
      ], [[0, 6], [1, 6], [2, 6]]],
      ['Limites do setpoint de nível: 30,0 % a 92,0 % (um valor fora da faixa é corrigido).', [
        ['GT MW1 920', '-', '-', '-', '-', '-', 'MOVE 920 MW1'],
        ['LT MW1 300', '-', '-', '-', '-', '-', 'MOVE 300 MW1'],
      ]],
      ['Limites do setpoint de temperatura: 30,0 °C a 85,0 °C.', [
        ['GT MW2 850', '-', '-', '-', '-', '-', 'MOVE 850 MW2'],
        ['LT MW2 300', '-', '-', '-', '-', '-', 'MOVE 300 MW2'],
      ]],
      ['Limites da meta de lotes: 1 a 20.', [
        ['GT MW3 20', '-', '-', '-', '-', '-', 'MOVE 20 MW3'],
        ['LT MW3 1', '-', '-', '-', '-', '-', 'MOVE 1 MW3'],
      ]],
      ['Liga/desliga com selo. Desliga sozinho quando LOTES (MW0) chega à meta (MW3).', [
        ['NO I0.0', 'NO I0.1', 'LT MW0 MW3', '-', '-', '-', 'COIL M0.0'],
        ['NO M0.0', '.', '.', '.', '.', '.', '.'],
      ], [[0, 1]]],
      ['Etapa 1 – ENCHER: começa um lote com o tanque vazio (IW0 ≤ 30, ou 3,0 %) e nenhuma etapa ativa.', [
        ['NO M0.0', 'LE IW0 30', 'NC M1.1', 'NC M1.2', 'NC M1.3', '-', 'SET M1.0'],
      ]],
      ['Nível chegou ao setpoint (IW0 ≥ SP_NIVEL): etapa 2 – AQUECER.', [
        ['NO M1.0', 'GE IW0 MW1', '-', '-', '-', '-', 'SET M1.1'],
        ['.', '.', '.', '.', '.', '.', 'RESET M1.0'],
      ], [[0, 6]]],
      ['Temperatura chegou ao setpoint (IW1 ≥ SP_TEMP): etapa 3 – MISTURAR.', [
        ['NO M1.1', 'GE IW1 MW2', '-', '-', '-', '-', 'SET M1.2'],
        ['.', '.', '.', '.', '.', '.', 'RESET M1.1'],
      ], [[0, 6]]],
      ['Tempo de mistura: 5 s.', [
        ['NO M1.2', '-', '-', '-', '-', '-', 'TON T0 5000'],
      ]],
      ['Mistura concluída: etapa 4 – ESVAZIAR.', [
        ['NO T0', '-', '-', '-', '-', '-', 'SET M1.3'],
        ['.', '.', '.', '.', '.', '.', 'RESET M1.2'],
      ], [[0, 6]]],
      ['Tanque vazio (IW0 ≤ 3,0 %): fim do lote.', [
        ['NO M1.3', 'LE IW0 30', '-', '-', '-', '-', 'RESET M1.3'],
      ]],
      ['Conta o lote quando a etapa ESVAZIAR termina. A borda N faz o ADD somar uma única vez.', [
        ['N M1.3', '-', '-', '-', '-', '-', 'ADD MW0 1 MW0'],
      ]],
      ['RESET zera o contador de lotes.', [
        ['NO I0.5', '-', '-', '-', '-', '-', 'MOVE 0 MW0'],
      ]],
      ['Valores em unidades inteiras para a tabela de E/S: °C e %.', [
        ['-', '-', '-', '-', '-', '-', 'DIV IW1 10 MW4'],
        ['.', '.', '.', '.', '.', '.', 'DIV IW0 10 MW5'],
      ], [[0, 6]]],
      ['Válvula de entrada, com proteção contra transbordo (IW0 < 950, ou 95,0 %).', [
        ['NO M1.0', 'LT IW0 950', '-', '-', '-', '-', 'COIL Q0.0'],
      ]],
      ['Misturador: liga no aquecimento e na mistura.', [
        ['NO M1.1', '-', '-', '-', '-', '-', 'COIL Q0.1'],
        ['NO M1.2', '.', '.', '.', '.', '.', '.'],
      ], [[0, 1]]],
      ['Aquecedor, com corte de segurança em 90,0 °C (IW1 < 900).', [
        ['NO M1.1', 'LT IW1 900', '-', '-', '-', '-', 'COIL Q0.2'],
      ]],
      ['Válvula de saída.', [
        ['NO M1.3', '-', '-', '-', '-', '-', 'COIL Q0.3'],
      ]],
      ['Lâmpada de operação.', [
        ['NO M0.0', '-', '-', '-', '-', '-', 'COIL Q0.4'],
      ]],
    ],
  });
}
