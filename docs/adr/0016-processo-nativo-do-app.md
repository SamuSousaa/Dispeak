# 0016 — Um processo nativo para o que o app pede ao Windows

- Status: aceita
- Data: 2026-10-15

## Contexto

O app de desktop pedia ao Windows várias coisas que o Node não alcança, cada uma de um jeito: a
janela em frente e o fim do estrangulamento de timers por scripts PowerShell abertos a cada
pedido; os contadores da placa de vídeo por um PowerShell em laço; monitores e o áudio do jogo
por um programa em C#. Abrir PowerShell custa centenas de milissegundos e uns 30 MB por vez, e
detectar jogos (o próximo pedido) precisaria de mais um.

## Decisão

Um programa em Rust, `dispeaker-host` (`apps/desktop/native/host`), roda a sessão inteira ao lado
do app e responde em linhas JSON pelo stdin/stdout: pedidos com id e respostas, e eventos enquanto
uma observação está ligada. Os schemas do protocolo estão em `packages/shared/src/native-host.ts`;
`apps/desktop/src/native-host.ts` sobe o processo no primeiro pedido, valida cada mensagem e o
reinicia (com as observações ligadas) se ele cair.

Nesta primeira etapa ele faz:

- a janela em frente, para o atalho de transmitir;
- o fim do estrangulamento de timers (com PowerShell de reserva se o programa faltar, porque é
  isso que mantém 60 fps atrás de um jogo);
- os contadores da placa por motor (PDH), a cada 2 s, só durante transmissões;
- os **jogos rodando**: os instalados pela Steam, Epic, Xbox e GOG (lidos dos manifestos e do
  registro), os que a pessoa adicionou e programas em tela cheia que não sejam navegador ou
  player. Pelo caminho do executável, com a menor permissão de leitura, que mesmo jogos com
  anti-cheat concedem.

Fica para a próxima etapa trazer para cá o que ainda está no programa em C# (monitores e áudio do
jogo).

## Consequências

- O instalador leva mais um executável (~470 KB), compilado pelo `scripts/build-native.mjs` junto
  com o motor de captura.
- Detecção pelo caminho não depende de lista externa (como a do Discord) nem de internet.
- O que a pessoa corrige ("não é um jogo", "é um jogo") fica nas preferências da conta.
