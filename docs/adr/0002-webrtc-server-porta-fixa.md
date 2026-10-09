# 0002 — Uma porta RTC fixa por worker

## Contexto

Por padrão cada `WebRtcTransport` do mediasoup abre a própria porta, tirada de uma faixa larga
(tipicamente milhares de portas UDP). Isso complica três coisas neste projeto: o firewall da
Oracle Cloud (cada faixa é uma regra em dois firewalls), o Docker (publicar milhares de portas é
lento e consome memória) e o desenvolvimento em LAN.

## Decisão

Cada worker cria um `WebRtcServer` que escuta em **uma porta UDP e uma TCP fixas por endereço
anunciado**; todos os transports daquele worker passam por elas, demultiplexados pelo
`usernameFragment` do ICE. A faixa necessária é `workers × endereços anunciados`.

`RTC_ANNOUNCED_ADDRESSES` aceita uma lista. Sem configuração, em desenvolvimento, anuncia-se
`127.0.0.1` e o primeiro IPv4 da LAN, o que cobre a própria máquina e outros dispositivos da rede
sem editar nada. Em produção anuncia-se o IP público e, havendo NAT 1:1, também o privado (para o
TURN no mesmo host alcançar o SFU).

A configuração recusa iniciar se a faixa não comportar todos os workers.

## Consequências

- Produção publica 16 portas em vez de milhares.
- Todo o tráfego de um worker passa por um socket; o desempenho é o mesmo, pois o worker já é de
  uma thread.
- Mais de um endereço anunciado multiplica as portas e os candidatos ICE.
