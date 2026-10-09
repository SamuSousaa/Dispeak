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

- [ ] `getDisplayMedia` com áudio do sistema quando disponível (aviso na UI quando não houver)
- [ ] Simulcast VP8 em 3 camadas; camada escolhida conforme o tamanho exibido
- [ ] Assistir sob demanda (consumer só existe enquanto se assiste)
- [ ] Várias transmissões simultâneas no mesmo canal
- [ ] Presets de qualidade (720p30, 1080p30, 1080p60)
- [ ] Tela cheia e modo foco
- [ ] Painel de estatísticas reais via `getStats`

**Aceite**

- [ ] Duas pessoas transmitindo ao mesmo tempo
- [ ] Espectador assistindo só uma recebe apenas aquele vídeo (verificável nas estatísticas do servidor)

## Etapa 4 — API REST e gateway estilo Discord

- [ ] Auth: cadastro/login (argon2), JWT de acesso curto, refresh rotativo em cookie httpOnly, logout e revogação
- [ ] Servidores: CRUD, convites com código, expiração e limite de usos
- [ ] Canais de texto e voz, ordenação, categorias
- [ ] Cargos e permissões em bitflags, hierarquia, sobrescritas por canal, testes unitários extensos
- [ ] Gateway: autenticação, heartbeat, sequência, `resume`; eventos de presença, voz, canais e membros
- [ ] Presença e estado de voz em Redis com pub/sub (múltiplas instâncias da API)
- [ ] Token de voz de curta duração emitido pela API e validado pelo serviço de mídia
- [ ] Rate limiting por rota e no gateway
- [ ] OpenAPI em `/docs`

**Aceite**

- [ ] Fluxo criar conta → criar servidor → convidar amigo → entrar no canal de voz → transmitir, respeitando permissões
- [ ] e2e no Playwright cobrindo o fluxo

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
