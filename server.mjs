// Servidor local do CLP Simu, sem dependências.
// Uso: node server.mjs  (ou npm start) → http://localhost:5173
//
// Variáveis de ambiente:
//   PORT          porta HTTP (padrão 5173; escuta só em 127.0.0.1)
//   MODBUS_PORT   porta do servidor Modbus TCP (padrão 5020; "off" desliga)
//   MODBUS_HOST   interface do Modbus TCP (padrão 127.0.0.1). Modbus não tem autenticação:
//                 abrir para a rede só com aval da TI e firewall restrito. Prefira o IP da placa de rede
//                 ligada ao CLP (ex.: 192.168.1.2) em vez de 0.0.0.0.
//   MODBUS_ALLOW  IPs que podem se conectar ao Modbus, separados por vírgula (ex.: 192.168.1.10).
//                 Obrigatório quando MODBUS_HOST não é local; "*" aceita qualquer IP (não recomendado).

import { startServer } from './server/app.mjs';
import { isPrivateIPv4 } from './server/modbus-poller.mjs';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

const port = Number(process.env.PORT) || 5173;
const mp = process.env.MODBUS_PORT;
const modbusPort = mp === 'off' || mp === '0' ? null : Number(mp) || 5020;
const modbusHost = process.env.MODBUS_HOST || '127.0.0.1';

const allowRaw = (process.env.MODBUS_ALLOW ?? '').trim();
let modbusAllow = null;
if (allowRaw && allowRaw !== '*') {
  modbusAllow = allowRaw.split(',').map((s) => s.trim()).filter(Boolean);
  const bad = modbusAllow.filter((ip) => !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip));
  if (bad.length) {
    console.error(`MODBUS_ALLOW com endereço inválido: ${bad.join(', ')}. Use IPv4 separados por vírgula.`);
    process.exit(1);
  }
}
if (modbusPort !== null && !LOOPBACK.has(modbusHost)) {
  if (!allowRaw) {
    console.error(`MODBUS_HOST=${modbusHost} abre o Modbus TCP para a rede, e o protocolo não tem autenticação. `
      + 'Defina MODBUS_ALLOW com o IP do CLP (ex.: MODBUS_ALLOW=192.168.1.10) para aceitar só ele.');
    process.exit(1);
  }
  if (modbusHost === '0.0.0.0' || !isPrivateIPv4(modbusHost)) {
    console.warn(`ATENÇÃO: Modbus TCP em ${modbusHost}. Prefira o IP da placa de rede ligada ao CLP (rede privada).`);
  }
  console.warn(`Modbus TCP aberto em ${modbusHost}; ${modbusAllow ? `só aceita ${modbusAllow.join(', ')}` : 'aceita QUALQUER IP (MODBUS_ALLOW=*)'}. `
    + 'Use só com aval da TI.');
}

const stamp = () => new Date().toLocaleTimeString('pt-BR');

startServer({ port, modbusPort, modbusHost, modbusAllow, log: (msg) => console.log(`[${stamp()}] ${msg}`) })
  .then((srv) => {
    console.log(`CLP Simu rodando em http://localhost:${srv.port}`);
    if (srv.modbusPort) {
      console.log(`Modbus TCP em ${modbusHost}:${srv.modbusPort} (planta virtual: escolha "Controle: CLP externo" na página)`);
    }
  })
  .catch((err) => {
    console.error(`Não foi possível iniciar o servidor: ${err.code === 'EADDRINUSE' ? `porta ${port} em uso (defina PORT)` : err.message}`);
    process.exit(1);
  });
