# Teste de carga

Três testes, um para cada parte do sistema que pode saturar de um jeito diferente: a API REST, o
gateway em tempo real e o SFU. Os números abaixo são de execuções reais; as saídas brutas estão em
[`load/results`](../load/results).

## Ambiente

|                  |                                                                              |
| ---------------- | ---------------------------------------------------------------------------- |
| Máquina          | AMD Ryzen 7 5700G (8 núcleos, 16 threads), 32 GB, Windows 11                 |
| Serviços         | Builds de produção (`pnpm build && pnpm start:local`), `NODE_ENV=production` |
| API              | 1 processo Node 24                                                           |
| Mídia            | 4 workers mediasoup 3.29                                                     |
| Banco            | PostgreSQL 18 e Redis (Memurai 8) locais, sem tuning                         |
| Gerador de carga | k6 2.3 e Chromium (Playwright 1.64), **na mesma máquina**                    |
| Limites de taxa  | Elevados para o teste (todos os usuários virtuais vêm do mesmo IP)           |

Duas ressalvas que valem para tudo o que segue:

- **Gerador e servidor dividem a CPU.** Os números são um piso, não um teto: numa execução com o
  gerador em outra máquina o servidor teria mais CPU, mas a rede deixaria de ser `localhost`.
- **Não é a VM de produção.** O alvo de deploy é uma VM ARM de 2 núcleos, mais lenta por núcleo do
  que esta máquina. Repetir os testes lá está na lista de pendências.

## Como reproduzir

```bash
pnpm build
RATE_LIMIT_MAX=1000000 RATE_LIMIT_AUTH_MAX=1000000 RATE_LIMIT_MESSAGES_MAX=1000000 \
  MEDIA_NUM_WORKERS=4 pnpm start:local

k6 run -e VUS=200 load/k6/api.js
k6 run -e VUS=500 -e MESSAGES_PER_SECOND=10 load/k6/gateway.js
MEDIA_SECRET=local-media-secret-local-media-secret PARTICIPANTS=16 \
  pnpm --filter @frequencia/web load:voice
```

## 1. API REST

[`load/k6/api.js`](../load/k6/api.js). Todos os usuários virtuais são membros do **mesmo servidor**
(que portanto tem 50, 200 ou 500 membros). Cada um, a cada 0,5–1,5 s, faz uma de três coisas:
carregar o servidor (50%), carregar o histórico do canal (30%) ou enviar uma mensagem (20%).
Rampa de 20 s, 60 s de carga constante.

| Usuários virtuais | Requisições/s | p95 geral | p95 `GET /guilds/:id` | p95 `GET …/messages` | p95 `POST …/messages` | Erros | CPU da API  |
| ----------------- | ------------- | --------- | --------------------- | -------------------- | --------------------- | ----- | ----------- |
| 50                | 42,6          | 9 ms      | 7 ms                  | 9 ms                 | 8 ms                  | 0%    | não medido  |
| 200               | 168,4         | 34 ms     | 27 ms                 | 41 ms                | 40 ms                 | 0%    | 0,82 núcleo |
| 500               | 161,4         | 3,37 s    | 1,81 s                | 3,52 s               | 3,54 s                | 0%    | 1,33 núcleo |

**Leitura.** Até 200 usuários ativos a API responde em dezenas de milissegundos. Com 500 ela
satura: a vazão para de crescer (161 req/s, abaixo dos 168 de antes) e as requisições passam a
esperar em fila. Nenhuma falha — só espera.

**Onde está o gargalo.** Cada requisição autenticada sobre um servidor recarrega do banco o
_snapshot_ daquele servidor (cargos, canais, sobrescritas, membros: 6 consultas) para calcular
permissões sobre dados frescos. Com 500 membros esse snapshot é grande, e montá-lo é trabalho de
CPU numa única thread do Node. O 1,33 núcleo em vez de 1,0 é a thread principal saturada mais o
pool de I/O e o argon2.

**O que fazer quando isso importar.** Em ordem de custo: (1) cachear o snapshot por servidor com
invalidação pelos mesmos eventos que o gateway já usa para isso; (2) rodar mais de uma instância
da API, o que a arquitetura já suporta (estado em Postgres/Redis, eventos por pub/sub, testado com
duas instâncias). Para o uso pretendido — grupos de amigos — 170 req/s são duas ordens de grandeza
de folga, então a escolha foi manter a leitura sempre fresca.

O cadastro (`POST /auth/register`, argon2id com 19 MiB e 2 iterações) ficou em p95 de 22 ms sem
carga e 1,42 s sob saturação: é a operação mais cara por requisição, de propósito.

## 2. Gateway

[`load/k6/gateway.js`](../load/k6/gateway.js). _N_ clientes conectam por WebSocket, fazem
`IDENTIFY`, mantêm o heartbeat e ficam ouvindo, todos no mesmo servidor. Dez outras contas enviam
mensagens a uma taxa fixa. Cada mensagem leva no conteúdo o instante do envio; cada ouvinte mede
quanto tempo ela levou para chegar (REST → Postgres → Redis pub/sub → gateway → socket).

| Conexões | Mensagens/s | Eventos entregues/s | Latência de entrega (mediana / p95) | `READY` p95 | CPU da API  |
| -------- | ----------- | ------------------- | ----------------------------------- | ----------- | ----------- |
| 200      | 5           | 1.175               | 9 ms / 13 ms                        | 9 ms        | 0,13 núcleo |
| 500      | 10          | 6.479               | 15 ms / 26 ms                       | 318 ms      | 0,44 núcleo |
| 1.000    | 10          | 18.339              | 29 ms / 19,1 s                      | 5,57 s      | 0,93 núcleo |

