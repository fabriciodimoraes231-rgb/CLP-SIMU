// Utilitários da interface.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escapa texto antes de inserir em HTML/SVG (comentários e símbolos vêm do usuário/arquivos). */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ESC[ch]);

// localStorage pode estar indisponível (janela privada, bloqueio): falha silenciosa.
export const storage = {
  get(key) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? null : JSON.parse(v);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* armazenamento indisponível */
    }
  },
};

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export const trunc = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Formata tempo: segundos com uma casa (vírgula) quando a referência ≥ 1 s, senão ms. */
export function fmtTime(ms, ref = ms) {
  if (ref >= 1000) return `${(ms / 1000).toFixed(1).replace('.', ',')} s`;
  return `${Math.round(ms)} ms`;
}

/** Tempo decorrido/programado compacto, na unidade do preset: "230/500 ms", "1,2/5,0 s". */
export function fmtTimePair(et, pt) {
  if (pt >= 1000) {
    const s = (v) => (v / 1000).toFixed(1).replace('.', ',');
    return `${s(et)}/${s(pt)} s`;
  }
  return `${Math.round(et)}/${Math.round(pt)} ms`;
}
