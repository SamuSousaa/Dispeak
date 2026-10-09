# Retomada

Ponto em que o trabalho parou, em 09/10/2026. Nada do que está em "O que depende de você" foi
feito ainda. A lista detalhada de pendências está em `ROADMAP.md`, seção "Pendências".

## Estado

O projeto está implementado nas seis etapas (0 a 5), em 10 commits na branch `main`, sem remoto
configurado. Um critério de aceite ficou aberto: **nada de Docker foi executado**. Esta máquina não
tem Docker nem WSL2, e instalar exige administrador e reinicialização.

Para ver funcionando:

```bash
pnpm install
pnpm dev        # http://localhost:5173, em duas janelas (uma anônima)
```

## O que foi verificado

- **Testes:** 264 unitários/de integração e 8 e2e no Playwright passam. Os de integração usam
  Postgres, Redis e workers mediasoup reais, sem mocks.
- **Aceites das etapas 1 a 4:** cada um tem teste automático — duas abas se vendo e ouvindo, 4 abas
  no canal com indicador de fala, liberação de recursos conferida no próprio worker, espectador
  recebendo só o vídeo que escolheu, e o fluxo conta → servidor → convite → voz → transmissão com
  permissões retiradas no meio da chamada.
- **Builds de produção:** rodam localmente com `pnpm build && pnpm start:local`, e os 8 e2e passam
  contra eles. Essa verificação pegou um bug real: o `ws` estava sendo empacotado e quebrava o
  bundle da API.
- **Teste de carga**, medido nesses builds, com o gerador na mesma máquina (Ryzen 7 5700G):

| Cenário                                | Resultado                                         |
| -------------------------------------- | ------------------------------------------------- |
| API, 200 usuários virtuais (168 req/s) | p95 de 34 ms, 0% de erros                         |
| API, 500 usuários virtuais             | satura: 161 req/s, p95 de 3,4 s                   |
| Gateway, 500 conexões num servidor     | entrega com p95 de 26 ms                          |
| Voz + tela 1080p, 24 pessoas           | 391 consumers, worker do mediasoup em 0,58 núcleo |

O teste de voz também achou um defeito: se a captura do áudio do sistema falhava, a transmissão
inteira abortava. Agora ela segue só com vídeo e a UI avisa.

## O que não foi verificado

- **Docker e produção:** os dois compose, os três Dockerfiles, o Caddyfile e o coturn foram
  escritos e só tiveram os YAML conferidos num parser. Por isso "sobe em produção com um comando"
  está desmarcado no `ROADMAP.md`.
- **CI:** não há remoto nem `gh`, então nenhum dos três jobs (`check`, `e2e`, `docker`) rodou. O
  primeiro push será também o primeiro teste dos Dockerfiles.
- **Mídia real:** tudo usou câmera, microfone e tela sintéticos do Chromium na mesma máquina.
  Qualidade de áudio, redes reais, dois dispositivos, 1080p60 com um jogo e outros navegadores
  ficaram sem validação.
- **Demo:** o README diz que ainda não há instância pública; inclui duas capturas de tela reais do
  app.

## Decisões tomadas sem consulta (revisar se quiser mudar)

- **Sem Docker, `pnpm dev` e os testes sobem Postgres e Redis embutidos.** O mediasoup roda nativo
  no Windows com o worker pré-compilado; `pnpm dev:docker` existe, mas não foi testado.
- **O `/lab/voice` por apelido continua existindo**, desligado em produção por `LAB_ENABLED`. Foi
  mantido porque os e2e das etapas 2 e 3 testam a mídia isolada por ele; o app principal usa só
  autenticação.
- **TypeScript está fixado em 6.0**, porque o `typescript-eslint` ainda não aceita o 7.
- **Docs do repositório em português, `CLAUDE.md` em inglês.**

## O que depende de você (nada feito ainda)

1. Criar o repositório no GitHub e dar push. Acompanhar a primeira execução do CI: é o primeiro
   teste real dos Dockerfiles.
2. Fazer o deploy seguindo `docs/deploy.md` (VM, IP público e um nome DNS; `sslip.io` serve).
   Depois, colocar o link na seção "Demo" do README.
3. Decidir a licença: nenhuma foi adicionada, então hoje o código é "todos os direitos reservados".
4. Testar com amigos e dispositivos de verdade (em LAN: `DEV_HTTPS=1 pnpm dev` e abrir
   `https://<ip-da-máquina>:5173`).
5. Opcional: instalar o Docker Desktop para testar `pnpm dev:docker` e o stack de produção
   localmente.
6. O nome "Frequência" continua provisório.

## Por onde continuar na próxima sessão

Sugestão de ordem: (1) push e CI, corrigindo o que o job `docker` acusar; (2) deploy na VM e
validação do caminho TURN; (3) teste manual com dois dispositivos; (4) repetir o teste de carga na
VM e atualizar `docs/load-test.md`.

## Onde está cada coisa

| Arquivo                | Conteúdo                                             |
| ---------------------- | ---------------------------------------------------- |
| `README.md`            | Visão geral, arquitetura, como rodar, resultados     |
| `ROADMAP.md`           | Etapas, critérios de aceite e pendências detalhadas  |
| `CLAUDE.md`            | Convenções, comandos e notas de ambiente             |
| `docs/architecture.md` | Como os serviços se encaixam                         |
| `docs/deploy.md`       | Passo a passo para a Oracle Cloud, portas e firewall |
| `docs/load-test.md`    | Metodologia e números do teste de carga              |
| `docs/adr/`            | Dez decisões de arquitetura                          |
