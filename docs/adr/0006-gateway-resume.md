# 0006 — Gateway com fan-out por Redis e `resume` local à instância

## Contexto

O gateway entrega eventos em tempo real e precisa (a) funcionar com mais de uma instância da API
e (b) permitir que um cliente que perdeu a conexão por alguns segundos retome sem recarregar tudo
e sem perder eventos.

## Decisão

**Fan-out.** Quem trata a requisição REST publica uma mensagem num canal Redis; todas as
instâncias a recebem e entregam aos sockets que possuem. Cada instância filtra por visibilidade
usando um snapshot do servidor em cache, invalidado pelos próprios eventos estruturais. As
mensagens de um mesmo servidor são processadas em ordem.

**Sessão e resume.** Cada sessão numera seus dispatches e guarda os últimos 500 em memória. Ao
cair o socket, a sessão fica viva por 60 s; um `RESUME` com `sessionId` e o último número recebido
reenvia o que faltou. Presença só passa a offline quando a sessão expira.

**O buffer de replay fica na memória da instância que atendia o socket.** Um `RESUME` que chega a
outra instância recebe `INVALID_SESSION`, e o cliente faz um `IDENTIFY` novo, recebendo o estado
completo em `READY`.

## Alternativa descartada

Guardar o buffer de cada sessão no Redis para permitir resume em qualquer instância. Exige que a
instância antiga continue alimentando o buffer enquanto a sessão está desconectada e que haja uma
passagem de posse sem perder eventos no intervalo — um protocolo de coordenação inteiro, para
ganhar apenas um resync mais barato.

## Consequências

- Correção não depende de afinidade: no pior caso o cliente refaz o `IDENTIFY`. Nunca fica com
  estado errado.
- Com várias instâncias atrás de um balanceador, afinidade de sessão aumenta a taxa de resumes
  bem-sucedidos.
- Presença tem expiração por heartbeat no Redis: uma instância que morre não deixa ninguém online
  para sempre, embora os demais só percebam a saída ao recarregar o servidor.
- Uma tempestade de entradas num servidor muito grande atrasa os demais eventos daquele servidor
  ([teste de carga](../load-test.md), cenário de 1.000 conexões).
