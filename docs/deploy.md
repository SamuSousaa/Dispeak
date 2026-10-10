# Deploy

Guia para subir o Frequência numa VM ARM do **Oracle Cloud Always Free** com Ubuntu. Serve, com
poucas mudanças, para qualquer VPS Linux com IP público.

> **Estado deste guia.** Os arquivos de produção (`docker-compose.prod.yml`, Dockerfiles,
> `deploy/Caddyfile`) foram escritos e revisados, e o job `docker` do CI constrói as imagens, mas o
> stack ainda não foi executado numa VM real. Os bundles de produção em si foram validados
> localmente com `pnpm start:local` (os testes e2e passam contra eles). Trate a primeira subida como
> um teste e confira a seção [Verificação](#6-verificação).

## Visão geral

Um único host roda seis containers:

| Container  | Função                                             | Rede            |
| ---------- | -------------------------------------------------- | --------------- |
| `caddy`    | HTTPS (Let's Encrypt), app estático, proxy reverso | bridge, 80/443  |
| `api`      | REST + gateway                                     | bridge, interna |
| `media`    | SFU mediasoup                                      | bridge, 40000+  |
| `postgres` | Dados                                              | bridge, interna |
| `redis`    | Presença, pub/sub, rate limit                      | bridge, interna |
| `coturn`   | STUN/TURN                                          | host            |

Só `caddy`, `media` (portas RTC) e `coturn` são alcançáveis de fora. A API, o Postgres, o Redis, o
RPC interno (`/media/internal`) e as métricas ficam na rede interna do Docker.

## 1. Criar a VM

No console da Oracle Cloud:

- **Shape:** `VM.Standard.A1.Flex` (Ampere ARM). Desde junho de 2026 o nível gratuito cobre até
  2 OCPUs e 12 GB no total; use os 2 OCPUs — o mediasoup usa um worker por núcleo.
- **Imagem:** Ubuntu 24.04 (aarch64).
- **Rede:** VCN com sub-rede pública e IPv4 público. Reserve o IP (Networking → Reserved Public IPs)
  para ele não mudar se a instância for recriada.
- Adicione sua chave SSH.

Anote o **IP público** e, depois de entrar na máquina, o **IP privado**:

```bash
ssh ubuntu@<ip-público>
hostname -I | awk '{print $1}'   # IP privado, algo como 10.0.0.x
```

Na Oracle a VM não tem o IP público na interface: ele é um NAT 1:1 para o IP privado. Por isso os
dois entram na configuração.

## 2. DNS

O Caddy precisa de um nome que resolva para o IP público para obter o certificado.

- Com domínio próprio: crie um registro `A` (por exemplo `voz.seudominio.com`) apontando para o IP.
- Sem domínio: use [sslip.io](https://sslip.io), que resolve `203-0-113-10.sslip.io` para
  `203.0.113.10` e funciona com Let's Encrypt.

## 3. Portas

São dois firewalls, e os dois precisam ser abertos.

| Porta       | Protocolo | Para quê                                                 |
| ----------- | --------- | -------------------------------------------------------- |
| 22          | TCP       | SSH                                                      |
| 80          | TCP       | Desafio do Let's Encrypt e redirecionamento para HTTPS   |
| 443         | TCP       | App, API, gateway e sinalização (HTTPS/WSS)              |
| 443         | UDP       | HTTP/3 (opcional)                                        |
| 40000–40015 | UDP       | Mídia do mediasoup (caminho normal)                      |
| 40000–40015 | TCP       | Mídia do mediasoup quando a rede do cliente bloqueia UDP |
| 3478        | UDP e TCP | STUN/TURN (coturn)                                       |
| 49160–49200 | UDP       | Faixa de relay do TURN                                   |

A faixa do mediasoup é pequena porque cada worker usa uma porta fixa por endereço anunciado
(`WebRtcServer`): 2 workers × 2 endereços = 4 portas; 16 dão folga.

### 3.1 Firewall da Oracle (Security List)

Networking → Virtual Cloud Networks → sua VCN → Security Lists → Default Security List → **Add
Ingress Rules**. Uma regra por linha da tabela acima, com _Source CIDR_ `0.0.0.0/0`:

| IP Protocol | Destination Port Range |
| ----------- | ---------------------- |
| TCP         | 80                     |
| TCP         | 443                    |
| UDP         | 443                    |
| UDP         | 40000-40015            |
| TCP         | 40000-40015            |
| UDP         | 3478                   |
| TCP         | 3478                   |
| UDP         | 49160-49200            |

(A regra do SSH, porta 22, já vem criada.)

### 3.2 Firewall do sistema (iptables)

As imagens Ubuntu da Oracle vêm com regras de `iptables` que rejeitam tudo menos SSH. Não use
`ufw` nelas: ele entra em conflito com essas regras. Insira as liberações antes da regra `REJECT`
e persista:

```bash
# Posição da regra REJECT na cadeia INPUT.
LINE=$(sudo iptables -L INPUT --line-numbers | awk '/REJECT/ {print $1; exit}')

for rule in \
  "tcp 80" "tcp 443" "udp 443" \
  "udp 40000:40015" "tcp 40000:40015" \
  "udp 3478" "tcp 3478" \
  "udp 49160:49200"; do
  set -- $rule
  sudo iptables -I INPUT "$LINE" -p "$1" --dport "$2" -j ACCEPT
done

sudo netfilter-persistent save
sudo iptables -L INPUT -n --line-numbers   # confira: os ACCEPT acima do REJECT
```

As portas publicadas pelo Docker (80, 443 e 40000–40015) passam pela cadeia `FORWARD`, que o
próprio Docker gerencia; as regras em `INPUT` são o que libera o coturn, que usa a rede do host.
Liberar tudo nas duas evita depender desse detalhe.

Em outros provedores, com `ufw`:

```bash
sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443
sudo ufw allow 40000:40015/udp && sudo ufw allow 40000:40015/tcp
sudo ufw allow 3478 && sudo ufw allow 49160:49200/udp
sudo ufw enable
```

## 4. Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
exit   # entre de novo por SSH para o grupo valer
```

## 5. Configurar e subir

```bash
git clone https://github.com/SamuSousaa/Dispeak.git frequencia
cd frequencia
cp .env.prod.example .env.prod
nano .env.prod
```

### Variáveis de ambiente

| Variável              | Valor                                                                    |
| --------------------- | ------------------------------------------------------------------------ |
| `DOMAIN`              | Nome do passo 2, sem `https://`                                          |
| `ACME_EMAIL`          | Seu e-mail (avisos de expiração do Let's Encrypt)                        |
| `PUBLIC_IP`           | IP público da VM                                                         |
| `PRIVATE_IP`          | IP privado (`hostname -I`). Vazio se a máquina tiver o IP público direto |
| `POSTGRES_PASSWORD`   | `openssl rand -hex 32`                                                   |
| `JWT_SECRET`          | `openssl rand -hex 32` — assina os access tokens                         |
| `MEDIA_SHARED_SECRET` | `openssl rand -hex 32` — tokens de voz e RPC interno API ↔ mídia         |
| `TURN_SECRET`         | `openssl rand -hex 32` — credenciais temporárias do coturn               |
| `METRICS_TOKEN`       | Opcional. Se definido, `/metrics` exige `Authorization: Bearer`          |
| `MEDIA_NUM_WORKERS`   | Número de núcleos da VM (2)                                              |

Para gerar os quatro segredos de uma vez:

```bash
for name in POSTGRES_PASSWORD JWT_SECRET MEDIA_SHARED_SECRET TURN_SECRET; do
  sed -i "s/^$name=.*/$name=$(openssl rand -hex 32)/" .env.prod
done
```

O `docker-compose.prod.yml` deriva o resto: `DATABASE_URL`, `CORS_ORIGINS`, as URLs do TURN, os
endereços anunciados pelo mediasoup. A lista completa do que cada serviço aceita, com os padrões,
está em `apps/api/.env.example` e `apps/media/.env.example`.

### Subir

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
```

O primeiro build leva alguns minutos. Em ARM o mediasoup normalmente baixa um worker pré-compilado;
se não houver um para a plataforma, ele é compilado dentro da imagem (o toolchain já está lá), o
que acrescenta de 5 a 10 minutos. As migrations do banco rodam sozinhas quando a API inicia.

## 6. Verificação

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod ps    # todos "healthy"/"running"
curl -s https://$DOMAIN/api/health      # {"status":"ok","service":"api",...,"media":true}
curl -s https://$DOMAIN/media/health    # {"status":"ok","service":"media","workers":2}
curl -s -o /dev/null -w '%{http_code}\n' https://$DOMAIN/media/stats   # 404: não é público
```

`"media": true` no health da API confirma que o RPC interno conectou.

Depois, no navegador:

1. Crie duas contas (uma em janela anônima ou, melhor, em outro dispositivo fora da sua rede).
2. Crie um servidor, convide a segunda conta, entrem no canal de voz.
3. A barra inferior deve mostrar `MÍDIA CONECTADO`, RTT e bitrate. Transmita a tela de um lado e
   assista do outro.

Para testar o TURN isoladamente, use a página
[Trickle ICE](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/) com as
credenciais que a API entrega (aba Rede do navegador, resposta de `voice-token`, campo
`iceServers`): deve aparecer um candidato do tipo `relay`.

Documentação da API: `https://$DOMAIN/docs`.

## 7. Operação

```bash
# Logs
docker compose -f docker-compose.prod.yml --env-file .env.prod logs -f --tail 100 api media

# Atualizar para a versão mais recente
git pull
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build

# Backup do banco
docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T postgres \
  pg_dump -U frequencia frequencia | gzip > backup-$(date +%F).sql.gz

# Backup das imagens do chat (volume uploads-data)
docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T api \
  tar -czf - -C /data uploads > uploads-$(date +%F).tar.gz

# Parar (os volumes ficam)
docker compose -f docker-compose.prod.yml --env-file .env.prod down
```

Reiniciar o container `media` derruba as chamadas em andamento; os clientes reconectam sozinhos em
poucos segundos. Reiniciar a `api` derruba o gateway; os clientes também reconectam, e o estado de
voz é reconciliado quando a API volta a falar com o serviço de mídia.

### Métricas

`/metrics` da API não passa pelo Caddy. Para coletar com um Prometheus na mesma rede Docker:

```yaml
scrape_configs:
  - job_name: frequencia
    authorization: { credentials: '<METRICS_TOKEN>' }
    static_configs:
      - targets: ['api:4000']
```

Séries principais: `frequencia_users_connected`, `frequencia_voice_channels_active`,
`frequencia_voice_participants`, `frequencia_media_producers`, `frequencia_media_consumers`,
`frequencia_media_worker_cpu_seconds_total`, `frequencia_http_request_duration_seconds`.

## Problemas comuns

| Sintoma                                                | Causa provável                                                                                                       |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Caddy não obtém certificado                            | `DOMAIN` não resolve para o IP, ou a porta 80 está fechada num dos dois firewalls                                    |
| Entra no canal mas fica em `CONECTANDO`/`RECONECTANDO` | Portas 40000–40015 fechadas, ou `PUBLIC_IP` errado (o navegador recebe um endereço que não alcança)                  |
| Funciona em casa, não na rede da empresa               | UDP bloqueado: confira a faixa TCP 40000–40015 e o TURN em 3478/TCP                                                  |
| `"media": false` no health da API                      | `MEDIA_SHARED_SECRET` diferente entre os serviços, ou o container `media` não subiu                                  |
| Áudio funciona, transmissão não inicia                 | O navegador exige HTTPS e um gesto do usuário para `getDisplayMedia`; Safari e Firefox não capturam áudio do sistema |
| TURN sem candidato `relay`                             | Porta 3478 ou faixa 49160–49200 fechada; `PRIVATE_IP` ausente numa VM com NAT 1:1                                    |
