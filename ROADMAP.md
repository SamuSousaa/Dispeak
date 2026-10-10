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
- [x] O CI passa (os três jobs, desde 09/10/2026)

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

- [x] Mensagens: enviar, editar, excluir, menções, paginação por cursor, "digitando"
- [x] Dockerfiles de produção e `docker-compose.prod.yml` com Caddy (HTTPS) e coturn
- [x] `docs/deploy.md` para VM ARM da Oracle Cloud Always Free
- [x] `/metrics` Prometheus (usuários conectados, canais ativos, producers/consumers, CPU dos workers)
- [x] Teste de carga: k6 (API e gateway) e Playwright/Chromium com mídia falsa; `docs/load-test.md`
- [x] README de portfólio
- [x] `docs/adr/`

**Aceite**

- [x] O projeto sobe em produção com um comando — executado pela primeira vez em 10/10/2026 numa
      VPS x86 de 2 núcleos (Ubuntu 24.04), com HTTPS do Let's Encrypt. O fluxo e2e principal passou
      contra o servidor real a partir de uma rede com CGNAT. Achado da subida: o worklet do RNNoise
      não carregava no build de produção (corrigido).
- [x] README e docs completos
- [x] Teste de carga com números reais (medidos nos builds de produção rodando localmente, não na
      VM de deploy)

## Etapa 6 — Ajustes depois do primeiro teste real

- [x] Painel de controle na coluna de canais (voz conectada, câmera, transmissão, microfone, fone)
- [x] Configurações rápidas: microfone, saída, câmera, eco, ganho, atalhos de teclado configuráveis
- [x] Supressão de ruído com RNNoise (WebAssembly), com retorno ao filtro do navegador
- [x] Ações do servidor agrupadas no menu do nome do servidor
- [x] Presets 1440p60 e resolução original (até 4K); teto de 20 Mbps por transmissor no SFU
- [x] Câmera em simulcast, recebida por todos e exibida no quadro do participante
- [x] Clicar num canal de voz já entra nele
- [x] Emojis e imagens no chat (upload em disco, tipo conferido pelos bytes, permissões do canal)
- [x] Banco embutido de desenvolvimento criado em UTF-8 (no Windows nascia em WIN1252 e recusava
      emoji)
- [x] Sons de notificação (entrar, sair, transmissão começa e termina), com arquivos do usuário
- [x] Sons do servidor: o dono escolhe um arquivo por evento e todos os membros ouvem o mesmo
- [x] Animações de entrada em menus, painéis, mensagens e quadros de participantes
- [ ] Aplicativo instalável (atalhos globais, fora do navegador) — adiado

## Etapa 7 — Uso do dia a dia

- [x] Menu de contexto (clique direito ou toque longo) em canais, categorias, pessoas, mensagens e
      servidores
- [x] Volume individual por pessoa, só para quem ajusta (guardado no navegador)
- [x] Apertar para falar, com tecla configurável
- [x] Mensagens não lidas por canal e por servidor, com contador de menções, guardadas no servidor
      (valem em qualquer aparelho) e mostradas no título da aba
- [x] Notificação do sistema para menções, opcional
- [x] Reações com emoji e respostas a mensagens (responder menciona o autor)
- [x] Prévia de links: o servidor busca título, descrição e imagem, só em endereços públicos
- [x] Busca de GIF pela GIPHY, opcional (`GIPHY_API_KEY`); a chave fica no servidor
- [x] Configurações pessoais em abas (voz, vídeo, chat, sons, atalhos, conta)
- [x] Transmissão em janela flutuante (picture-in-picture)
- [x] Canal de texto ao lado da chamada
- [x] Ícones de mudo e ensurdecido na lista de quem está em cada canal de voz
- [x] Foto de perfil e ícone do servidor: a imagem é cortada em quadrado de 256 px no navegador e
      servida em `/api/images/:id` (pública, com id aleatório que muda a cada envio)

## Etapa 8 — Moderação e organização

