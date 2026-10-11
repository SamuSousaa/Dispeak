# 0012 — App de desktop como uma janela Electron sobre o site

## Contexto

Transmitir um jogo pelo navegador chegava a quem assiste com 20 a 35 quadros por segundo, e os
quadros já faltavam na captura. A causa, medida numa das máquinas afetadas: o Windows 11 deixa de
honrar os temporizadores finos de um processo cujas janelas estão todas cobertas e passa a
acordá-lo no tique padrão de 15,6 ms. O capturador de tela do Chromium se cadencia por esses
temporizadores, então atrás de um jogo em tela cheia cada quadro espera um número inteiro de
tiques: 32 quadros por segundo onde se pediram 60, 21 onde uma captura demora um pouco mais. Com
o processo dispensado dessa regra, a mesma captura foi de 35 para 55 quadros por segundo.

Um site não tem como pedir essa dispensa. Atalhos de teclado globais, pedidos antes, esbarram no
mesmo limite do navegador.

## Decisão

`apps/desktop` é um app Electron que abre o site publicado (`DISPEAKER_URL`) numa janela própria.
Não há cópia da interface: o que o site ganha, o app ganha sem nova instalação.

O que o app acrescenta ao navegador:

- a dispensa do estrangulamento de temporizadores e do modo de eficiência do Windows para os seus
  processos, e nenhuma economia de energia do Chromium em segundo plano (`src/performance.ts`,
  `src/windows-scheduling.ts`);
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
- A captura continua sendo a do Chromium. Prioridade alta de processador e classe de agendamento
  da placa de vídeo foram testadas antes e não mudaram as medições; não são aplicadas.
- A dispensa é pedida por um script PowerShell passado na linha de comando, porque a chamada
  (`SetProcessInformation`) não tem equivalente no Node. Um módulo nativo a substituiria.
- `pnpm install` baixa o binário do Electron (cerca de 100 MB). As imagens Docker instalam com
  `--filter` e não são afetadas.
