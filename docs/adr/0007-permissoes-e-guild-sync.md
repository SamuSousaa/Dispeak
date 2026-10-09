# 0007 — Permissões em bitflags e `GUILD_SYNC`

## Contexto

O modelo é o do Discord: cargos com permissões, hierarquia entre cargos e sobrescritas por canal
para cargos e membros. Duas dificuldades: calcular isso de forma idêntica no servidor e no
cliente, e manter o cliente correto quando uma mudança de permissão altera **o que cada pessoa
consegue ver**.

## Decisão

**Cálculo.** Permissões são bitflags (`bigint`, serializadas como string decimal). As funções
puras de `packages/shared/src/permissions.ts` são usadas pelos dois lados: a API para decidir, o
cliente para esconder o que não adianta mostrar. A ordem de aplicação é fixa — base dos cargos,
sobrescritas da categoria, sobrescritas do canal; em cada camada `@everyone`, cargos, membro — e
está coberta por testes unitários.

**Hierarquia.** Só se edita ou atribui cargo abaixo do próprio cargo mais alto; só se age sobre
membros de cargo inferior; ninguém concede (nem em sobrescrita) uma permissão que não possui. O
dono ignora a hierarquia; administradores não.

**Invisível é inexistente.** Canais sem `ViewChannel` não vão no payload do servidor, não geram
eventos para aquela pessoa, e a API responde 404 a operações sobre eles.

**Sincronização.** Eventos incrementais (`CHANNEL_CREATE`, `MEMBER_ADD`, mensagens…) cobrem o
caso comum. Qualquer mudança que possa alterar visibilidade — cargo criado, editado, reordenado ou
excluído, cargos de um membro, sobrescritas, canal movido de categoria — dispara um `GUILD_SYNC`:
cada membro conectado recebe o servidor inteiro como passa a enxergá-lo, e o cliente substitui o
estado.

## Alternativa descartada

Calcular, para cada membro, a diferença de visibilidade e emitir `CHANNEL_CREATE`/`CHANNEL_DELETE`
sintéticos. É o caminho mais econômico em bytes e o mais fácil de errar: basta esquecer um caso
para um cliente continuar vendo um canal que não deveria.

## Consequências

- Mudar permissões custa um payload completo por membro conectado. Com servidores de amigos é
  irrelevante; com milhares de membros conectados seria o primeiro ponto a otimizar.
- Sobrescritas de categoria são herdadas em camadas (categoria, depois canal), em vez do modelo
  de "sincronizar com a categoria" do Discord. Mais simples de explicar e de testar.
- Perder acesso durante uma chamada tem efeito imediato ([0004](0004-token-de-voz.md)).
