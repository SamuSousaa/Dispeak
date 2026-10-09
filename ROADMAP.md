# Roadmap

Cada etapa só é marcada como concluída depois de `pnpm check` (lint, format, typecheck, testes)
passar e de um commit ser feito.

## Etapa 0 — Fundação

- [x] Monorepo pnpm workspaces + Turborepo
- [x] Configs compartilhadas de TypeScript (strict), ESLint e Prettier
- [x] `docker-compose.yml` de dev com Postgres, Redis e serviço de mídia
- [x] CI no GitHub Actions (lint, typecheck, testes, build)
- [x] Script único `pnpm dev`

**Aceite**

- [x] `pnpm install && pnpm dev` sobe web, api e media
- [ ] O CI passa (workflow pronto; aguardando primeiro push — ver Pendências)

## Etapa 1 — Chamada 1:1 P2P com sinalização própria

- [x] Protocolo de sinalização tipado (request/response/evento) com schemas Zod em `packages/shared`
- [x] Servidor de sinalização no gateway WebSocket da API
- [x] Offer/answer/ICE com STUN público, áudio e vídeo entre dois navegadores
- [x] Rota `/lab/p2p` no front
- [x] Camada de protocolo reaproveitável na etapa 2

**Aceite**

- [x] Duas abas/dispositivos se veem e se ouvem
- [x] Teste de integração do servidor de sinalização

## Etapa 2 — SFU com mediasoup: canais de voz

- [x] Um worker por núcleo, balanceamento de rooms entre workers
- [x] Um Router por canal; transports de envio e recebimento por participante
- [x] Entrar/sair, mutar, ensurdecer, com estado sincronizado
- [x] Indicador de fala via `AudioLevelObserver`
- [x] Opus com DTX e FEC
- [x] Reconexão e limpeza de transports/producers órfãos
- [x] Identificação por apelido (substituída na etapa 4)

**Aceite**

- [x] 4+ abas no mesmo canal conversando
- [x] Indicador de fala funcionando
- [x] Sair do canal libera todos os recursos no servidor (coberto por teste)

## Etapa 3 — Transmissão de tela

- [x] `getDisplayMedia` com áudio do sistema quando disponível (aviso na UI quando não houver)
- [x] Simulcast VP8 em 3 camadas; camada escolhida conforme o tamanho exibido
- [x] Assistir sob demanda (consumer só existe enquanto se assiste)
- [x] Várias transmissões simultâneas no mesmo canal
- [x] Presets de qualidade (720p30, 1080p30, 1080p60)
- [x] Tela cheia e modo foco
- [x] Painel de estatísticas reais via `getStats`

**Aceite**

- [x] Duas pessoas transmitindo ao mesmo tempo
- [x] Espectador assistindo só uma recebe apenas aquele vídeo (verificável nas estatísticas do servidor)

## Etapa 4 — API REST e gateway estilo Discord

- [x] Auth: cadastro/login (argon2), JWT de acesso curto, refresh rotativo em cookie httpOnly, logout e revogação
- [x] Servidores: CRUD, convites com código, expiração e limite de usos
- [x] Canais de texto e voz, ordenação, categorias
- [x] Cargos e permissões em bitflags, hierarquia, sobrescritas por canal, testes unitários extensos
- [x] Gateway: autenticação, heartbeat, sequência, `resume`; eventos de presença, voz, canais e membros
- [x] Presença e estado de voz em Redis com pub/sub (múltiplas instâncias da API)
- [x] Token de voz de curta duração emitido pela API e validado pelo serviço de mídia
- [x] Rate limiting por rota e no gateway
- [x] OpenAPI em `/docs`

**Aceite**

- [x] Fluxo criar conta → criar servidor → convidar amigo → entrar no canal de voz → transmitir, respeitando permissões
- [x] e2e no Playwright cobrindo o fluxo

## Etapa 5 — Chat de texto, produção e portfólio

