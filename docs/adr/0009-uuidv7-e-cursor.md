# 0009 — UUIDv7 como id e como cursor de paginação

## Contexto

O histórico de mensagens precisa de paginação que não repita nem pule itens enquanto mensagens
novas chegam, o que descarta `OFFSET`. Os ids também aparecem em URLs e eventos, então não devem
revelar contagens.

## Decisão

Todos os ids são **UUID versão 7**, gerados na aplicação: 48 bits de timestamp em milissegundos
seguidos de bits aleatórios. Ordenar por id é ordenar por criação.

O histórico usa o próprio id como cursor: `GET /channels/:id/messages?before=<id>&limit=50`
executa `WHERE channel_id = $1 AND id < $2 ORDER BY id DESC LIMIT 51` sobre o índice
`(channel_id, id DESC)`. A linha extra diz se existe página anterior; `nextCursor` é o id mais
antigo da página devolvida.

## Alternativas

- **Snowflakes** (como no Discord). Mesma propriedade em 64 bits, mas exigem coordenação de ids de
  nó entre instâncias.
- **UUIDv4 + `created_at` como cursor.** Precisa de cursor composto para desempatar timestamps
  iguais e de um índice a mais.
- **`OFFSET`/`LIMIT`.** Custo linear na profundidade e resultados instáveis com inserções.

## Consequências

- Uma página de histórico é uma varredura de faixa em um índice, qualquer que seja a profundidade.
- Inserções ficam concentradas no fim do índice, o que mantém as páginas do B-tree densas.
- Duas mensagens criadas no mesmo milissegundo são ordenadas pelos bits aleatórios: a ordem é
  estável, mas dentro do mesmo milissegundo não reflete a ordem de chegada.
- O id revela o instante de criação. Aceitável: mensagens já exibem o horário.
