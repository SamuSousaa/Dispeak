# 0015 — Conversa privada separada da amizade

- Status: aceita (substitui a parte de "ser amigo é ter a guild" do ADR 0011)
- Data: 2026-10-15

## Contexto

Pelo ADR 0011, ser amigo **era** ter a guild `dm` do par. Isso deixava de fora o que o Discord
faz e o pessoal pediu: mandar mensagem para alguém visto num servidor, direto do cartão de perfil,
sem pedir amizade antes. Também apagava o histórico ao desfazer a amizade, e não havia como
bloquear ninguém.

## Decisão

A conversa continua sendo uma guild `dm` (o ADR 0011 vale para tudo o mais: mensagens, chamadas,
transmissões e presença vêm de graça). O que muda é o que ela significa:

- **Amizade** é uma tabela própria (`friendships`, o par com o menor id primeiro). Aceitar um
  pedido cria a linha e reaproveita a conversa que o par já tiver, ou cria uma. Desfazer apaga só
  a linha: a conversa e o histórico ficam.
- **Quem pode começar uma conversa:** amigos, ou quem divide um servidor com a pessoa, a menos que
  ela tenha ligado o **perfil privado** (`privateProfile` nas preferências da conta, ADR 0014).
  Caso contrário, `403 dm_closed`.
- **Pedido de mensagem:** a conversa iniciada por quem não é amigo nasce com uma linha em
  `dm_requests`. O destinatário não vê nada até a primeira mensagem (`sent`); depois ela aparece em
  "Pedidos de mensagem", sem contar como menção. Responder ou aceitar apaga a linha; recusar marca
  `declined` e esconde a conversa só para ele — quem enviou não é avisado. Abrir a conversa por
  conta própria também aceita.
- **Bloqueio** (`user_blocks`): termina a amizade e os pedidos de amizade entre os dois, recusa
  novos (`403 blocked`), fecha a conversa nos dois sentidos e derruba uma chamada em andamento. No
  cliente, as mensagens de quem você bloqueou nos servidores ficam dobradas, com "mostrar".

As regras de envio e de chamada não estão nas rotas: o snapshot de uma guild `dm` carrega a
amizade, o pedido e os bloqueios, e `actorOf` tira as permissões que não valem — com bloqueio,
enviar, anexar, reagir, conectar, falar e transmitir; com pedido pendente, conectar, falar e
transmitir. Toda checagem que já existia (mensagens, reações, token de voz, `voice.enforce`) passa
a respeitar isso sem código novo, como manda o ADR 0007.

O payload da guild ganha `dm: { friend, request, blocked }` do ponto de vista de quem lê.

## Consequências

- Uma migração copia para `friendships` todas as conversas que já existiam (todas eram amizades).
- `blocked: 'other'` revela que a outra pessoa bloqueou — o mesmo que o Discord deixa perceber ao
  recusar a mensagem; o cliente diz apenas que não é possível enviar.
- Conversas recusadas ou nunca começadas continuam no banco; somem com a conta de um dos dois.
- Grupos privados continuam cabendo no modelo (mais membros na guild), ainda sem pedidos para eles.
