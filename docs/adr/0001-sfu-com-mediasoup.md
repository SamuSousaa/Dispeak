# 0001 — SFU próprio com mediasoup

## Contexto

O app precisa de canais de voz com várias pessoas e de transmissão de tela para vários
espectadores. O projeto também é de portfólio, com uma regra explícita: a infraestrutura de mídia
e de tempo real é implementada aqui, sem LiveKit, Agora, Twilio, Daily, Firebase ou similares.

## Decisão

Um SFU (_Selective Forwarding Unit_) construído sobre a biblioteca **mediasoup**, rodando como
serviço próprio (`apps/media`). Cada canal de voz é um `Router`; cada participante tem um
transport de envio e um de recebimento.

O mediasoup entrega o plano de mídia (ICE, DTLS, SRTP, RTP, estimativa de banda, simulcast) em
workers C++. Tudo acima disso é do projeto: sinalização, salas, ciclo de vida, permissões,
reconexão, escolha de camadas, balanceamento entre workers.

## Alternativas

- **Mesh ponto a ponto.** Sem servidor de mídia, mas o upload de cada participante cresce com o
  número de pessoas e nada pode ser imposto pelo servidor. Serve para 1:1 (mantido em `/lab/p2p`),
  não para um canal com transmissão de tela.
- **MCU** (o servidor decodifica e mistura). Um stream por espectador, mas custa CPU de
  transcodificação e tira do cliente a escolha do que assistir.
- **Servidor pronto** (Janus, LiveKit auto-hospedado). Menos código, mas a sinalização e o modelo
  de salas viriam prontos — justamente o que o projeto quer demonstrar.
- **Implementar o plano de mídia do zero.** Fora de escala para um projeto de uma pessoa, e sem
  ganho: SRTP e controle de congestionamento não são onde está a decisão de produto.

## Consequências

- O limite de um canal é um núcleo de CPU (um router vive em um worker). Medido: 24 pessoas e 391
  consumers em 0,58 núcleo ([teste de carga](../load-test.md)).
- O mediasoup tem código nativo. Em desenvolvimento usa-se o worker pré-compilado; em Docker a
  imagem carrega o toolchain para as plataformas sem binário pronto.
- Vídeo em VP8 por padrão, para o simulcast se comportar igual em todos os navegadores. Desde
  2026-10 o router também aceita H.264 High, usado só em transmissões de tela e só quando o
  hardware de quem transmite codifica: em 1440p60 o VP8 por software fazia o navegador reduzir a
  imagem. Quem assiste num navegador sem decodificador H.264 High (Firefox) não recebe essas
  transmissões.
