// Servidor local do CLP Simu: arquivos da aplicação + ponte WebSocket + servidor Modbus TCP.
// Sem dependências. HTTP escuta só em 127.0.0.1.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PlantBridge } from './bridge.mjs';
import { acceptWebSocket } from './websocket.mjs';
import { createModbusServer } from './modbus.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const HOST = '127.0.0.1';
const ALLOWED_TOP = new Set(['index.html', 'css', 'src']);
const MAX_WS_MESSAGE = 16 * 1024;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function securityHeaders(port) {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; "
      + `connect-src 'self' ws://localhost:${port} ws://127.0.0.1:${port}; `
      + "object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    'Cache-Control': 'no-store',
  };
}

const listen = (srv, port, host) => new Promise((ok, fail) => {
  srv.once('error', fail);
  srv.listen(port, host, () => {
    srv.off('error', fail);
    ok(srv.address().port);
  });
});

/**
 * Inicia o servidor. modbusPort = null desliga o Modbus. Portas 0 = escolha automática (testes).
 * modbusAllow = lista de IPs que podem se conectar ao Modbus (null = qualquer um).
 * realtime/createRng/pollerOptions vão para a ponte (testes rodam a planta passo a passo).
 * Retorna { port, modbusPort, bridge, close() }.
 */
export async function startServer({
  port = 5173, modbusPort = 5020, modbusHost = HOST, modbusAllow = null, log = console.log, warn = console.warn,
  realtime = true, createRng = null, pollerOptions = {},
} = {}) {
  const bridge = new PlantBridge({ log, realtime, createRng, pollerOptions });
  let headers = securityHeaders(port);
  let origins = new Set();
  let hosts = new Set();

  const send = (res, code, body, type = 'text/plain; charset=utf-8') => {
    res.writeHead(code, { 'Content-Type': type, ...headers });
    res.end(body);
  };

  const http = createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, 'Método não permitido');
      return;
    }
    try {
      let path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (path === '/api/planta') {
        send(res, 200, req.method === 'HEAD' ? undefined : JSON.stringify(bridge.snapshot()), TYPES['.json']);
        return;
      }
      if (path === '/') path = '/index.html';
      const file = resolve(ROOT, `.${path}`);
      if (!file.startsWith(ROOT + sep)) {
        send(res, 403, 'Proibido');
        return;
      }
      const top = file.slice(ROOT.length + 1).split(sep)[0];
      if (!ALLOWED_TOP.has(top)) {
        send(res, 404, 'Não encontrado');
        return;
      }
      const info = await stat(file);
      if (!info.isFile()) throw new Error('não é arquivo');
      const body = await readFile(file);
      send(res, 200, req.method === 'HEAD' ? undefined : body, TYPES[extname(file)] ?? 'application/octet-stream');
    } catch {
      send(res, 404, 'Não encontrado');
    }
  });

  // Ponte com a planta: só aceita a própria página (Origin e Host locais).
  const upgraded = new Set();
  http.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    upgraded.add(socket);
    socket.on('close', () => upgraded.delete(socket));
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path !== '/bridge') {
      socket.destroy();
      return;
    }
    const ws = acceptWebSocket(req, socket, head, { origins, hosts });
    if (!ws) return;
    const handle = bridge.connectPlant({
      send: (msg) => ws.send(JSON.stringify(msg)),
      close: () => ws.close(1000),
    });
    ws.on('message', (text) => {
      if (text.length > MAX_WS_MESSAGE) return;
      try {
        handle.receive(JSON.parse(text));
      } catch {
        /* mensagem inválida: ignorada */
      }
    });
    ws.on('close', () => handle.disconnect());
  });

  const actualPort = await listen(http, port, HOST);
  headers = securityHeaders(actualPort);
  origins = new Set([`http://localhost:${actualPort}`, `http://127.0.0.1:${actualPort}`]);
  hosts = new Set([`localhost:${actualPort}`, `127.0.0.1:${actualPort}`]);

  let modbus = null;
  let actualModbusPort = null;
  if (modbusPort !== null) {
    const allowed = modbusAllow ? new Set(modbusAllow) : null;
    modbus = createModbusServer(bridge.model, { hooks: bridge.modbusHooks, allow: allowed ? (ip) => allowed.has(ip) : null });
    try {
      actualModbusPort = await listen(modbus.server, modbusPort, modbusHost);
      bridge.modbusAddress = { host: modbusHost, port: actualModbusPort };
    } catch (err) {
      warn(`Modbus TCP indisponível em ${modbusHost}:${modbusPort} (${err.code ?? err.message}). `
        + 'Defina outra porta com MODBUS_PORT. O simulador continua funcionando com o CLP interno.');
      modbus = null;
    }
  }

  return {
    port: actualPort,
    modbusPort: actualModbusPort,
    bridge,
    async close() {
      bridge.close();
      if (modbus) await modbus.close();
      for (const s of upgraded) s.destroy();
      http.closeAllConnections?.();
      await new Promise((ok) => http.close(() => ok()));
    },
  };
}
