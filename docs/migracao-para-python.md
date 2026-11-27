# Migrar o CLP Simu para Python? O que se perde e o que se ganha

Python é muito usado para integrar CLPs com software, e muitos desenvolvedores dessa área trabalham com ele. Esta
nota compara o projeto como está (JavaScript) com uma migração para Python e mostra como integrar programas
Python ao simulador **sem migrar**.

Os números de linhas foram contados no repositório em 27/11/2026. Os comportamentos do Python citados foram
conferidos no Python 3.11 e 3.14. O esforço de reescrita é uma **estimativa**.

## O que continua em JavaScript de qualquer jeito

O navegador executa JavaScript. O editor ladder, a animação das máquinas e o CLP que roda na página (cerca de
4.400 linhas: interface, motor, exportação PLCopen e máquinas) continuariam em JavaScript. Existem projetos que
levam Python ao navegador por WebAssembly (como o Pyodide), mas são dependências grandes de terceiros.

Na prática, "migrar para Python" significa reescrever o **servidor** e as **ferramentas de linha de comando**, e
com eles uma segunda cópia do motor do CLP e da simulação das máquinas, que o servidor também usa.

## O que se perde

| Aspecto | Hoje, em JavaScript | Com o servidor em Python |
|---|---|---|
| Motor do CLP e simulação das máquinas | Um código só, usado pela página, pelo servidor e pelas ferramentas | Duas cópias (JavaScript na página, Python no servidor) que precisam continuar idênticas |
| Aritmética INT da IEC 61131-3 | A divisão trunca em direção a zero e o resto tem o sinal de A, como no CLP | Em Python, `-7 // 2` dá −4 e `-7 % 2` dá 1 (no CLP: −3 e −1). Os inteiros não estouram em 16 bits (`32767 + 1` dá 32768). Cada operação precisa de correção explícita |
| Dependências | Nenhuma: só o Node.js | A biblioteca padrão do Python não tem WebSocket: é preciso escrevê-lo à mão (como hoje) ou usar um pacote de terceiros, que depende de aprovação da TI |
| Programas instalados | Node.js | Python para o servidor e, para testar a parte que continua em JavaScript, também o Node.js |
| Testes automáticos | 67 testes (cerca de 2.000 linhas), com Modbus por TCP de verdade | Reescrever os testes do servidor e manter os da parte em JavaScript |
| Verificações já feitas | Esteira e tanque de ponta a ponta, exportação PLCopen conferida varredura a varredura, uso no navegador | Refazer: o código verificado deixa de ser o que roda |
| Proteções de segurança | Origem e host conferidos no WebSocket, lista de IPs no Modbus, cliente só em rede privada, todas com teste | Reimplementar e revisar de novo |
| Esforço | — | Reescrever cerca de 4.000 linhas mais os testes (estimativa: servidor 1.670, ferramentas 681, motor 834, parte de simulação das máquinas), sem nenhum recurso novo para quem usa |

## O que se ganha

| Aspecto | Com Python |
|---|---|
| Familiaridade | Muitos desenvolvedores de integração com CLP já trabalham em Python |
| Outros protocolos industriais | Bibliotecas como `pymodbus` (Modbus), `python-snap7` (Siemens S7), `pycomm3` (Rockwell/Allen-Bradley) e `asyncua` (OPC UA). Todas são de terceiros e dependem de aprovação da TI |
| Análise de dados | `pandas`, `matplotlib` e afins para estudar os registros dos ensaios (também de terceiros) |

Nenhum desses ganhos exige que o simulador seja reescrito: eles valem para programas Python que conversam com
ele, como mostra a próxima seção.

## Alternativa: integrar em Python sem migrar

O simulador fala **Modbus TCP**, o mesmo protocolo de um CLP real. Um programa Python conversa com o simulador do
mesmo jeito que conversaria com o CLP: para passar ao equipamento real, basta trocar o IP, a porta e os endereços.

