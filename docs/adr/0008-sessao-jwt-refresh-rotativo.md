# 0008 — JWT curto em memória e refresh token rotativo em cookie

## Contexto

A autenticação precisa servir a REST e a dois tipos de WebSocket, sobreviver a recarregar a
página, permitir logout com revogação real e resistir, na medida do possível, a XSS e a roubo de
token.

## Decisão

- **Access token:** JWT HS256 de 15 minutos com o id do usuário e o id da sessão. Fica **só em
  memória** no navegador — nunca em `localStorage`.
- **Refresh token:** 256 bits aleatórios em cookie `httpOnly`, `SameSite=Strict`, `Secure` em
  produção, com `Path=/api/auth`. O banco guarda apenas o SHA-256.
- **Rotação:** cada uso revoga o token apresentado e emite o sucessor, na mesma _família_ (uma
  família por login).
- **Detecção de reuso:** um token já revogado que reaparece indica cópia; a família inteira é
  revogada. Há 10 segundos de tolerância para o caso legítimo de duas abas renovando juntas.
- **Revogação:** logout revoga a família e grava seu id numa lista de negação no Redis pelo tempo
  de vida restante do access token. As conexões de gateway daquela sessão são derrubadas na hora.
- **Senhas:** argon2id (19 MiB, 2 iterações). O login gasta o mesmo tempo para usuário inexistente
  e senha errada, e responde com a mesma mensagem.

## Alternativas

- **Sessão por cookie no servidor.** Mais simples e igualmente segura para REST, mas os WebSockets
  (um deles em outro serviço) precisariam consultar a sessão; o token assinado dispensa isso.
- **Access token em `localStorage`.** Sobrevive ao reload sem refresh, e fica ao alcance de
  qualquer script injetado.

## Consequências

- Recarregar a página custa uma chamada a `/auth/refresh` antes de qualquer outra.
- A API só verifica o cookie em `/api/auth/*`; todo o resto usa `Authorization: Bearer`, o que
  elimina CSRF nas rotas de negócio.
- A revogação de access tokens depende do Redis; sem ele, um token revogado valeria até expirar
  (no máximo 15 minutos).
