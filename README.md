# Dispeaker

[English version](README.en.md)

App de voz, transmissão de tela e chat no estilo Discord/TeamSpeak, com **toda a infraestrutura de
mídia e tempo real implementada no próprio projeto**: um SFU construído sobre mediasoup, um
gateway WebSocket com retomada de sessão e um protocolo de sinalização tipado de ponta a ponta.
Nenhum serviço gerenciado de mídia ou de tempo real (LiveKit, Agora, Twilio, Firebase etc.).

![Canal de voz com uma transmissão de tela em 1080p e o painel de estatísticas](docs/images/voz-transmissao.png)

![Canal de texto com menção e indicador de digitação](docs/images/chat.png)

## O que tem

- **Canais de voz** roteados por um SFU próprio: mutar, ensurdecer, indicador de quem está falando,
  reconexão automática, atalhos de teclado configuráveis, apertar para falar e volume individual
  por pessoa.
- **Supressão de ruído** por rede neural rodando no navegador (GTCRN em WebAssembly, com RNNoise
  de reserva), um só botão de liga e desliga; microfone, saída e volumes trocados sem abrir as
  configurações, pelas setas ao lado dos botões de microfone e fone.
- **Câmera** em simulcast VP8, exibida no quadro de cada participante.
- **Transmissão de tela** em H.264 pela placa de vídeo de quem transmite, quando ela codifica
  (VP8 no processador caso contrário), com três presets (720p30, 1080p60 e 1440p30 para
  filmes), áudio do sistema a 256 kbps, várias transmissões ao mesmo
  tempo, destaque por clique, tela cheia e janela flutuante (picture-in-picture).
