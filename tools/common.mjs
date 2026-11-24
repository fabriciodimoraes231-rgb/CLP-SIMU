// Utilitários das ferramentas de linha de comando (sem dependências).

import { parseArgs } from 'node:util';
import { cleanText } from '../server/bridge.mjs';

export const COMMON_OPTIONS = {
  host: { type: 'string', default: '127.0.0.1' },
  porta: { type: 'string', default: process.env.MODBUS_PORT || '5020' },
  http: { type: 'string', default: process.env.PORT || '5173' },
  ajuda: { type: 'boolean', short: 'h', default: false },
};

export function parseCli(options, usage) {
  try {
    const { values, positionals } = parseArgs({ options: { ...COMMON_OPTIONS, ...options }, allowPositionals: true });
    if (values.ajuda) {
      console.log(usage);
      process.exit(0);
    }
    return { values, positionals, port: Number(values.porta) || 5020, httpPort: Number(values.http) || 5173 };
  } catch (err) {
    console.error(`${err.message}\n\n${usage}`);
    process.exit(2);
  }
}

export const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
export const stamp = () => new Date().toLocaleTimeString('pt-BR');

/** Lê /api/planta do servidor local do simulador (símbolos e máquina atual). null se indisponível. */
export async function fetchPlanta(httpPort) {
  try {
    const res = await fetch(`http://127.0.0.1:${httpPort}/api/planta`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** Mapa endereço → símbolo a partir de /api/planta (textos já limpos de caracteres de controle). */
export function symbolTable(planta) {
  const map = new Map();
  const io = planta?.io;
  for (const x of [...(io?.inputs ?? []), ...(io?.outputs ?? []), ...(io?.words ?? [])]) {
    if (x.symbol) map.set(x.addr, cleanText(x.symbol, 32));
  }
  return map;
}

export function connectionHint(err, host, port) {
  if (err?.code === 'ECONNREFUSED') return `Nenhum servidor Modbus em ${host}:${port}. Rode "npm start" na pasta do CLP Simu.`;
  return `Falha de conexão com ${host}:${port}: ${err?.message ?? err}`;
}
