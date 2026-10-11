# 0012 — App de desktop como uma janela Electron sobre o site

## Contexto

Transmitir um jogo pelo navegador chegava a quem assiste com cerca de 20 quadros por segundo. As
medições no servidor e no painel de quem transmitia mostraram que os quadros já faltavam na
captura (`FPS CAPTURADO` igual a `FPS ENVIADO`, sem limitação do codificador): com o jogo ocupando
a máquina, a aba do navegador não recebe tempo de processador para capturar a tela. Um site não
tem como mudar a prioridade do próprio processo, nem impedir o navegador de tratar uma janela
coberta como ociosa. Atalhos de teclado globais, pedidos antes, esbarram no mesmo limite.

## Decisão

`apps/desktop` é um app Electron que abre o site publicado (`DISPEAKER_URL`) numa janela própria.
Não há cópia da interface: o que o site ganha, o app ganha sem nova instalação.

O que o app acrescenta ao navegador:

- prioridade alta para os seus processos e nenhuma economia de energia em segundo plano
  (`src/performance.ts`);
- um seletor de tela próprio, porque o Electron não traz um (`src/picker`);
- o som do sistema sem o som da própria chamada (`loopback` com `restrictOwnAudio`), em qualquer
  tela ou janela.

Electron, e não Tauri: traz o próprio Chromium, então todos rodam a mesma versão do motor de
captura e de codificação, e as opções dele ficam sob nosso controle. O Tauri usa o WebView2 do
sistema, onde `getDisplayMedia` depende da versão instalada.

## Consequências

- O instalador tem cerca de 110 MB e não é assinado: o Windows mostra o aviso do SmartScreen.
- O app não se atualiza sozinho. Como a interface vem do site, só mudanças em `apps/desktop`
  pedem um instalador novo.
- A captura continua sendo a do Chromium. Se a prioridade não bastar, o passo seguinte é um
  módulo nativo de captura e codificação pela placa de vídeo, entregue ao SFU por um transporte
  próprio — trabalho bem maior, deixado para quando as medições pedirem.
- `pnpm install` baixa o binário do Electron (cerca de 100 MB). As imagens Docker instalam com
  `--filter` e não são afetadas.
