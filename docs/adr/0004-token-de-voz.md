# 0004 — Token de voz de curta duração

## Contexto

Entrar num canal de voz exige permissão, e permissões vivem na API (banco, cargos, sobrescritas).
A sinalização de mídia é intensa e sensível a latência; passá-la pela API como intermediária
dobraria os saltos e acoplaria os dois serviços.

## Decisão

O navegador fala **direto** com o serviço de mídia, apresentando um token que a API emite:

- `POST /channels/:id/voice-token` calcula as permissões efetivas e assina um JWT (HS256, segredo
  compartilhado com a mídia) com `sub`, nome de exibição, `room` (o id do canal) e duas
  capacidades: `speak` e `stream`.
- O token vale **60 segundos** e só é checado na abertura do WebSocket. Ele autoriza entrar, não
  permanecer.
- O serviço de mídia confia no token e impõe as capacidades: sem `speak` não se publica microfone,
  sem `stream` não se publica tela.

Para o que muda depois da entrada, a API guarda o que concedeu e, a cada alteração de permissões,
compara: quem perdeu `Connect` é desconectado (código 4003); quem teve `speak`/`stream` alterados
recebe o código 4006 e reentra sozinho com um token novo.

## Alternativas

- **Mídia consulta a API a cada operação.** Sempre atual, mas põe uma chamada de rede no caminho
  de cada `produce` e faz a mídia depender da API estar no ar.
- **Token de longa duração.** Simples, mas um token vazado ou uma permissão revogada continuariam
  valendo.
- **Sinalização através do gateway da API.** Um socket só no cliente, porém a API viraria gargalo
  e ponto único de falha da mídia.

## Consequências

- O serviço de mídia não tem banco nem noção de cargos; pode ser testado e operado isolado.
- Uma reconexão sempre busca um token novo, então sempre reflete as permissões atuais.
- A revogação durante a chamada depende do RPC interno ([0003](0003-rpc-interno-websocket.md)).