- [ ] Mensagens: enviar, editar, excluir, menções, paginação por cursor, "digitando"
- [ ] Dockerfiles de produção e `docker-compose.prod.yml` com Caddy (HTTPS) e coturn
- [ ] `docs/deploy.md` para VM ARM da Oracle Cloud Always Free
- [ ] `/metrics` Prometheus (usuários conectados, canais ativos, producers/consumers, CPU dos workers)
- [ ] Teste de carga: k6 (API e gateway) e Playwright/Chromium com mídia falsa; `docs/load-test.md`
- [ ] README de portfólio
- [ ] `docs/adr/`

**Aceite**

- [ ] O projeto sobe em produção com um comando
- [ ] README e docs completos
- [ ] Teste de carga com números reais

## Pendências

Itens que dependem do dono do projeto ou que não puderam ser verificados no ambiente de
desenvolvimento.

- **Docker não está instalado na máquina de desenvolvimento** (nem WSL2; a virtualização está
  habilitada no firmware, mas instalar exige administrador e reinicialização). Consequências:
  - `docker-compose.yml`, `apps/media/Dockerfile` e o modo `pnpm dev:docker` foram escritos, mas
    **não executados localmente**. Precisam de uma primeira execução após instalar o Docker Desktop.
  - O serviço de mídia roda nativamente no Windows com o worker pré-compilado do mediasoup; é assim
    que tudo foi desenvolvido e testado.
  - Sem Docker, `pnpm dev` e `pnpm test` sobem um Postgres 18 e um Redis embutidos
    (`embedded-postgres` e `redis-memory-server`, que no Windows baixa o Memurai). Todos os testes
    de integração e e2e rodaram contra eles. No CI os testes usam Postgres 17 e Redis 7 em
    containers de serviço; essa combinação ainda não foi executada.
- **Repositório remoto e CI:** o `gh` CLI não está instalado e não há remoto configurado. O workflow
  `.github/workflows/ci.yml` roda os mesmos comandos de `pnpm check` + `pnpm build`, que passam
  localmente, mas a primeira execução no GitHub Actions depende de criar o repositório e dar push.
- **Teste entre dispositivos reais (etapa 1 em diante):** a chamada P2P é verificada por e2e com dois
  contextos de navegador na mesma máquina (câmera/microfone sintéticos do Chromium). Falta um teste
  manual entre dois dispositivos em redes diferentes. Em LAN, use `DEV_HTTPS=1 pnpm dev` e abra
  `https://<ip-da-máquina>:5173` (o navegador só libera microfone/câmera em contexto seguro).
  Sem TURN, pares atrás de NAT simétrico não conectam em P2P — o coturn entra na etapa 5.
- **Voz com microfones reais (etapa 2):** o e2e coloca 4 participantes no mesmo canal com o
  microfone sintético do Chromium e verifica áudio fluindo, indicador de fala, mute/deafen e
  liberação de recursos. Qualidade subjetiva do áudio (eco, ruído, volume) e o comportamento em
  redes reais só podem ser avaliados com pessoas e dispositivos de verdade.
- **Transmissão com tela e áudio reais (etapa 3):** o e2e usa a captura sintética do Chromium
  (três camadas de simulcast confirmadas: 270p/540p/1080p). Falta validar manualmente a nitidez de
  texto, o preset 1080p60 com um jogo e a captura de áudio do sistema, que depende do navegador e
  do sistema operacional (no Chrome/Windows funciona para tela inteira e abas; Firefox e Safari
  não entregam áudio — a UI avisa quando a transmissão sai sem áudio).
- **Resume do gateway entre instâncias (etapa 4):** eventos, presença e estado de voz atravessam
  instâncias da API via Redis pub/sub (coberto por teste com duas instâncias). O buffer de replay
  do `resume`, porém, vive na memória da instância que atendia o socket: se o cliente reconectar
  em outra instância, recebe `INVALID_SESSION` e faz um `identify` completo (sem perda de
  consistência, só um resync). Com mais de uma instância em produção, vale configurar afinidade
  de sessão no balanceador. Decisão registrada em `docs/adr/`.
- **Revalidação de permissões durante a chamada (etapa 4):** perder `CONNECT` derruba a pessoa do
  canal e mudar `SPEAK`/`STREAM` força um reingresso com token novo, mas isso depende do elo
  API → mídia estar de pé no momento da mudança. Se ele estiver fora do ar, a revalidação só
  acontece na próxima vez que a pessoa entrar no canal.
