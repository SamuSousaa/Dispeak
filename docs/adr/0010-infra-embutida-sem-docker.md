# 0010 — Postgres e Redis embutidos para desenvolver e testar sem Docker

## Contexto

A partir da etapa 4 nada roda sem PostgreSQL e Redis. O caminho padrão é o `docker-compose.yml`,
mas a máquina onde o projeto foi desenvolvido (Windows) não tinha Docker nem WSL2, e instalar
exigia privilégios de administrador. Além disso, quem clona um projeto de portfólio para dar uma
olhada tende a desistir no primeiro pré-requisito.

## Decisão

Docker é o caminho preferido quando existe; quando não existe, o projeto se vira:

- `pnpm dev` e `pnpm start:local` detectam o Docker. Sem ele, sobem um **PostgreSQL embutido**
  (`embedded-postgres`, binários reais, dados em `.dev/postgres`) e um **servidor Redis em
  processo filho** (`redis-memory-server`; no Windows, Memurai).
- Os testes de integração da API fazem o mesmo em portas aleatórias e diretório temporário, a
  menos que `TEST_DATABASE_URL`/`TEST_REDIS_URL` apontem para instâncias existentes — é o que o CI
  faz, com containers de serviço.
- O serviço de mídia roda nativo graças ao worker pré-compilado do mediasoup; `pnpm dev:docker`
  existe para as plataformas em que ele não serve.

Nenhum teste usa _mock_ de banco ou de Redis.

## Alternativas

- **Exigir Docker.** Teria bloqueado o desenvolvimento desta base e criado uma barreira de entrada.
- **SQLite ou banco em memória nos testes.** Divergiria do Postgres justamente onde importa
  (arrays, `ON CONFLICT`, tipos, concorrência em convites).
- **Mocks.** Testariam o código contra a ideia que ele faz do banco.

## Consequências

- `pnpm install && pnpm dev` funciona numa máquina só com Node.
- Desenvolvimento local (Postgres 18, Memurai) e CI/produção (Postgres 17, Redis 7) usam versões
  diferentes. O SQL usado é conservador e as migrations são as mesmas, mas é uma diferença real.
- Um `pnpm dev` encerrado à força pode deixar processos órfãos do Postgres segurando a porta; o
  script de infraestrutura detecta e limpa isso na subida seguinte.
- Os arquivos Docker não puderam ser executados nesta máquina; o CI constrói as imagens.
