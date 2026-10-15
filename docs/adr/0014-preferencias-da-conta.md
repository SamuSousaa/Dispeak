# 0014 — Preferências da conta separadas das do aparelho

- Status: aceita
- Data: 2026-10-15

## Contexto

Todas as preferências moravam no `localStorage` (`frequencia.settings`). Duas consequências
incomodavam:

- o volume e o mudo de uma transmissão eram guardados pelo id da **sessão** do transmissor e só
  na memória: quem mutava a transmissão de um amigo precisava mutar de novo cada vez que ele
  voltava a transmitir;
- o volume de cada pessoa valia só naquele aparelho. No Discord, quem você silenciou continua
  silenciado em qualquer servidor e em qualquer computador.

Ao mesmo tempo, várias preferências **são** do aparelho e não fazem sentido em outro: microfone,
alto-falante, câmera, ganho, captura nativa do app, atalhos de teclado.

## Decisão

Dois lugares, com uma regra para escolher entre eles:

- **Conta** (`user_settings` no Postgres, um JSONB por usuário, schema `userSettingsSchema` em
  `packages/shared`): o que diz respeito a outras pessoas ou ao conteúdo — volume e mudo da voz e
  da transmissão de cada pessoa (por id de **usuário**) e as prévias de links. Chega pelo gateway
  no `READY` e em `USER_SETTINGS_UPDATE` depois de cada mudança, para todas as sessões do usuário.
  Muda por `PATCH /users/@me/settings`.
- **Aparelho** (`localStorage`): dispositivos, processamento do microfone, captura, atalhos e o
  próprio mudo/surdo, que volta como estava na chamada seguinte.

Detalhes que valem para quem mexer nisso:

- O `PATCH` é parcial e mescla pessoa por pessoa, campo por campo; `null` esquece a pessoa. A
  mesma função (`applyUserSettingsPatch`) roda no servidor, que guarda o resultado, e no cliente,
  que mostra a mudança antes da resposta. Valores iguais ao padrão não são guardados.
- O servidor lê, mescla e grava sob `SELECT … FOR UPDATE`: dois aparelhos mudando pessoas
  diferentes ao mesmo tempo mantêm as duas mudanças.
- O cliente agrupa mudanças seguidas (um controle deslizante sendo arrastado) num pedido só,
  400 ms depois da última. Mudanças não confirmadas ficam por cima do que o servidor mandar.
- Mutar guarda o volume: desmutar volta ao volume escolhido, não a 100%.
- Dados antigos são lidos campo a campo; o que não valida volta ao padrão em vez de derrubar a
  sessão. Os volumes que estavam no `localStorage` (versão 6) passam para a conta na primeira
  sessão, sem substituir o que a conta já tem.

## Consequências

- Mais um evento no gateway e uma tabela; o `READY` carrega as preferências, sem pedido extra.
- Preferências novas precisam escolher um dos dois lugares; na dúvida, a pergunta é "isso faria
  sentido em outro computador?".
- A tela de configurações deve deixar claro o que acompanha a conta e o que é só deste aparelho.
