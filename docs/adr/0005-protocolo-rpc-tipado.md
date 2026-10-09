# 0005 — Um protocolo RPC tipado para toda a sinalização

## Contexto

O projeto tem três conversas por WebSocket com a mesma forma — pedidos com resposta e eventos
soltos, nos dois sentidos: a sinalização da chamada P2P, a sinalização de voz com o SFU e o RPC
entre API e mídia. A primeira foi escrita na etapa 1 com o requisito de ser reaproveitada.

## Decisão

`packages/shared/src/rpc` define:

- um envelope de três frames (`req`, `res`, `evt`);
- `defineSide`, que declara o que um lado aceita: requisições (schema de entrada e de saída) e
  eventos;
- `RpcPeer<Local, Remote>`, independente de transporte: recebe texto por `receive()`, escreve por
  uma função `send`. Valida com Zod **tudo o que entra e tudo o que volta**, casa respostas por id,
  aplica timeout e rejeita as pendências quando a conexão fecha.

Os tipos de `request()`, `notify()`, `handle()` e `on()` são inferidos dos schemas. Um handler que
devolve o formato errado não compila; um cliente antigo que envia um payload inválido recebe
`invalid_payload` sem que o handler seja chamado.

Erros de domínio são `RpcError(code)` e chegam ao outro lado com o código; qualquer outra exceção
vira `internal_error`, sem vazar detalhes.

## Alternativas

- **Socket.IO ou tRPC.** Resolvem o transporte, mas trazem formato de fio e runtime próprios; o
  objetivo era ter o protocolo à vista.
- **Mensagens ad hoc por canal.** Foi como a etapa 1 poderia ter começado; cada canal novo
  repetiria correlação, timeout e validação.

## Consequências

- O gateway **não** usa este protocolo: ele precisa de sequência e retomada, não de
  requisição/resposta, e segue o formato `{ op, d, s, t }` ([0006](0006-gateway-resume.md)).
- Os schemas dos parâmetros do mediasoup são frouxos de propósito (limitam tamanho e formato
  geral); a validação fina é do próprio mediasoup, cujos `TypeError` são convertidos em
  `invalid_payload`.
