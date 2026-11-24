# CLP Simu — simulador de CLP com ladder e máquinas virtuais

Protótipo de simulador de CLP (controlador lógico programável) que roda no navegador.
Você monta o programa em **linguagem ladder** (diagrama de contatos), coloca o CLP em
**RUN** e vê uma **máquina simulada** responder às saídas, com os sensores voltando como entradas.

Desenvolvido por [fabriciodimoraes231-rgb](https://github.com/fabriciodimoraes231-rgb).

> **Status: protótipo.** Não é uma ferramenta validada para comissionamento real: os resultados
> da simulação são indicativos. Revise e teste antes de usar com equipamentos de verdade.

## Como executar

Requer apenas **Node.js 20+**. Não há dependências para instalar.

```powershell
npm start
```

Abra <http://localhost:5173>. O servidor escuta só em `127.0.0.1` e entrega apenas `index.html`, `css/` e `src/`.
Ele também abre um servidor **Modbus TCP em `127.0.0.1:5020`** para a integração com CLPs externos (veja abaixo).

Testes automatizados (motor ladder + integração com as máquinas):

```powershell
npm test
```

## Uso rápido

1. Escolha a máquina no topo. Cada máquina já vem com um **programa de exemplo** funcionando
   (o tanque tem dois: escolha no menu **Carregar exemplo ▾**).
2. Clique em **▶ RUN** e depois no botão **LIGA** do painel da máquina.
3. Para editar: **■ STOP** → escolha um elemento na paleta → clique numa célula.
   - Contatos ficam à esquerda; bobinas, temporizadores e contadores, na **última coluna** (sombreada).
   - Ao inserir um elemento, um campo flutuante pede o endereço (ex.: `I0.3`). **Enter** confirma.
   - Ramos em paralelo (OU): **+ linha** e ferramenta **Ligação**, clicando nos pontos de junção.
   - Comparações e blocos de aritmética abrem campos **A**, **B** e **→** (destino); **Tab** passa de um para o outro.
   - Clicar de novo numa célula selecionada (ou **Enter**) reabre o endereço. **Delete** apaga.
4. O programa é salvo automaticamente no navegador (por máquina). **Importar** e **Exportar ▾ → Programa do CLP Simu**
   usam arquivos `.json`. **Exportar ▾ → PLCopen XML** gera um arquivo para outros editores IEC 61131-3 (veja abaixo).

## Instruções suportadas

| Tipo | Instruções |
|---|---|
| Contatos | NA `-\| \|-`, NF `-\|/\|-`, borda de subida `P`, borda de descida `N` |
| Bobinas | Bobina `( )`, negada `(/)`, Set `(S)`, Reset `(R)` (Reset também zera T e C) |
| Temporizadores | TON (atraso na energização), TOF (atraso na desenergização). PT em ms |
| Contadores | CTU (crescente, Q = CV ≥ PV), CTD (decrescente a partir de PV, Q = CV ≤ 0) |
| Comparação | `A = B`, `A <> B`, `A > B`, `A >= B`, `A < B`, `A <= B` (EQ, NE, GT, GE, LT, LE). Ficam entre os contatos e conduzem quando a comparação é verdadeira |
| Aritmética | MOVE (`MW := A`), ADD, SUB, MUL, DIV (inteira), MOD (resto). Ficam na última coluna e gravam numa `MW` |

**Endereços:** `I0.0`–`I15.7` (entradas), `Q0.0`–`Q15.7` (saídas), `M0.0`–`M15.7` (memórias),
`T0`–`T31`, `C0`–`C31`, `MW0`–`MW63` (memórias de palavra) e `IW0`–`IW15` (entradas analógicas da máquina).
O prefixo IEC `%` é aceito (`%I0.0`, `%MW3`).

### Números (comparação e aritmética)

- Os valores são **INT de 16 bits com sinal** (−32768 a 32767), como na IEC 61131-3.
- Operandos A e B: constante inteira ou `IW`, `MW`, `T` (tempo decorrido em ms, limitado a 32767) e `C` (contagem atual).
  O destino é sempre uma `MW`.
- `MW` é uma área própria: `MW0` **não** se sobrepõe a `M0.0`–`M1.7` (mesmo critério do OpenPLC para `%MW` e `%MX`).
- `IW` recebe os valores analógicos da máquina na mesma escala dos registradores Modbus (ex.: nível em 0,1 %).
- Estouro dá a volta, como num CLP real: `32767 + 1 = −32768`. DIV trunca em direção a zero (`−7 ÷ 2 = −3`) e
  MOD tem o sinal de A (`−7 mod 2 = −1`).
- Divisão pela **constante** 0 é erro de programa. Divisão por uma `MW` que vale 0 em execução não altera o destino;
  a barra de status conta as ocorrências.
- Os blocos executam **a cada varredura** enquanto têm energia: `ADD MW0 1 → MW0` com o degrau sempre energizado
  soma 100 por segundo. Para somar uma vez por evento, use um contato de borda (P ou N) antes do bloco.
- RUN faz partida a frio: as `MW` voltam a 0. Para fixar parâmetros, use um degrau sempre energizado com MOVE
  (como no exemplo analógico do tanque).

**Ciclo de varredura:** 10 ms. Lê entradas → executa os degraus de cima para baixo → escreve saídas.
STOP desliga todas as saídas. RUN faz partida a frio (zera memórias, T e C).

## Máquinas

### Esteira com separação de peças
Peças altas devem ir para a caixa de rejeito (empurradas pelo cilindro); peças baixas seguem para a saída.

| Entrada | Símbolo | | Saída | Símbolo |
|---|---|---|---|---|
| I0.0 | Botão LIGA (NA) | | Q0.0 | Motor da esteira |
| I0.1 | Botão DESLIGA (**NF**) | | Q0.1 | Solenoide do cilindro (recua por mola) |
| I0.2 | Sensor de entrada | | Q0.2 | Lâmpada verde |
| I0.3 | Sensor de posição (frente do cilindro) | | Q0.3 | Lâmpada vermelha |
| I0.4 | Cilindro recuado | | | |
| I0.5 | Cilindro avançado | | | |
| I0.6 | Emergência (**NF**, com trava) | | | |
| I0.7 | Sensor de altura (peça alta) | | | |
| I1.0 | Botão RESET (NA) | | | |

O exemplo usa selo, Set/Reset, TON, borda de subida, CTU (para com 5 rejeitos) e um oscilador com dois TON.
Exercício sugerido: usar `I0.2` para contar as peças que entram.

### Tanque de mistura com aquecimento
Batelada: encher até o nível alto → aquecer até 60 °C → misturar 5 s → esvaziar. O painel avalia cada lote que
passa de 20 %: **no padrão** se encheu até 85 %, chegou a 60 °C e misturou quente por 4,5 s; senão, fora do padrão.

| Entrada | Símbolo | | Saída | Símbolo |
|---|---|---|---|---|
| I0.0 | Botão LIGA (NA) | | Q0.0 | Válvula de entrada |
| I0.1 | Botão DESLIGA (**NF**) | | Q0.1 | Misturador |
| I0.2 | Nível baixo (> 10 %) | | Q0.2 | Aquecedor |
| I0.3 | Nível alto (≥ 90 %) | | Q0.3 | Válvula de saída |
| I0.4 | Termostato (≥ 60 °C) | | Q0.4 | Lâmpada "em operação" |
| I0.5 | Botão RESET (NA) | | | |

| Analógico | Símbolo | Escala |
|---|---|---|
| IW0 | Nível | 0,1 % (0–1000) |
| IW1 | Temperatura | 0,1 °C (220 = 22,0 °C) |

Dois exemplos:

- **Sequência por etapas (sensores digitais):** bits de etapa M1.x, TON e CTU de 3 lotes.
- **Controle analógico (nível e temperatura):** a mesma batelada usando `IW0`/`IW1`. Enche até o setpoint de 88,0 %
  (`MW1`), aquece até 65,0 °C (`MW2`), conta os lotes com `ADD` numa borda N (`MW0`), para na meta (`MW3`),
  converte °C e % para inteiros com `DIV` e tem intertravamentos por comparação (válvula fecha acima de 95 %,
  aquecedor corta em 90 °C). Os setpoints são gravados só na primeira varredura e limitados por comparações, para
  que um supervisório possa ajustá-los pelo Modbus (veja "CLP interno + servidor Modbus").

## Integração com software externo (Modbus TCP)

O seletor **Controle** do topo tem quatro modos:

| Modo | Quem controla a máquina | Papel do Modbus TCP |
|---|---|---|
| CLP interno (ladder) | o ladder da página | desligado |
| CLP interno + servidor Modbus (HMI/SCADA) | o ladder da página | o CLP vira **escravo**: um supervisório lê as E/S e escreve **setpoints** nas MW |
| CLP externo: o simulador se conecta ao CLP | um CLP real | o simulador é o **mestre**: escreve os sensores na memória do CLP e lê as saídas |
| CLP externo: o CLP se conecta ao simulador | um CLP real ou de software | o simulador é o **escravo**: a máquina vira planta virtual do CLP |

Nos dois modos de CLP externo **a máquina roda no servidor** (`npm start`), em tempo real: ela não congela com a aba
do navegador em segundo plano. A página vira o painel de operação (mostra a máquina e envia os botões).

## Testar um CLP real

O caminho mais simples para um CLP de bancada (WEG, Altus, Delta e a maioria dos CLPs com Ethernet) é o modo
**"CLP externo: o simulador se conecta ao CLP"**: o CLP só precisa estar com o Modbus TCP servidor habilitado, sem
programar blocos de comunicação, e nenhuma porta é aberta no notebook.

> **Segurança:** o CLP vai executar o programa com os sensores simulados e **acionar as saídas físicas** dele.
> Faça o teste em bancada, com as saídas desligadas de motores, válvulas e outras cargas reais.

### 1. Ensaiar sem o CLP

```powershell
node tools/clp-escravo.mjs
```

Esse "CLP escravo de ensaio" responde como um CLP com Modbus TCP em `127.0.0.1:1502`, rodando o ladder de exemplo
da esteira (use `--maquina tanque --exemplo analogico --analogicos 200` para o tanque). Na página: **Controle →
CLP externo: o simulador se conecta ao CLP**, IP `127.0.0.1`, porta `1502`, entradas em coils a partir de 0, saídas
em coils a partir de 100, **Aplicar e conectar**, e aperte **LIGA**.

### 2. Rede (cabo direto)

1. Ligue o cabo de rede entre o notebook e o CLP.
2. Veja o IP do CLP (ex.: `192.168.1.10`) e configure na placa de rede do notebook um IP fixo na mesma faixa
   (ex.: `192.168.1.2`, máscara `255.255.255.0`). **Mudar a configuração de rede do notebook pode exigir a TI.**
3. Habilite o Modbus TCP **servidor** no CLP (porta padrão 502).

Por segurança, o simulador só se conecta a IPs de rede privada (`192.168.x.x`, `10.x.x.x`, `172.16–31.x.x`),
link-local (`169.254.x.x`) ou ao próprio computador, e só depois de você clicar em **Aplicar e conectar**.

### 3. Mapa de memória

Escolha onde o simulador escreve as entradas e de onde lê as saídas (endereços Modbus começando em 0):

| Campo | Opções | Função Modbus |
|---|---|---|
| Entradas (I) vão para | coils, ou holding com 16 entradas por registrador (`I0.0` = bit 0) | FC 15 ou FC 16 |
| Saídas (Q) vêm de | coils, entradas discretas, ou holding com 16 por registrador | FC 1, FC 2 ou FC 3 |
| Analógicos (IW) | holding, um registrador por IW (opcional) | FC 16 |

O painel mostra o endereço no CLP de cada ponto (ex.: `I0.0 → coil 2148`). O modelo **Delta DVP** preenche entradas
em `M100` (coil 2148), saídas lidas de `Y0` (coil 1280) e analógicos em `D100` (registrador 4196), conforme o mapa
Modbus usual da linha DVP (X 0x0400, Y 0x0500, M 0x0800, D 0x1000). **Confira no manual do seu modelo**: outras
linhas (Delta AS, WEG, Altus) usam endereços diferentes, e alguns manuais numeram a partir de 1 ou usam 40001 para o
primeiro registrador holding.

### 4. Programa do CLP

As entradas físicas do CLP (ex.: `X0`) não podem ser escritas pelo Modbus. No programa de teste, use as **memórias
escritas pelo simulador** no lugar das entradas (ex.: `M100` = LIGA, `M101` = DESLIGA NF…) e acione as saídas que o
simulador lê. Botões NF chegam como 1 em repouso, como nos contatos reais.

### 5. Proteções

- **Watchdog:** se o CLP não responder por 1 s, a máquina simulada para (saídas em 0) até a comunicação voltar.
- **Ao desconectar** (trocar de modo ou fechar a página), o simulador escreve 0 em todas as entradas do CLP: os
  botões NF passam a valer 0, como se o DESLIGA estivesse apertado.
- Nesse modo o servidor Modbus local recusa outros mestres (exceção 0x0B), para não haver dois controlando a planta.
- O painel mostra trocas, tempo de cada troca, erros e a mensagem do CLP (ex.: "endereço fora do mapa do CLP").

### CLP interno + servidor Modbus: setpoints pelo supervisório

O ladder continua rodando na página e fica acessível como um CLP com Modbus TCP em `127.0.0.1:5020`:

| CLP Simu | Tabela Modbus | Funções | Índice | Referência |
|---|---|---|---|---|
| `I0.0`–`I15.7` | Entradas discretas | FC 2 | 0–127 | 10001–10128 |
| `Q0.0`–`Q15.7` | Coils | FC 1 (**só leitura**: FC 5/15 respondem a exceção 0x01) | 0–127 | 00001–00128 |
| `IW0`–`IW15` | Registradores de entrada | FC 4 | 0–15 | 30001–30016 |
| `MW0`–`MW63` | **Registradores holding** | FC 3, 6, 16 | 0–63 | 40001–40064 |

- As MW são INT de 16 bits: valores negativos vão no registrador em complemento de dois (−1 = 65535).
- A escrita chega ao ladder antes da varredura seguinte. Uma leitura logo depois da escrita já devolve o valor
  escrito; se o programa alterar o valor (um limite, por exemplo), a leitura seguinte mostra o valor corrigido.
- Escritas com o CLP em STOP ficam nas MW, mas o RUN faz partida a frio e as zera. Por isso o exemplo grava os
  valores padrão só na primeira varredura (bit `M2.0`) e depois deixa o supervisório mudá-los.
- O painel da página mostra o mapa (as MW listadas são as que o programa usa ou nomeia) e a última escrita recebida.

Teste com o exemplo **Controle analógico** do tanque, em RUN:

```powershell
node tools/modbus.mjs ler
```

```powershell
node tools/modbus.mjs escrever MW2 700
```

O segundo comando muda o setpoint de temperatura para 70,0 °C. Setpoints do exemplo: `MW1` nível (300–920, em 0,1 %),
`MW2` temperatura (300–850, em 0,1 °C) e `MW3` meta de lotes (1–20). Fora da faixa, o próprio ladder corrige
(`escrever MW1 990` vira 920). `MW0` é a contagem de lotes: escrever 0 zera o contador.

Para um supervisório de terceiros (ScadaBR, Node-RED, Elipse…), cadastre um escravo Modbus TCP no mesmo endereço.
Em ambiente corporativo, instalar esses programas pode depender de aprovação da TI.

### CLP externo: a máquina como planta virtual

No seletor **Controle** do topo, escolha **CLP externo (Modbus TCP)**. A máquina vira uma *planta virtual*:
os sensores e botões viram **entradas discretas** e os atuadores viram **coils** de um escravo Modbus TCP.
Quem controla passa a ser um CLP de fora (OpenPLC Runtime, CODESYS, um script…). O ladder da página não roda
nesse modo, e a velocidade fica fixa em 1× (o CLP externo trabalha em tempo real).

### Testar sem instalar nada

Com `npm start` rodando e a página em **CLP externo**, abra outro terminal na pasta do projeto:

```powershell
node tools/clp-externo.mjs
```

Esse "CLP externo" de exemplo roda o programa ladder da máquina aberta na página **fora do navegador**,
lendo as entradas (FC 2) e escrevendo as coils (FC 15) a cada 20 ms, como faria um CLP de verdade.
Aperte **LIGA** na página. Ctrl+C desliga as saídas e encerra.

Programas que usam `IW` leem também os registradores de entrada (FC 4) a cada ciclo. Para rodar o exemplo
analógico do tanque como CLP externo:

```powershell
node tools/clp-externo.mjs --exemplo analogico
```

Para rodar o seu próprio ladder como CLP externo, use **Exportar ▾ → Programa do CLP Simu (.json)** e depois:

```powershell
node tools/clp-externo.mjs --programa programa-esteira.json
```

Cliente Modbus de linha de comando, para inspecionar e forçar pontos:

```powershell
node tools/modbus.mjs ler
```

```powershell
node tools/modbus.mjs monitorar
```

```powershell
node tools/modbus.mjs escrever Q0.0 1
```

### Mapa Modbus

| CLP Simu | Tabela Modbus | Funções | Índice (0-based) | Referência |
|---|---|---|---|---|
| `I0.0`–`I15.7` (sensores, botões) | Entradas discretas | FC 2 | byte × 8 + bit (0–127) | 10001–10128 |
| `Q0.0`–`Q15.7` (atuadores) | Coils | FC 1, 5, 15 | byte × 8 + bit (0–127) | 00001–00128 |
| Analógicos da máquina (`IW0`–`IW15`) | Registradores de entrada | FC 4 | 0–15 | 30001–30016 |

Exemplos: `I1.0` = entrada discreta 8; `Q0.3` = coil 3. O tanque publica **nível** (IR 0, em 0,1 %) e
**temperatura** (IR 1, em 0,1 °C). Qualquer *unit id* é aceito. Neste modo não há registradores *holding* (FC 3/6/16
respondem "endereço inválido"; eles existem só no modo servidor). Sem a página conectada, todas as funções respondem
com a exceção **0x0B** (*gateway target failed to respond*). O painel "CLP externo · Modbus TCP" da página mostra o
mapa da máquina atual com os estados ao vivo.

**Watchdog** (ligado por padrão): se nenhum cliente Modbus fizer requisições por 1 s, as coils vão a 0 e a máquina para.
Desligue-o no painel para testar escritas avulsas com `tools/modbus.mjs escrever`.

### Com OpenPLC Runtime, CODESYS ou outro CLP

Cadastre no CLP um **dispositivo escravo Modbus TCP** em `127.0.0.1`, porta `5020`, com *discrete inputs* a partir de 0
(quantidade = entradas da máquina) e *coils* a partir de 0 (quantidade = saídas). No OpenPLC Runtime isso é feito em
"Slave Devices" e os pontos costumam aparecer a partir de `%IX100.0` e `%QX100.0`; confira o mapeamento na tela do próprio
OpenPLC. Em ambiente corporativo, instalar esses programas pode depender de aprovação da TI.

Se o CLP estiver em outra máquina (CLP físico, VM ou contêiner), o servidor precisa escutar na placa de rede ligada
a ele, e **só aceita os IPs listados** em `MODBUS_ALLOW` (o servidor não inicia sem a lista):

```powershell
$env:MODBUS_HOST = '192.168.1.2'; $env:MODBUS_ALLOW = '192.168.1.10'; npm start
```

**Modbus não tem autenticação**: qualquer um que alcance a porta lê e escreve as E/S. Use só com aval da TI; com
cabo direto até o CLP a exposição é mínima. Para um CLP físico, prefira o modo em que o simulador se conecta ao CLP,
que não abre porta no notebook.

### Variáveis de ambiente

| Variável | Padrão | Uso |
|---|---|---|
| `PORT` | `5173` | Porta HTTP (sempre em 127.0.0.1) |
| `MODBUS_PORT` | `5020` | Porta Modbus TCP; `off` desliga. A 502 padrão foi evitada para não exigir privilégios nem colidir com outro escravo |
| `MODBUS_HOST` | `127.0.0.1` | Interface do Modbus TCP. Fora do próprio computador, use o IP da placa ligada ao CLP |
| `MODBUS_ALLOW` | (vazio) | IPs que podem se conectar, separados por vírgula. Obrigatório quando `MODBUS_HOST` não é local; `*` aceita qualquer IP |

### O que foi verificado

- Codificação conferida com os exemplos de requisição/resposta da *MODBUS Application Protocol Specification V1.1b3*
  (FC 1, 2, 3, 4, 5, 6, 15, 16) e com as respostas de exceção.
- Handshake WebSocket conferido com o exemplo da RFC 6455. A ponte recusa origens e *Host* que não sejam a própria
  página, para impedir que outros sites falem com o servidor local.
- Testes de ponta a ponta: o CLP externo opera a esteira e o tanque por Modbus TCP real (porta local) com os mesmos
  resultados do CLP interno.
- Modo servidor: um cliente Modbus real lê os setpoints do exemplo analógico, escreve valores novos (inclusive fora
  da faixa, corrigidos pelo ladder) e o tanque passa a operar com eles; coils recusam escrita com a exceção 0x01.
- Modo "o simulador se conecta ao CLP": testes de ponta a ponta contra o CLP escravo de ensaio por TCP real, com
  endereços estilo Delta (entradas em M100, saídas em Y0) e com entradas/saídas empacotadas em registradores holding:
  a esteira separa sem erro e o tanque analógico produz 3 lotes no padrão. Watchdog, recusa de configuração com IP
  público e zeragem das entradas ao desconectar também são testados.
- No navegador (24/11/2026): com o CLP de ensaio, a esteira foi operada pela página e **continuou rodando com a aba
  em segundo plano** (de 3 para 5 rejeitos em ~20 s, parando sozinha na caixa cheia).
- **Ainda não testado com CLPs ou mestres Modbus de terceiros** (WEG, Altus, Delta, OpenPLC, CODESYS, ScadaBR). Só o
  CLP escravo de ensaio e os clientes deste projeto foram usados até agora.

## Exportar para PLCopen XML (OpenPLC Editor, Beremiz)

**Exportar ▾ → PLCopen XML (.xml)** gera o programa no formato de troca da IEC 61131-3 (TC6 XML 2.01, namespace
`http://www.plcopen.org/xml/tc6_0201`), o mesmo do OpenPLC Editor e do Beremiz. O arquivo traz um POU do tipo
`program` em linguagem LD, as variáveis e uma configuração com tarefa de 10 ms. Um painel lista as observações da
conversão; os itens marcados **Atenção** mudam o comportamento e precisam de ajuste no editor de destino.

> **Importação nesses editores ainda não testada** (instalar o OpenPLC Editor ou o Beremiz depende de aprovação da
> TI). Antes de usar, importe, confira o desenho e compile lá.

| CLP Simu | PLCopen / IEC 61131-3 |
|---|---|
| NA, NF, borda P/N | `contact` (`negated`, `edge="rising"`/`"falling"`) |
| Bobina, negada, Set, Reset | `coil` (`negated`, `storage="set"`/`"reset"`) |
| TON, TOF | bloco `TON`/`TOF` (instância = o T); PT como literal `T#5s` / `T#1500ms` |
| CTU, CTD | bloco `CTU`/`CTD` (instância = o C); a entrada R (ou LD) vem da variável auxiliar `<contador>_R` |
| Reset (R) de contador | bobina da variável `<contador>_R` |
| Comparação (A >= B…) | bloco `GE`, `GT`… com EN = energia que chega; a saída OUT continua o degrau |
| MOVE, ADD … MOD | bloco com EN = energia do degrau; OUT ligado à variável de destino |
| Fios e ligações verticais | conexões (várias no mesmo ponto = OU) |
| Contato em T/C | saída da instância: `T_MISTURA.Q`, `CONT_LOTES.Q` |
| C ou T como número | `CONT_LOTES.CV` (INT) e `T_MISTURA.ET` (TIME; uma constante comparada com ele vira `T#…`) |

**Variáveis:** os nomes vêm dos símbolos, ajustados às regras de identificador da IEC (sem acento, só letras, dígitos
e `_`; palavras reservadas como `TON` ganham o endereço no fim). Sem símbolo, o nome é o endereço (`I0_3`, `MW2`).
Entradas e saídas recebem endereço (`%IX0.0`, `%QX0.0`), assim como `IW` (`%IW0`) e `MW` (`%MW1`); bits `M` viram
variáveis internas sem endereço. No OpenPLC Runtime, `%MW0` corresponde ao registrador *holding* 1024, e não ao 0
como no modo servidor do CLP Simu.

**Diferenças conhecidas:**
- Reset (R) de temporizador não existe na IEC (o TON/TOF zera quando IN desliga): essas bobinas não são exportadas
  e geram um aviso.
- Reset de contador passa pela variável `<contador>_R`. Se o degrau do Reset vier depois do contador, o efeito
  aparece na varredura seguinte; vários Reset do mesmo contador em degraus diferentes geram aviso.
- CTD: no CLP Simu começa em PV; na IEC começa em 0 até um pulso em LD.
- Blocos de aritmética: no CLP Simu, sem energia o destino não muda. Confira no editor de destino como ele trata EN
  desligado.
- `T` usado como número junto com `MW`/`IW`/`C` gera aviso: na IEC é TIME, não INT.

**Como foi verificado:** os testes (`tests/plcopen.test.js`) leem o XML gerado, conferem a estrutura (ordem dos
elementos, `localId` únicos, toda conexão apontando para um elemento existente, escape de textos) e **executam o LD do
arquivo** com um interpretador próprio. Esse interpretador controla a esteira e o tanque (os dois exemplos) em paralelo
com o CLP Simu, e as saídas e as MW são comparadas a cada varredura: são iguais do início ao fim. Isso confere a
tradução do desenho; a interpretação do OpenPLC/Beremiz ainda precisa ser conferida lá. O arquivo também foi lido sem
erros pelo leitor de XML do navegador.

**Validação contra o esquema oficial (23/11/2026):** os três exemplos e uma amostra com todos os tipos de elemento
passaram, com 0 erros, no esquema `tc6_xml_v201.xsd` (TC6 XML 2.01). A cópia usada é a do repositório do Beremiz
no GitHub (`plcopen/tc6_xml_v201.xsd`, 85.975 bytes, SHA-256 `591b92ba…51e20f`). O validador é o do .NET
(`XmlSchemaSet`), no PowerShell 7 e no Windows PowerShell 5.1. Os únicos avisos são do texto XHTML dos comentários,
que o esquema aceita em modo livre (*lax*). Como controle, oito cópias com defeitos de propósito (atributo
obrigatório faltando, ordem de elementos errada, elemento desconhecido, namespace errado, valores fora da
enumeração, cabeçalho faltando) foram todas recusadas.

Para repetir depois de mudar o exportador (o esquema não acompanha o projeto; baixe-o à parte):

```powershell
node tools/plcopen.mjs --pasta saida-plcopen
```

```powershell
pwsh tools/validar-plcopen.ps1 -Xsd caminho/tc6_xml_v201.xsd -Xml saida-plcopen/*.xml
```

Para exportar um programa seu pela linha de comando: `node tools/plcopen.mjs --programa programa-tanque.json --maquina tanque`.

## Arquitetura

```
index.html, css/style.css     interface (HTML/CSS/JS puro, sem bibliotecas externas)
server.mjs                    servidor estático local (Node, sem dependências)
src/engine/                   núcleo do CLP, sem DOM (testável em Node)
  address.js                  endereços I/Q/M/T/C, palavras MW/IW, operandos INT
  elements.js                 catálogo de instruções (bits, blocos, comparação, aritmética)
  program.js                  modelo do programa, validação/compilação, importação
  ladder.js                   fluxo de energia do degrau (nós, ligações verticais)
  plc.js                      memória, varredura, TON/TOF/CTU/CTD, bordas
  plcopen.js                  exportação para PLCopen XML (TC6 2.01)
src/machines/                 simulações físicas + desenho em canvas + programas de exemplo
src/engine/iomap.js           mapa I/Q/analógicos ↔ Modbus (compartilhado navegador/servidor)
src/ui/                       editor ladder (SVG), painel, laço de simulação, ligação com a ponte
server/                       servidor local (não é entregue ao navegador)
  app.mjs                     HTTP estático + /api/planta + WebSocket /bridge + Modbus TCP
  modbus.mjs                  Modbus TCP: servidor (com lista de IPs), cliente e codificação (FC 1–6, 15, 16)
  plant-runner.mjs            máquina rodando no servidor, em tempo real (modos com CLP externo)
  modbus-poller.mjs           modo "o simulador se conecta ao CLP" (cliente Modbus, watchdog)
  plc-escravo.mjs             CLP escravo de ensaio (memória + ladder), usado pela ferramenta e pelos testes
  websocket.mjs               WebSocket mínimo (RFC 6455), só texto
  bridge.mjs                  ponte planta ↔ tabelas Modbus, watchdog
  external-plc.mjs            CLP Simu rodando como mestre Modbus
tools/                        linha de comando: clp-externo.mjs, clp-escravo.mjs (CLP de ensaio), modbus.mjs, plcopen.mjs
                              e validar-plcopen.ps1 (validar contra o XSD do PLCopen)
tests/                        node:test — motor, máquinas, Modbus, integração e PLCopen
```

**Nova máquina:** crie `src/machines/<nome>.js` seguindo o formato de `conveyor.js`
(`inputs`, `outputs`, `controls`, `createSim`, `render`, `exampleProgram` e, opcionalmente, `analogs`), registre em
`src/machines/index.js` e acrescente um teste de integração em `tests/machines.test.js`.

## Limitações conhecidas

- Só inteiros de 16 bits (INT): sem REAL/DINT, sem saídas analógicas (`QW`), SFC, ST ou blocos de função do usuário.
- Registradores *holding* só no modo servidor e só para MW0–MW63; bits de memória (M) não são acessíveis pelo Modbus.
- Fluxo de energia só da esquerda para a direita (como na IEC 61131-3); não há fluxo reverso.
- Exporta para PLCopen XML, mas ainda não importa (nem PLCopen, nem TIA, etc.).
- Modos com Modbus: uma aba por vez fica conectada (outra aba assume a conexão). Nos modos de CLP externo a máquina
  roda no servidor e não depende da aba. Nos modos de CLP interno o ladder roda na página: com a aba em segundo plano
  o navegador pausa a animação e a máquina congela (escritas do supervisório chegam mesmo assim e são aplicadas).
- Fechar ou recarregar a página encerra a máquina do servidor (e a conexão com o CLP).
- A física das máquinas é simplificada e serve para ensino e prototipagem de lógica.