**Leitura.** Com 500 pessoas conectadas no mesmo servidor, uma mensagem chega a todas em 26 ms no
p95, usando menos de meio núcleo. Com 1.000 a mediana ainda é 29 ms, mas a cauda explode.

**Por que 1.000 quebra.** Não é a entrega de mensagens, é a entrada. O teste põe 1.000 contas
novas no mesmo servidor em 20 segundos, e cada entrada gera um `MEMBER_ADD` para todos os já
conectados — trabalho quadrático — além de invalidar o snapshot em cache do gateway, que então é
recarregado com até 1.000 membros. As mensagens enviadas durante essa tempestade esperam atrás
dela na fila daquele servidor (o gateway processa os eventos de um servidor em ordem). É um
cenário artificial, mas aponta o limite real do desenho: **servidores muito grandes com muita
rotatividade**. A correção seria agrupar eventos de entrada e atualizar o snapshot em cache de
forma incremental.

Zero conexões falharam ou caíram em qualquer uma das execuções.

## 3. Voz e transmissão de tela

[`apps/web/load/voice-load.ts`](../apps/web/load/voice-load.ts). Um Chromium por participante
(Playwright, `--use-fake-device-for-media-stream`), percorrendo o fluxo real: cadastro, convite,
token de voz, entrada no canal. Todos entram no **mesmo canal** com microfone sintético; o primeiro
transmite a tela em 1080p30 e todos os outros assistem. Depois de 10 s de aquecimento, 60 s de
medição: métricas Prometheus dos dois serviços a cada 5 s e, em cada espectador,
`getVideoPlaybackQuality()` do elemento de vídeo.

| Participantes | Producers | Consumers | CPU do worker mediasoup | Resolução recebida | fps médio | Quadros descartados¹ | Download por espectador |
| ------------- | --------- | --------- | ----------------------- | ------------------ | --------- | -------------------- | ----------------------- |
| 4             | 6         | 18        | 0,05 núcleo             | 1920×1080          | 20        | 0%                   | 951 kbps                |
| 8             | 10        | 70        | 0,14 núcleo             | 1920×1080          | 20        | 4,5%                 | 1.018 kbps              |
| 16            | 17        | 255       | 0,49 núcleo             | 1920×1080          | 18,7      | 44%                  | 970 kbps                |
| 24            | 17²       | 391       | 0,58 núcleo             | 960×540³           | 10,8      | 50%                  | 568 kbps                |

¹ Medido no cliente: quadros que o navegador recebeu e decodificou, mas não conseguiu exibir a
tempo.
² Só 16 dos 24 microfones sintéticos abriram (as capturas além disso falharam no Chromium do
gerador de carga); os outros 8 participantes entraram como ouvintes, que é como o app trata a
falta de microfone. Nas execuções de 16 e 24 a
transmissão saiu sem áudio do sistema, pelo motivo descrito abaixo.
³ Todos os 23 espectadores foram rebaixados para a camada intermediária do simulcast.

**Leitura do lado do servidor.** O processo Node do serviço de mídia ficou abaixo de 2% de um
núcleo em todos os casos: ele só faz sinalização. O trabalho está no worker C++, e cresce com o
número de consumers: 255 consumers custaram meio núcleo, 391 custaram 0,58. Um canal vive em um
worker, então **um canal tem um núcleo de teto**; por essa curva, um canal com 24 pessoas e uma
transmissão usa pouco mais da metade dele nesta máquina. A API não participa do caminho de mídia
(0,5% de um núcleo).

**Leitura do lado do cliente.** A partir de 16 participantes quem satura é o gerador de carga: são
16 a 24 navegadores decodificando 1080p por software na mesma máquina que roda o servidor. Os
quadros descartados e a queda de fps são sintoma disso, não de perda no SFU. O caso de 24 mostra o
simulcast fazendo o que deve: com os receptores sem fôlego, a estimativa de banda caiu e o SFU
passou a encaminhar a camada de 540p para todos, em vez de insistir em 1080p.

**O conteúdo é sintético.** A captura de tela falsa do Chromium é um padrão de teste a 20 fps que
comprime muito bem (cerca de 1 Mbps em 1080p). Uma tela real com vídeo ou jogo ocuparia os 3 a
5 Mbps do preset, e o custo no SFU cresce com o volume de pacotes. Estes números medem a escala em
participantes e consumers, não em bitrate.

### Um defeito encontrado pelo teste

Na primeira execução com 16 participantes a transmissão não iniciava: o Chromium recusava a
captura do áudio do sistema (`NotReadableError: Could not start audio source`) e o app abortava a
transmissão inteira, mostrando um erro genérico. O mesmo pode acontecer com um usuário real cujo
dispositivo de áudio esteja ocupado ou indisponível. Corrigido em `VoiceSession.startScreenShare`:
se a captura com áudio falha, ela é refeita só com vídeo, e a interface avisa que a transmissão
está sem áudio.

## Resumo

| Componente | Folga observada                                      | Primeiro limite                                         |
| ---------- | ---------------------------------------------------- | ------------------------------------------------------- |
| API        | ~170 req/s com p95 < 40 ms em um processo            | CPU de uma thread recarregando o snapshot do servidor   |
| Gateway    | 500 conexões por servidor com entrega em 26 ms (p95) | Tempestade de entradas em servidores com ~1.000 membros |
| SFU        | 24 pessoas e 391 consumers em 0,58 núcleo            | Um núcleo por canal; não foi atingido                   |

Para o uso a que o projeto se destina — alguns grupos de amigos, canais com até uma dúzia de
pessoas — todos os componentes operam com ordens de grandeza de folga numa única máquina.