- [x] Chat de texto próprio em cada canal de voz, aberto ao lado da chamada
- [x] Quadros dos participantes ocupam toda a área da chamada (o maior tamanho 16:9 que couber)
- [x] Categorias recolhíveis (mantêm à vista o canal aberto, a chamada em curso e o que não foi lido)
- [x] Um só menu de pessoa em todo lugar (clique, clique direito ou toque longo): volume e moderação
- [x] Moderação por permissão, com hierarquia: mutar no servidor, desconectar da chamada, expulsar,
      banir (com lista de banidos); o dono tem todas
- [x] Canal ou categoria privados com um clique, e a lista de quem pode ver
- [x] Cargos com cor do nome; novas permissões: anexar imagens, reagir, mutar, desconectar e banir
- [x] Lista de membros agrupada pelo cargo mais alto de quem está online
- [x] Correção: quem ficava sozinho num canal de voz era reconectado a cada 30 segundos
- [x] Painel único de emojis e GIFs, com o conjunto completo de emojis e busca por nome
- [x] Caixa de mensagem que cresce com o texto até 40% da janela
- [x] Menu "+" do chat: enviar qualquer arquivo (até 25 MB; só imagens são exibidas, o resto é
      oferecido para download), criar tópico e criar enquete
- [x] Tópicos: conversas à parte penduradas num canal de texto, com as permissões dele
- [x] Enquetes: uma ou várias respostas, votos ao vivo
- [x] Sons ao começar e ao parar de assistir a uma transmissão
- [x] Perfil: cartão com banner, cor, "sobre mim", status personalizado, cargos e data de entrada;
      presença escolhida (disponível, ausente, não perturbe, invisível); nome de exibição, apelido
      por servidor e troca de senha nas configurações. Sem e-mail: não há recuperação de senha.

**Único serviço externo.** A busca de GIF depende da GIPHY e por isso é opcional: sem a chave o
botão não aparece. Não é mídia nem tempo real, então não fere a regra de infraestrutura própria.
Imagens de links e GIFs são carregadas pelo navegador direto do site de origem (dá para desligar
em Configurações → Chat).

**Sem teste em aparelho real:** volume individual e janela flutuante no iPhone (o iOS não deixa
uma página ajustar o volume de um áudio, só silenciar), toque longo para abrir os menus, apertar
para falar com um jogo em primeiro plano (não funciona: o navegador só recebe teclas com a aba em
foco), notificações do sistema e a busca de GIF contra a GIPHY de verdade (os testes usam um
servidor falso).

**Sem teste em aparelho real:** RNNoise e câmera no iPhone, troca de microfone/saída/câmera com
dispositivos de verdade, os presets 1440p60 e original com um jogo, e a qualidade da supressão de
ruído (só dá para julgar de ouvido). Os testes e2e cobrem tudo isso com mídia sintética no Chromium.

## Pendências

O que depende do dono do projeto, e o que não pôde ser verificado no ambiente em que o projeto foi
desenvolvido (Windows, sem Docker, sem WSL2, sem segundo dispositivo).

### Depende de você

- **Deploy e demo pública.** Exige uma conta na Oracle Cloud (ou outra VPS), um IP público e um
  nome DNS (pode ser `sslip.io`). O passo a passo está em `docs/deploy.md`. O README diz
  explicitamente que ainda não há instância pública; quando houver, falta colocar o link na seção
  "Demo".
- **Nome.** O app se chama **Dispeaker** (decidido em 10/10/2026). Os pacotes, as chaves de
  armazenamento e os nomes dos serviços continuam `frequencia`, o título de trabalho; trocá-los
  não muda nada para quem usa.
- **Instalar o Docker Desktop** (precisa de administrador e reinicialização), se quiser usar
  `pnpm dev:docker` ou testar o stack de produção localmente.

### Escrito, mas não executado