- **App de desktop para Windows** (Electron): mantém a taxa de quadros de uma transmissão com o
  jogo em tela cheia, atalhos de teclado que valem com o jogo em foco, transmissão do jogo com
  um atalho, atualização automática. Ver [App de desktop](#app-de-desktop).
- **Amigos e conversas privadas**: pedido de amizade pelo nome de usuário, conversa de texto e
  chamada a dois, com toque de chamada recebida.
- **Assistir sob demanda**: o vídeo só é encaminhado para quem clicou em assistir. Nos presets
  de 30 fps e na câmera, a camada de simulcast é escolhida pelo tamanho em que o vídeo aparece
  na tela de cada espectador.
- **Servidores, canais e categorias**, convites com expiração e limite de usos; foto de perfil e
  ícone do servidor.
- **Cargos e permissões** em bitflags, com hierarquia e sobrescritas por canal, aplicadas no
  servidor inclusive durante uma chamada em andamento.
- **Chat de texto** com edição, exclusão, menções, paginação por cursor e "digitando"; emojis e
  imagens (PNG, JPEG, GIF, WebP) anexadas pelo botão, coladas ou arrastadas, guardadas em disco e
  servidas com as permissões do canal; reações, respostas, enquetes, tópicos, arquivos de qualquer tipo para download, prévias de
  links, mensagens não lidas por canal e, opcionalmente, busca de GIF. O chat também abre ao lado de uma chamada.
- **Menus de contexto** (clique direito ou toque longo) em canais, pessoas e mensagens.
- **Gateway em tempo real** no estilo Discord: heartbeat, números de sequência e `resume`.
- **Observabilidade**: métricas Prometheus e um painel de estatísticas reais (`getStats`) na
  interface.

## Demo

O projeto roda numa VPS para um grupo fechado de amigos (o cadastro pede um código de acesso),
então não há demo aberta; o guia de deploy está em [docs/deploy.md](docs/deploy.md). Para ver
funcionando, são dois comandos e nenhum serviço externo — nem Docker é obrigatório:

```bash
pnpm install
pnpm dev        # http://localhost:5173
```

Abra em duas janelas (uma delas anônima), crie duas contas, crie um servidor, gere um convite e
entre no canal de voz com as duas. O laboratório em `/lab` exercita a camada de mídia isolada, sem
contas: chamada 1:1 ponto a ponto (`/lab/p2p`) e canais de voz por apelido (`/lab/voice`).

## Arquitetura

```mermaid
flowchart LR
  subgraph Navegador
    WEB[React + mediasoup-client]
  end

  subgraph Servidor
    CADDY[Caddy<br/>HTTPS + arquivos estáticos]
    API[API<br/>Fastify: REST + gateway WS]
    MEDIA[Mídia<br/>Node + mediasoup SFU]
    PG[(PostgreSQL)]
    REDIS[(Redis)]
    TURN[coturn<br/>STUN/TURN]
  end

  WEB -- "HTTPS /api, WSS /api/gateway" --> CADDY
  WEB -- "WSS /media/voice (sinalização)" --> CADDY
  CADDY --> API
  CADDY --> MEDIA
  WEB == "RTP/SRTP direto<br/>UDP/TCP 40000+" ==> MEDIA
  WEB -. "relay quando a rede bloqueia" .-> TURN
  TURN -.-> MEDIA
  API --> PG
  API <--> REDIS
  API <-- "RPC interno autenticado (WS)" --> MEDIA
```

Três serviços, cada um com uma responsabilidade:

| Serviço      | Faz                                                                                 | Não faz                    |
| ------------ | ----------------------------------------------------------------------------------- | -------------------------- |
| `apps/web`   | Interface, captura e reprodução de mídia, clientes do gateway e da sinalização      | Decidir permissões         |
| `apps/api`   | Contas, servidores, permissões, chat, gateway, emissão de tokens de voz             | Tocar em mídia             |
| `apps/media` | SFU: um Router por canal de voz, transports, producers, consumers, detecção de fala | Conhecer usuários ou banco |

O serviço de mídia não consulta banco nem sabe o que é um cargo. Quem decide se alguém pode entrar
num canal é a API, que entrega ao navegador um **token de voz de 60 segundos** com o que aquela
pessoa pode fazer ali (falar, transmitir). O serviço de mídia só valida a assinatura:

```mermaid
sequenceDiagram
  participant N as Navegador
  participant A as API
  participant M as Mídia (SFU)

  N->>A: POST /channels/:id/voice-token
  A->>A: calcula permissões (cargos + sobrescritas do canal)
  A-->>N: token (60 s) + servidores ICE
  N->>M: WSS /media/voice?token=...
  M->>M: valida assinatura e expiração
  N->>M: join, createTransport, produce (microfone)
  M-->>A: voice-state (RPC interno)
  A-->>N: VOICE_STATE_UPDATE para o servidor inteiro (gateway)
  Note over N,M: áudio e vídeo trafegam direto entre navegador e SFU
  A->>M: disconnectUser, se a pessoa perder a permissão
```

Mais detalhes em [docs/architecture.md](docs/architecture.md); as decisões e suas alternativas
estão em [docs/adr](docs/adr/README.md).

## Por que SFU e não mesh

Numa malha ponto a ponto cada participante envia sua mídia para todos os outros. Com _N_ pessoas
são _N − 1_ uploads por pessoa e _N × (N − 1)_ conexões no total: 4 pessoas já são 12 fluxos, e
uma transmissão de tela em 1080p para 7 espectadores exigiria 7 codificações ou 7 uploads de
3 Mbps da casa de quem transmite. O upload doméstico acaba antes do sexto amigo.

Com um SFU (_Selective Forwarding Unit_) cada pessoa envia **uma vez** para o servidor, que
repassa os pacotes para quem deve receber, sem decodificar nada. Isso muda três coisas:

1. **O upload de cada um é constante**, não importa quantos estão no canal.
2. **O servidor escolhe o que encaminhar.** É isso que permite simulcast (cada espectador recebe a
   camada que cabe na sua tela e na sua rede), o "assistir sob demanda" e o ensurdecer que de fato
   economiza banda, porque o áudio para de ser enviado em vez de ser só silenciado no cliente.
3. **Regras são aplicadas no servidor.** Mutar pausa o producer no SFU; perder a permissão de
   transmitir derruba a sessão. Em mesh, tudo isso seria um pedido educado ao cliente.

O preço é ter um servidor de mídia para operar, e é justamente essa a parte que o projeto se
propõe a construir. A chamada 1:1 em mesh continua no repositório (`/lab/p2p`) como referência e
compartilha a mesma camada de protocolo.

## Stack

| Camada   | Tecnologia                                                                        |
| -------- | --------------------------------------------------------------------------------- |
| Monorepo | pnpm workspaces, Turborepo, TypeScript `strict`                                   |
| Web      | React 19, Vite, Tailwind 4, mediasoup-client, TanStack Query, Zustand             |
| API      | Fastify 5, `@fastify/websocket`, Zod, OpenAPI (`/docs`), Drizzle ORM              |
| Mídia    | Node, mediasoup 3 (workers em C++), `ws`                                          |
| Dados    | PostgreSQL (migrations SQL), Redis (presença, estado de voz, pub/sub, rate limit) |
| Testes   | Vitest (unitários e integração), Playwright (e2e), k6 (carga)                     |
| Infra    | Docker, docker-compose, Caddy (HTTPS automático), coturn, GitHub Actions          |

## Como rodar

Requisitos: Node 22.12+ e pnpm 11. Docker é opcional em desenvolvimento.

```bash
pnpm install
pnpm dev
```

`pnpm dev` sobe Postgres e Redis (pelo `docker-compose.yml` se houver Docker; senão, instâncias
embutidas com dados em `.dev/`), aplica as migrations e inicia web (5173), API (4000) e mídia
(4100, mais as portas RTC a partir de 40000) em modo watch.

| Comando                          | O que faz                                                       |
| -------------------------------- | --------------------------------------------------------------- |
| `pnpm dev`                       | Stack completo em desenvolvimento                               |
| `pnpm dev:docker`                | Igual, com o serviço de mídia em container                      |
| `pnpm check`                     | Lint, formatação, typecheck e testes                            |
| `pnpm e2e`                       | Testes ponta a ponta (sobe o stack sozinho)                     |
| `pnpm build && pnpm start:local` | Builds de produção rodando localmente, sem Docker               |
| `pnpm prod:up`                   | Produção com Docker: Caddy, API, mídia, Postgres, Redis, coturn |
| `pnpm release:desktop`           | Gera o instalador do app de desktop e envia ao servidor         |

Notas de ambiente:

- **mediasoup no Windows:** o pacote traz o worker pré-compilado, então o serviço de mídia roda
  nativo, sem compilar nada. Se o binário não servir para a sua máquina, `pnpm dev:docker` roda só
  ele em container.
- **Outros dispositivos na rede local:** o navegador só libera microfone em contexto seguro. Rode
  com `DEV_HTTPS=1 pnpm dev` e abra `https://<ip-da-máquina>:5173`. O serviço de mídia já anuncia
  o IP da LAN além do `127.0.0.1`.
- **Configuração:** cada app tem um `.env.example` comentado; nada é obrigatório em
  desenvolvimento.

Produção é um comando depois de preencher `.env.prod` — passo a passo, portas e firewall em
[docs/deploy.md](docs/deploy.md).

## App de desktop

`apps/desktop` é uma janela Electron sobre o site publicado: a interface é a mesma, e o que o site
ganha o app ganha sem reinstalar. O motivo de existir está na
[ADR 0012](docs/adr/0012-app-de-desktop-electron.md). Em resumo, o Windows 11 desacelera os
temporizadores de um programa cuja janela está toda coberta, e o capturador de tela do navegador
passa a entregar um quadro a cada dois ou três tiques de 15,6 ms. Medido com um jogo em tela cheia,
na mesma máquina e no mesmo preset:

| Onde a transmissão roda | Quadros por segundo que chegam ao servidor |
| ----------------------- | ------------------------------------------ |
| Chrome                  | 26 a 31                                    |
| App de desktop          | 45 a 51                                    |

O que o app acrescenta ao navegador:

- pede ao Windows para ficar fora dessa regra (`SetProcessInformation`), o que um site não pode;
- atalhos globais para mutar, ensurdecer, transmitir, câmera e desligar. Só combinações com Ctrl
  ou Alt e as teclas F1 a F24, porque um atalho global tira a tecla de todos os outros programas.
  Ninguém começa com atalho: cada um define os seus em Configurações → Atalhos;
- o atalho de transmitir, apertado com um jogo em tela cheia na frente, transmite a janela desse
  jogo sem abrir o seletor; sem jogo na frente, abre o seletor;
- um seletor de tela próprio e o som do sistema sem o som da própria chamada;
- atualização automática a partir do próprio servidor.

```bash
pnpm --filter @frequencia/desktop start     # abre o app a partir do código
DISPEAKER_URL=http://localhost:5173 pnpm --filter @frequencia/desktop start   # contra o dev local
pnpm --filter @frequencia/desktop package   # instalador em apps/desktop/release
```

Para publicar uma versão: aumente `version` em `apps/desktop/package.json` e rode
`pnpm release:desktop`. O comando gera o instalador e envia, por SSH, o instalador, o mapa de
blocos e o `latest.yml` para a pasta que o Caddy serve em `/download/`. Ele lê `.env.release`,
que não vai para o repositório:

```bash
# .env.release (modelo em .env.release.example)
DESKTOP_RELEASE_SSH=root@203.0.113.10
DESKTOP_RELEASE_DIR=/opt/frequencia/downloads
DESKTOP_RELEASE_KEY=/home/voce/.ssh/id_ed25519
```

A página `/download` do site mostra o botão de instalação e a versão atual, lida do mesmo
`latest.yml`; os apps instalados conferem esse arquivo ao abrir e a cada três horas. O instalador
não é assinado, então o Windows mostra o aviso do SmartScreen na primeira instalação.

### Servidor só para convidados

Baixar o app não dá acesso a nada: ele só abre o site, e quem usa o servidor é quem tem conta.
Para que só pessoas escolhidas criem conta, defina um código no `.env.prod`:

```bash
REGISTRATION_CODE=um-codigo-que-so-seus-amigos-sabem
```

Com ele, a tela de cadastro pede o "código de acesso" e a API recusa o cadastro sem o código
certo. As contas que já existem continuam valendo. Sem a variável, qualquer pessoa que chegue ao
site pode se cadastrar.

## Testes

```
pnpm test    392 testes   permissões, protocolo RPC, API (Postgres e Redis reais),
                          SFU (workers mediasoup reais), reducers do cliente
pnpm e2e      12 testes   Chromium com câmera, microfone e tela sintéticos
```

Os testes de integração não usam mocks de infraestrutura. Alguns que valem a leitura:

- [`apps/media/test/voice.test.ts`](apps/media/test/voice.test.ts) pergunta ao próprio worker do
  mediasoup (`worker.dump()`) se sobrou algum router ou transport depois que todos saem do canal.
- [`packages/shared/src/permissions.test.ts`](packages/shared/src/permissions.test.ts) cobre o
  cálculo de permissões: sobrescritas, herança de categoria, hierarquia de cargos.
- [`apps/api/test/gateway.test.ts`](apps/api/test/gateway.test.ts) derruba conexões e verifica que
  o `resume` reentrega exatamente o que foi perdido, e sobe duas instâncias da API para conferir a
  entrega de eventos entre elas pelo Redis.
- [`apps/web/e2e/app.spec.ts`](apps/web/e2e/app.spec.ts) percorre criar conta → criar servidor →
  convidar → entrar na voz → transmitir, e tira permissões no meio da chamada.

## Teste de carga

Medido nos builds de produção, numa única máquina (Ryzen 7 5700G, 8 núcleos), com o gerador de
carga na mesma máquina. Metodologia, tabelas completas e arquivos brutos em
[docs/load-test.md](docs/load-test.md).

| Cenário                                        | Resultado                                                     |
| ---------------------------------------------- | ------------------------------------------------------------- |
| API, 200 usuários virtuais, 168 req/s          | p95 de 34 ms, 0% de erros, 0,8 núcleo                         |
| API, 500 usuários virtuais                     | satura: mesma vazão (161 req/s), p95 de 3,4 s                 |
| Gateway, 500 conexões num servidor, 10 msg/s   | entrega com p95 de 26 ms, 6,5 mil eventos/s, 0,44 núcleo      |
| Voz + tela, 16 pessoas, 1 transmissão em 1080p | 255 consumers, worker do mediasoup em 0,49 núcleo             |
| Voz + tela, 24 pessoas                         | 391 consumers, worker em 0,58 núcleo; o gargalo foi o gerador |

O limite encontrado está na API, não no SFU: um processo Node recalculando o estado do servidor a
cada requisição segura cerca de 170 req/s neste hardware. O teste de carga de voz também achou um
defeito real, corrigido: quando a captura do áudio do sistema falhava, a transmissão inteira era
abortada em vez de seguir só com vídeo.

## Estrutura

```
apps/
  web/      React: features/{auth,gateway,guilds,chat,voice,friends,desktop,app}, e2e/, load/
  api/      Fastify: modules/{auth,guilds,messages,voice}, gateway/, db/, drizzle/
  media/    mediasoup: rooms/{room,peer,room-manager}, signaling/{voice,internal}-server
  desktop/  Electron: janela sobre o site, seletor de tela, atalhos globais, atualização
packages/
  shared/   schemas Zod: protocolo RPC, sinalização, gateway, REST, permissões, ponte do desktop
deploy/     Caddyfile
docs/       arquitetura, deploy, teste de carga, ADRs
load/       scripts k6 e resultados brutos
scripts/    orquestração de dev e de produção local
```

## Limitações conhecidas

- Uma instância do serviço de mídia. O RPC interno e os tokens foram desenhados para vários nós,
  mas não há roteamento de canais entre nós de mídia.
- Um canal de voz vive em um worker (um núcleo). Dezenas de pessoas num canal cabem com folga;
  centenas exigiriam encadear routers (`pipeToRouter`).
- O `resume` do gateway é local à instância da API (ver [ADR 0006](docs/adr/0006-gateway-resume.md)).
- Sem gravação e sem conversas privadas em grupo (só a dois).
- Transmitir um jogo pelo navegador fica perto de 30 fps com o jogo em tela cheia; pelo app de
  desktop, perto de 50. Sessenta cravados pediriam um capturador próprio.
- O app de desktop existe só para Windows, sem assinatura de código, e "apertar para falar" não é
  global (o sistema avisa quando a tecla é apertada, não quando é solta).

O que ainda depende de validação manual ou de infraestrutura externa está em
[ROADMAP.md](ROADMAP.md), na seção "Pendências".

## Licença

[MIT](LICENSE).
