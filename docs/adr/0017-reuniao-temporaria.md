# 0017 — Reunião temporária por link, só no Redis

- Status: aceita
- Data: 2026-10-16

## Contexto

O pessoal queria uma sala "como a do Meet": mais simples que um servidor, para chamar alguém de
fora sem convidar para nada. Pedidos: entra quem tem o link e é deixado entrar por quem já está
dentro; quem não tem conta entra só com um nome; câmera, compartilhar tela e um chat; a sala some
quando a chamada acaba, sem limite de tempo enquanto houver alguém nela.

## Decisão

- **Fora de qualquer servidor.** Uma reunião não é guild nem canal: não entra no modelo de
  permissões do ADR 0007. Há só dois papéis. Quem foi deixado entrar fala, liga a câmera,
  compartilha a tela, escreve no chat, deixa outros entrarem e ajusta o volume de cada pessoa
  para si. O anfitrião, além disso, muta alguém para todos (o token de voz passa a vir com
  `speak: false` e a pessoa é derrubada com "permissões mudaram", como no mute do servidor),
  tira alguém da reunião e encerra para todos. Ninguém age sobre o anfitrião.
- **Só no Redis.** `meeting:<id>` (anfitrião), `:participants`, `:waiting`, `:messages` (as
  últimas 200) e `:call` (quem está na chamada agora). Nada vai para o Postgres; encerrar é um
  `DEL` de tudo, e o chat some junto.
- **O link é a reunião:** id de 128 bits aleatórios em base64url (`/reuniao/<id>`). Saber o link
  só deixa pedir para entrar.
- **Chave por pessoa:** ao entrar, cada pessoa recebe `idDaPessoa.segredo` (o servidor guarda só o
  SHA-256 do segredo). O navegador a guarda no `sessionStorage` da aba — recarregar volta direto
  para dentro — e a manda no cabeçalho `x-meeting-key`. Quem está esperando recebe uma chave de
  pedido, que só serve para ouvir a resposta.
- **Sala de espera em tempo real:** um WebSocket por reunião (`/api/meetings/<id>/socket`) manda o
  estado a quem está dentro e a resposta a quem espera. Entre instâncias da API, as mudanças
  passam por Redis pub/sub (`frequencia:meetings`), como o gateway (ADR 0006). Fechar a página de
  espera tira a pessoa da fila.
- **A chamada é a sala `meet:<id>` do serviço de mídia**, com o mesmo token de voz do ADR 0004
  (`sub` = id da pessoa na reunião). Os eventos `voice-state` dessas salas vão para o serviço de
  reuniões em vez do espelho de voz dos servidores.
- **Quando some:** quando a chamada fica vazia por 2 minutos (folga para quem caiu e está
  voltando), ou quando o anfitrião encerra. Uma reunião criada e nunca usada também conta como
  vazia. Um sorted set `meetings:empty` guarda desde quando cada uma está vazia; a cada 10 s uma
  varredura encerra as vencidas (só a instância que consegue o `ZREM` encerra). Encerrar fecha a
  sala de mídia (`closeRoom`) e avisa todos os sockets.

## Consequências

- Nada a migrar nem a limpar no banco; reiniciar o Redis encerra todas as reuniões.
- Contas não ganham nada de especial além do nome: um usuário logado bate na porta como um
  convidado (e o anfitrião, de outro aparelho, entra direto).
- Limites: 25 pessoas dentro, 20 esperando; criar e pedir para entrar usam o limite de taxa de
  login.
- Abrimos mão de histórico, de reuniões agendadas e de reuniões recorrentes: se aparecerem, são
  outra coisa.