- **Os stacks Docker.** O job `docker` do CI constrói as três imagens de produção, mas nenhum
  container delas foi iniciado: `docker-compose.yml` (dev), `docker-compose.prod.yml` e
  `deploy/Caddyfile` só tiveram os YAML validados sintaticamente. Pontos com mais chance de
  precisar de ajuste na primeira subida:
  - o estágio `prod-deps` dos Dockerfiles copia `node_modules` da raiz e do app preservando os
    links simbólicos do pnpm (a imagem constrói; falta ver o processo iniciar com eles);
  - a interpolação `${PRIVATE_IP:+...}` no compose;
  - os argumentos do coturn (`--external-ip`, `--allowed-peer-ip`).
- **O caminho TURN em produção.** As credenciais temporárias são geradas e testadas (o HMAC confere
  com o esquema do coturn), mas nenhuma chamada passou por um coturn de verdade. Em especial, o
  relay alcançar o SFU no mesmo host através do IP privado (NAT 1:1 da Oracle) é um desenho ainda
  não validado.
- **Postgres 17 e Redis 7 em produção.** O desenvolvimento local usa Postgres 18 e Memurai 8
  embutidos. Os testes passam no CI contra Postgres 17 e Redis 7, as versões de produção, mas o
  stack de produção em si ainda não rodou com elas.

### Verificado só com mídia sintética

Os testes e2e e de carga usam a câmera, o microfone e a captura de tela falsos do Chromium, em
contextos de navegador na mesma máquina. Isso prova que a mídia flui, que o servidor encaminha o
que deve e libera o que deve. Não prova:

- **Qualidade percebida:** eco, ruído, volume, sincronia, nitidez de texto numa transmissão.
- **Redes reais:** NAT, perda de pacotes, Wi-Fi, 4G. A reconexão é testada cortando o socket, não
  degradando a rede.
- **Áudio do sistema na transmissão:** depende do navegador e do sistema (Chrome no Windows entrega
  para tela inteira e abas; Firefox e Safari não). A UI avisa quando a transmissão sai sem áudio.
- **O preset 1080p60** com conteúdo de verdade (um jogo). A captura sintética produz 20 fps.
- **Outros navegadores.** Os testes automatizados só exercitam o Chromium.

**Teste manual com dois dispositivos (10/10/2026).** PC com Chrome no Windows e um iPhone com
Chrome (que no iOS usa o motor WebKit, o mesmo do Safari), na mesma rede local, com
`DEV_HTTPS=1 pnpm dev` e `https://<ip-da-máquina>:5173` (microfone e tela só funcionam em contexto
seguro). Aprovados pelo dono do projeto: voz nos dois sentidos, indicador de fala, mutar e
ensurdecer, transmissão de tela do PC assistida no iPhone, áudio da transmissão e reconexão após
desligar e religar o Wi-Fi do celular. Continua sem teste: redes fora da LAN (4G, NAT, perda de
pacotes), o preset 1080p60 com um jogo, Firefox e Safari no desktop.

### Limitações conhecidas

- **Resume do gateway entre instâncias.** Eventos, presença e estado de voz atravessam instâncias
  da API pelo Redis (testado com duas). O buffer de replay do `resume` fica na memória da instância
  que atendia o socket; em outra instância o cliente recebe `INVALID_SESSION` e refaz o `identify`
  (sem inconsistência, só um resync). Ver `docs/adr/0006-gateway-resume.md`.
- **Revalidação de permissões durante a chamada** depende do elo API → mídia estar de pé no
  momento da mudança; se não estiver, vale na próxima entrada no canal.
- **Limites medidos no teste de carga** (`docs/load-test.md`): a API satura perto de 170 req/s num
  processo; um servidor com ~1.000 pessoas entrando ao mesmo tempo atrasa a entrega de eventos.
  Nada disso afeta o uso pretendido, e as correções estão descritas no documento.
- **Teste de carga na VM alvo.** Os números são de um Ryzen 7 5700G com o gerador na mesma máquina,
  não da VM ARM de 2 núcleos.
