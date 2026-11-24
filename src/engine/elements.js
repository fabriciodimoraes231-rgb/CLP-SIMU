// Catálogo das instruções ladder suportadas.
//  kind 'wire'    → fio horizontal (conduz sempre)
//  kind 'contact' → condição; fica nas colunas da esquerda
//  kind 'output'  → bobina ou bloco; fica sempre na última coluna
//
// Campos da célula usados por cada instrução:
//  areas    → `addr`: o operando de bit, o T/C do bloco ou o destino (MW) da aritmética
//  preset   → `preset`: PT/PV dos temporizadores e contadores
//  operands → `in1`, `in2`: operandos numéricos (constante INT ou IW, MW, T, C)

const READABLE = ['I', 'Q', 'M', 'T', 'C'];
const WRITABLE = ['Q', 'M'];

const TIME_PRESET = { label: 'Tempo PT (ms)', def: 1000, min: 1, max: 3_600_000 };
const COUNT_PRESET = { label: 'Valor PV', def: 5, min: 0, max: 32_767 };

const cmp = (sym, label, test) => ({
  kind: 'contact', sym, label: `Comparação ${label}`, operands: ['in1', 'in2'], test,
  help: `Conduz quando A ${sym} B. A e B podem ser constantes inteiras ou IW, MW, T (tempo decorrido em ms) e C (contagem).`,
});

const math = (sym, label, calc, extra = '') => ({
  kind: 'output', sym, label, areas: ['MW'], operands: ['in1', 'in2'], calc,
  help: `Com energia, calcula A ${sym} B e grava em MW a cada varredura (use uma borda P/N para executar uma vez só). `
    + `Inteiros de 16 bits: o estouro dá a volta (32767 + 1 = −32768).${extra}`,
});

export const ELEMENTS = {
  WIRE: { kind: 'wire', label: 'Fio horizontal', help: 'Liga uma célula à próxima. Conduz sempre.' },

  NO: { kind: 'contact', label: 'Contato NA', areas: READABLE,
    help: 'Normalmente aberto: conduz quando o operando vale 1.' },
  NC: { kind: 'contact', label: 'Contato NF', areas: READABLE,
    help: 'Normalmente fechado: conduz quando o operando vale 0.' },
  P: { kind: 'contact', label: 'Borda de subida (P)', areas: READABLE,
    help: 'Conduz durante um único ciclo quando o operando passa de 0 para 1.' },
  N: { kind: 'contact', label: 'Borda de descida (N)', areas: READABLE,
    help: 'Conduz durante um único ciclo quando o operando passa de 1 para 0.' },

  EQ: cmp('=', 'igual (=)', (a, b) => a === b),
  NE: cmp('<>', 'diferente (<>)', (a, b) => a !== b),
  GT: cmp('>', 'maior (>)', (a, b) => a > b),
  GE: cmp('>=', 'maior ou igual (>=)', (a, b) => a >= b),
  LT: cmp('<', 'menor (<)', (a, b) => a < b),
  LE: cmp('<=', 'menor ou igual (<=)', (a, b) => a <= b),

  COIL: { kind: 'output', label: 'Bobina', areas: WRITABLE,
    help: 'Escreve no bit o resultado lógico do degrau (1 com energia, 0 sem energia).' },
  NCOIL: { kind: 'output', label: 'Bobina negada', areas: WRITABLE,
    help: 'Escreve no bit o inverso do resultado lógico do degrau.' },
  SET: { kind: 'output', label: 'Set (S)', areas: WRITABLE,
    help: 'Com energia, liga o bit e o mantém ligado até um Reset.' },
  RESET: { kind: 'output', label: 'Reset (R)', areas: ['Q', 'M', 'T', 'C'],
    help: 'Com energia, desliga o bit. Em T/C, zera o temporizador ou o contador.' },

  TON: { kind: 'output', label: 'Temporizador TON', areas: ['T'], preset: TIME_PRESET,
    help: 'Atraso na energização: Q liga depois que a entrada fica energizada por PT. Sem energia, zera.' },
  TOF: { kind: 'output', label: 'Temporizador TOF', areas: ['T'], preset: TIME_PRESET,
    help: 'Atraso na desenergização: Q liga junto com a entrada e só desliga PT depois que ela cai.' },
  CTU: { kind: 'output', label: 'Contador CTU', areas: ['C'], preset: COUNT_PRESET,
    help: 'Soma 1 a cada borda de subida da entrada. Q = 1 quando CV ≥ PV. Zere com Reset (R).' },
  CTD: { kind: 'output', label: 'Contador CTD', areas: ['C'], preset: COUNT_PRESET,
    help: 'Começa em PV e subtrai 1 a cada borda de subida. Q = 1 quando CV ≤ 0. Reset recarrega PV.' },

  MOVE: { kind: 'output', sym: '→', label: 'MOVE (copiar)', areas: ['MW'], operands: ['in1'], calc: (a) => a,
    help: 'Com energia, copia A para MW. A pode ser constante inteira ou IW, MW, T (tempo decorrido em ms) e C (contagem).' },
  ADD: math('+', 'ADD (somar)', (a, b) => a + b),
  SUB: math('−', 'SUB (subtrair)', (a, b) => a - b),
  MUL: math('×', 'MUL (multiplicar)', (a, b) => a * b),
  DIV: math('÷', 'DIV (dividir)', (a, b) => (b === 0 ? null : Math.trunc(a / b)),
    ' A divisão é inteira (7 ÷ 2 = 3). Divisão por zero não altera o destino.'),
  MOD: math('mod', 'MOD (resto)', (a, b) => (b === 0 ? null : a % b),
    ' O resto tem o sinal de A (−7 mod 2 = −1). Divisão por zero não altera o destino.'),
};

/** Rótulo de cada operando, na ordem de edição. `addr` é o destino nos blocos aritméticos. */
export const OPERAND_LABEL = { in1: 'A', in2: 'B', addr: 'Destino' };

export const DEFAULT_ADDR = {
  NO: 'I0.0', NC: 'I0.0', P: 'I0.0', N: 'I0.0',
  COIL: 'Q0.0', NCOIL: 'Q0.0', SET: 'M0.0', RESET: 'M0.0',
  TON: 'T0', TOF: 'T0', CTU: 'C0', CTD: 'C0',
  MOVE: 'MW0', ADD: 'MW0', SUB: 'MW0', MUL: 'MW0', DIV: 'MW0', MOD: 'MW0',
};

/** Operandos iniciais ao inserir uma instrução numérica. */
export const DEFAULT_OPERANDS = {
  compare: { in1: 'MW0', in2: '0' },
  MOVE: { in1: '0' },
  math: { in1: 'MW0', in2: '1' },
};

export const isBlock = (type) => !!ELEMENTS[type]?.preset;
export const isCompare = (type) => !!ELEMENTS[type]?.test;
export const isMath = (type) => !!ELEMENTS[type]?.calc;
export const hasOperands = (type) => !!ELEMENTS[type]?.operands;

/** Campos editáveis da célula, na ordem: operandos numéricos e depois o endereço/destino. */
export function cellFields(type) {
  const def = ELEMENTS[type];
  if (!def) return [];
  return [...(def.operands ?? []), ...(def.areas ? ['addr'] : [])];
}
