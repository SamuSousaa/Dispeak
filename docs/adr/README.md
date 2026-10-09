# Registros de decisão de arquitetura

Decisões que moldaram o projeto, cada uma com o contexto em que foi tomada, o que foi escolhido e
o que se abriu mão. São curtos de propósito.

| Nº                                          | Decisão                                                               |
| ------------------------------------------- | --------------------------------------------------------------------- |
| [0001](0001-sfu-com-mediasoup.md)           | SFU próprio com mediasoup, em vez de mesh ou serviço gerenciado       |
| [0002](0002-webrtc-server-porta-fixa.md)    | Uma porta RTC fixa por worker (`WebRtcServer`)                        |
| [0003](0003-rpc-interno-websocket.md)       | API e mídia conversam por RPC sobre WebSocket, não por Redis pub/sub  |
| [0004](0004-token-de-voz.md)                | Token de voz de curta duração; o navegador fala direto com a mídia    |
| [0005](0005-protocolo-rpc-tipado.md)        | Um protocolo RPC tipado com Zod para toda a sinalização               |
| [0006](0006-gateway-resume.md)              | Gateway com fan-out por Redis e `resume` local à instância            |
| [0007](0007-permissoes-e-guild-sync.md)     | Permissões em bitflags e `GUILD_SYNC` em vez de diffs de visibilidade |
| [0008](0008-sessao-jwt-refresh-rotativo.md) | JWT curto em memória e refresh token rotativo em cookie               |
| [0009](0009-uuidv7-e-cursor.md)             | UUIDv7 como id e como cursor de paginação                             |
| [0010](0010-infra-embutida-sem-docker.md)   | Postgres e Redis embutidos para desenvolver e testar sem Docker       |
