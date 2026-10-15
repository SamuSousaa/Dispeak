# 0011 — Conversa privada como uma guild oculta

n- Status: em parte substituída pelo [0015](0015-conversa-separada-da-amizade.md): amizade e conversa agora são coisas separadas.

## Contexto

Mensagens, anexos, reações, não lidas, presença, chamadas e transmissões foram escritos em torno
de uma guild: toda permissão é calculada a partir de um snapshot dela, e o gateway entrega eventos
por guild. Uma conversa privada entre dois amigos precisa de tudo isso.

## Decisão

Uma conversa privada é uma guild de `kind = 'dm'`, criada quando um pedido de amizade é aceito,
com os dois membros, um canal de texto e um de voz. Ser amigo **é** ter essa guild: não existe uma
tabela de amizades para manter em sincronia. `guilds.dm_key` (os dois ids em ordem) garante uma por
par. Só os pedidos ainda sem resposta têm tabela própria (`friend_requests`).

O que a diferencia de um servidor:

- ninguém é dono (`actorOf` ignora `ownerId` em guilds `dm`) e `@everyone` recebe apenas
  `DM_PERMISSIONS` — conversar, ligar e transmitir. Renomear, convidar, criar canal, expulsar e
  apagar caem nas checagens de permissão que já existiam, sem regra nova em cada rota;
- não pode ser abandonada: acaba para os dois ao desfazer a amizade, e o histórico vai junto;
- não aparece em `GET /guilds` nem na barra de servidores; o cliente a mostra em "Mensagens
  diretas", com o nome da outra pessoa.

## Consequências

- Chamada e transmissão dentro da conversa vieram sem código novo no servidor de mídia.
- Desfazer a amizade apaga as mensagens. Guardar o histórico exigiria separar "amizade" de
  "conversa", o que esta decisão evita de propósito.
- Grupos privados cabem no mesmo modelo (mais membros na mesma guild), mas ainda não existem.
- Quem lista guilds no banco precisa lembrar do `kind`.
