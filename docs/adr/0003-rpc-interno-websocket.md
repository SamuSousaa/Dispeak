# 0003 — RPC interno por WebSocket entre API e mídia

## Contexto

A API e o serviço de mídia são processos separados e precisam conversar nos dois sentidos:

- mídia → API: quem entrou, saiu, mutou ou começou a transmitir em cada canal;
- API → mídia: expulsar alguém de um canal, fechar a sala de um canal excluído, ler estatísticas.

As opções consideradas foram Redis pub/sub (que o projeto já usa) e uma conexão direta.

## Decisão

Cada instância da API mantém **um WebSocket aberto para o serviço de mídia**
(`/media/internal`), autenticado no handshake com um segredo compartilhado
(`Authorization: Bearer`, comparado em tempo constante). Sobre ele roda o mesmo `RpcPeer` tipado da
sinalização ([0005](0005-protocolo-rpc-tipado.md)), com o contrato em
`packages/shared/src/internal.ts`.

O endpoint não é exposto pelo proxy reverso.

## Por que não Redis pub/sub

- **Requisição e resposta.** `disconnectUser` precisa confirmar quantas sessões derrubou, e
  `stats` precisa devolver dados. Pub/sub é só difusão; exigiria inventar correlação e timeouts
  por cima.
- **Detecção de falha.** Um socket que cai é um sinal imediato de que a mídia sumiu. Com pub/sub o
  silêncio é ambíguo, e mensagens publicadas sem assinante são perdidas sem aviso.
- **Reconciliação.** Ao reconectar, a API pede um `snapshot` e conserta seu espelho. Isso é uma
  chamada, não um evento.

## Consequências

- Com várias instâncias da API, todas recebem cada evento de voz. Cada evento tem um id único e só
  a instância que o reivindica no Redis (`SET NX`) o processa.
- Enquanto o elo está fora, a API responde 503 ao que depende dele e não consegue derrubar
  ninguém de um canal; a revalidação acontece na próxima entrada. O `/api/health` expõe o estado.
- Para vários nós de mídia faltaria um registro de qual nó hospeda qual canal. O protocolo já
  carrega um `nodeId`; o roteamento não foi implementado.