| Com o simulador em | O programa Python faz o papel de | Endereço |
|---|---|---|
| **CLP interno + servidor Modbus** | supervisório: lê I, Q e IW e escreve setpoints nas MW | `127.0.0.1:5020` |
| **CLP externo: o CLP se conecta ao simulador** | o próprio CLP: lê os sensores (FC 2) e aciona os atuadores (FC 15) | `127.0.0.1:5020` |
| CLP escravo de ensaio (`node tools/clp-escravo.mjs`, sem a página) | supervisório ou teste, como se fosse o CLP de bancada | `127.0.0.1:1502` |

Os mapas de endereços de cada modo estão no [README](../README.md#integração-com-software-externo-modbus-tcp).

### Exemplo: supervisório em Python, só com a biblioteca padrão

Liga a esteira no CLP escravo de ensaio e lê as saídas. Rode `node tools/clp-escravo.mjs` em um terminal e, em
outro, `python supervisorio.py`:

```python
import socket
import struct
import time


def receber(sock, n):
    dados = b''
    while len(dados) < n:
        parte = sock.recv(n - len(dados))
        if not parte:
            raise ConnectionError('o CLP fechou a conexão')
        dados += parte
    return dados


class ClienteModbus:
    def __init__(self, host, porta=502, unit=1):
        self.sock = socket.create_connection((host, porta), timeout=2)
        self.unit = unit
        self.tid = 0

    def pedido(self, pdu):
        self.tid = (self.tid + 1) & 0xFFFF
        self.sock.sendall(struct.pack('>HHHB', self.tid, 0, len(pdu) + 1, self.unit) + pdu)
        tid, _, tamanho, unit = struct.unpack('>HHHB', receber(self.sock, 7))
        resp = receber(self.sock, tamanho - 1)
        if tid != self.tid or unit != self.unit or (resp[0] & 0x7F) != pdu[0]:
            raise ValueError('a resposta não confere com o pedido')
        if resp[0] & 0x80:
            raise RuntimeError(f'o CLP respondeu com a exceção Modbus {resp[1]}')
        return resp

    def ler_coils(self, inicio, quantidade):  # FC 1
        resp = self.pedido(struct.pack('>BHH', 1, inicio, quantidade))
        return [bool((resp[2 + i // 8] >> (i % 8)) & 1) for i in range(quantidade)]

    def escrever_coil(self, endereco, ligado):  # FC 5
        self.pedido(struct.pack('>BHH', 5, endereco, 0xFF00 if ligado else 0))


clp = ClienteModbus('127.0.0.1', 1502)  # CLP real: IP dele e porta 502
for endereco in (1, 4, 6):  # DESLIGA (NF), cilindro recuado, emergência (NF) em repouso
    clp.escrever_coil(endereco, True)
clp.escrever_coil(0, True)  # aperta LIGA (I0.0)
time.sleep(0.3)
clp.escrever_coil(0, False)
motor, cilindro, verde, vermelha = clp.ler_coils(100, 4)  # Q0.0–Q0.3 a partir da coil 100
print(f'motor={motor} lâmpada verde={verde} lâmpada vermelha={vermelha}')
```

Saída esperada: `motor=True lâmpada verde=True lâmpada vermelha=False`. Conferido em 27/11/2026 com o Python 3.11
e 3.14 contra o CLP escravo de ensaio.

Com a TI aprovando o `pymodbus`, a classe `ClienteModbus` pode ser trocada por ele; o restante do programa não muda.

## Recomendação

Manter o simulador em JavaScript e escrever em Python os programas que se integram a ele (supervisórios, testes
com o CLP de bancada, análise de dados). Assim, quem trabalha em Python ganha o que a linguagem oferece sem
duplicar o motor do CLP nem refazer as verificações. Uma migração só compensaria se quem vai **manter** o
simulador trabalhasse apenas com Python.
