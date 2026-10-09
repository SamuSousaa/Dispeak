# Frequência

Discord/TeamSpeak-style voice and screen-sharing app. Self-hosted infrastructure only: the media
server is our own mediasoup SFU. **Never** add LiveKit, Agora, Daily, Twilio, Firebase, Supabase or
any managed media/realtime service.

Stages, acceptance criteria and open items live in `ROADMAP.md`. Work stage by stage, in order.

## Layout

```
apps/web        React + Vite + Tailwind 4, mediasoup-client, TanStack Query, Zustand
apps/api        Fastify REST API + WebSocket gateway, Drizzle (Postgres), Redis
apps/media      mediasoup SFU, separate service; talks to the API over an internal WS RPC
packages/shared Zod schemas and types: signaling protocol, gateway events, permissions
docs/           architecture, ADRs, deploy guide, load test results
scripts/        dev orchestration
```

`packages/shared` exports TypeScript sources directly (no build step); the Node apps bundle it with
tsup and Vite compiles it for the web.

## Commands

| Command           | What it does                                                       |
| ----------------- | ------------------------------------------------------------------ |
| `pnpm dev`        | Postgres + Redis (Docker, when available) and web/api/media (host) |
| `pnpm dev:docker` | Same, with the media service in a container                        |
| `pnpm lint`       | ESLint over the whole repo, zero warnings allowed                  |
| `pnpm format`     | Prettier write (`format:check` in CI)                              |
| `pnpm typecheck`  | `tsc --noEmit` in every package                                    |
| `pnpm test`       | Vitest unit + integration tests                                    |
| `pnpm e2e`        | Playwright end-to-end tests (starts the stack itself)              |
| `pnpm check`      | lint + format:check + typecheck + test — run before every commit   |
| `pnpm build`      | Production builds                                                  |

Single package: `pnpm --filter @frequencia/api test`. Single file: append the path.

Ports: web 5173, api 4000, media 4100 (signaling) and 40000+ UDP/TCP (RTC). The browser only talks
to its own origin; Vite (dev) and Caddy (prod) proxy `/api` and `/media`.

## Conventions

- TypeScript `strict` everywhere, plus `noUncheckedIndexedAccess`. No `any`; no non-null `!` unless
  an invariant is documented on the same line.
- ESM only. Relative imports without extensions (`moduleResolution: bundler`).
- Code, identifiers, comments, commits and logs in **English**. User-facing UI text in
  **Portuguese (pt-BR)**. Repository docs (README, ROADMAP, docs/) in Portuguese.
- Every message crossing a process boundary (HTTP body, WS frame, internal RPC) is validated with a
  Zod schema from `packages/shared`. Types are inferred from schemas, never duplicated by hand.
- Environment is parsed once per app in `src/config.ts` with Zod; nothing else reads `process.env`.
  Each app has a `.env.example`. Never commit secrets.
- API: routes live in `src/modules/<name>/`, business logic in services that take their
  dependencies as arguments (testable without HTTP). Errors are thrown as `AppError` with a stable
  `code`.
- Media: every mediasoup object is owned by exactly one `Peer`/`Room`; closing the owner closes
  everything. Leaks are covered by tests — keep them passing.
- Web: server state in TanStack Query, realtime state (voice, gateway, presence) in Zustand stores.
  Components do not open sockets; they call store actions.
- Tests: Vitest files in `test/` (Node apps) or next to the source as `*.test.ts(x)` (web/shared).
  Integration tests use real sockets and real mediasoup workers, not mocks.
- Commits: Conventional Commits in English, one per finished stage at minimum.

## Visual identity ("brutalist terminal", product mode)

Tokens are in `apps/web/src/styles/index.css`. Rules: 1px-bordered split panels like an IDE; square
corners (0–2px); no shadows, no gradients; a single accent (`--accent`) reserved for speaking
outline, active item, hover, primary action and the live indicator; labels/nav/buttons/metadata in
JetBrains Mono uppercase 11–13px (`.label`, `.label-lg`); numbered channels (`01. GERAL`); bracketed
buttons (`[ TRANSMITIR ]`, use `<Button>`); system-layer data must be real (RTT, bitrate, codec,
participant count, connection status); transitions 150–250ms; respect `prefers-reduced-motion`;
visible keyboard focus; AA contrast (`--muted` is the darkest text color allowed on `--bg`).

## Environment notes

- mediasoup ships prebuilt workers for Linux, macOS and Windows x64, so the media service runs
  natively in dev. When the prebuilt binary is unavailable, use `pnpm dev:docker`.
- pnpm blocks install scripts by default; allowed ones are listed in `pnpm-workspace.yaml`
  (`allowBuilds`).
- TypeScript is pinned to 6.0.x until `typescript-eslint` supports 7.
