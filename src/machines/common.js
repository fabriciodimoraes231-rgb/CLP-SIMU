// Utilitários compartilhados pelas simulações de máquinas (sem dependência de DOM).

import { toRegister } from '../engine/iomap.js';

/** Entradas analógicas da máquina como palavras do CLP: { IW0: registrador de 16 bits, … }. */
export function analogInputs(machine, sim) {
  const out = {};
  for (const a of machine.analogs ?? []) out[`IW${a.reg}`] = toRegister(a.read(sim), a.scale);
  return out;
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/** Gerador pseudoaleatório com semente (resultados reprodutíveis nos testes). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Desenho em canvas
// ---------------------------------------------------------------------------

export function scenePalette(dark) {
  return dark
    ? {
      bg: '#111821', grid: '#18212c', text: '#d5dde8', muted: '#8492a6',
      metal: '#5b6878', metalDark: '#2c3642', metalEdge: '#7b8898', rod: '#aab4c2',
      belt: '#262f3a', beltStripe: '#34404d',
      boxShort: '#d9b77e', boxTall: '#d4541c', boxEdge: '#0b0f14', boxText: '#1b1208',
      bin: '#1a2330', binEdge: '#4b5869',
      on: '#22c55e', off: '#3a4553', red: '#ef4444', redOff: '#4a2024', greenOff: '#173a24',
      beamOn: '#ef4444', beamOff: 'rgba(148,163,184,.35)',
      water: [59, 130, 246], hot: [249, 115, 22], glass: 'rgba(148,163,184,.10)',
    }
    : {
      bg: '#f1f4f8', grid: '#e4e9ef', text: '#1e2733', muted: '#5b6676',
      metal: '#94a3b8', metalDark: '#475569', metalEdge: '#334155', rod: '#cbd5e1',
      belt: '#3b4552', beltStripe: '#4c5766',
      boxShort: '#e8c88f', boxTall: '#e0662a', boxEdge: '#5b3a12', boxText: '#2a1a08',
      bin: '#e2e8f0', binEdge: '#94a3b8',
      on: '#16a34a', off: '#cbd5e1', red: '#dc2626', redOff: '#f3d0d0', greenOff: '#cfe9d7',
      beamOn: '#dc2626', beamOff: 'rgba(71,85,105,.35)',
      water: [59, 130, 246], hot: [234, 88, 12], glass: 'rgba(148,163,184,.12)',
    };
}

export function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

export function label(ctx, text, x, y, { color = '#000', size = 11, align = 'left', weight = 400, mono = false } = {}) {
  ctx.fillStyle = color;
  ctx.font = `${weight} ${size}px ${mono ? 'ui-monospace, Consolas, monospace' : 'system-ui, "Segoe UI", sans-serif'}`;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
}

/** Lâmpada/LED circular com brilho quando ligado. */
export function lamp(ctx, x, y, r, on, colorOn, colorOff) {
  ctx.save();
  if (on) {
    ctx.shadowColor = colorOn;
    ctx.shadowBlur = r * 1.6;
  }
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = on ? colorOn : colorOff;
  ctx.fill();
  ctx.restore();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(0,0,0,.35)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

export function floorGrid(ctx, P, w, h) {
  ctx.fillStyle = P.bg;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = P.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0.5; x <= w; x += 20) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
  for (let y = 0.5; y <= h; y += 20) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
  ctx.stroke();
}

export const mixColor = (a, b, t) => {
  const k = clamp(t, 0, 1);
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * k));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
};
