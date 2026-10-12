# Dispeaker

Discord/TeamSpeak-style voice, screen sharing and text chat. The product is called Dispeaker;
packages, storage keys and service names keep the working title `frequencia`. Self-hosted infrastructure only: the
media server is our own mediasoup SFU. **Never** add LiveKit, Agora, Daily, Twilio, Firebase,
Supabase or any managed media/realtime service.

Stages, acceptance criteria and open items live in `ROADMAP.md`. Architecture is described in
`docs/architecture.md`; the reasons behind it are in `docs/adr/`.

## Layout

```
apps/web        React + Vite + Tailwind 4, mediasoup-client, TanStack Query, Zustand
apps/api        Fastify REST API + WebSocket gateway, Drizzle (Postgres), Redis
apps/media      mediasoup SFU, separate service; talks to the API over an internal WS RPC
apps/desktop    Electron window onto the published web app: own screen picker, process priority
packages/shared Zod schemas and types: RPC protocol, signaling, gateway, REST, permissions
deploy/         Caddyfile for production
docs/           architecture, ADRs, deploy guide, load test results
load/           k6 scripts and raw load test results
scripts/        dev and local-production orchestration
```

`packages/shared` exports TypeScript sources directly (no build step); the Node apps bundle it with
tsup and Vite compiles it for the web.

## Commands

| Command                                     | What it does                                                        |
| ------------------------------------------- | ------------------------------------------------------------------- |
| `pnpm dev`                                  | Postgres + Redis, then web/api/media on the host, in watch mode     |
| `pnpm dev:docker`                           | Same, with the media service in a container                         |
| `pnpm check`                                | lint + format:check + typecheck + test — run before every commit    |
| `pnpm lint` / `pnpm format`                 | ESLint (zero warnings allowed) / Prettier write                     |
| `pnpm typecheck` / `pnpm test`              | `tsc --noEmit` / Vitest in every package                            |
| `pnpm e2e`                                  | Playwright end-to-end tests (starts the stack itself)               |
| `pnpm build && pnpm start:local`            | Production bundles running locally, without Docker                  |
| `pnpm prod:up`                              | Production stack with Docker (needs `.env.prod`)                    |
| `pnpm --filter @frequencia/api db:generate` | SQL migration from a change in `src/db/schema.ts`                   |
| `pnpm --filter @frequencia/desktop package` | Windows installer of the desktop app, in `apps/desktop/release`     |
| `pnpm release:desktop`                      | Builds that installer and uploads it to the server (`.env.release`) |
| `pnpm --filter @frequencia/web load:voice`  | Voice load test (see `docs/load-test.md`)                           |

Single package: `pnpm --filter @frequencia/api test`. Single file:
`pnpm --filter @frequencia/api exec vitest run test/auth.test.ts`.

Ports: web 5173, api 4000, media 4100 (signaling) and 40000+ UDP/TCP (RTC), Postgres 5432, Redis 6379. The browser only talks to its own origin; Vite (dev) and Caddy (prod) proxy `/api`, `/docs`
and `/media`. After an interrupted run, `node scripts/kill-ports.mjs` frees the app ports.

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
- API: routes in `src/modules/<name>/routes.ts` (with OpenAPI schemas), logic in services that take
  the acting user id and check permissions against a fresh guild snapshot. Expected failures are
  `AppError` with a stable `code`. Services tell the gateway what changed through `GatewayBus`;
  anything that can change visibility publishes `bus.sync(guildId)`.
- Channels a user cannot view do not exist for that user: 404, not 403, and no events.
- Media: every mediasoup object is owned by exactly one `Peer`/`Room`; closing the owner closes
  everything. The media service knows nothing about users or permissions beyond the voice token.
  Leaks are covered by tests — keep them passing.
- Web: server state in TanStack Query, realtime state (voice, gateway, presence) in Zustand stores.
  Components do not open sockets; they call actions. Permission math on the client uses the shared
  functions and only decides what to show.
- Tests: Vitest files in `test/` (Node apps) or next to the source as `*.test.ts(x)` (web/shared).
  Integration tests use real sockets, real mediasoup workers, real Postgres and real Redis — no
  mocks of infrastructure. API tests get their database from `test/global-setup.ts`.
- Commits: Conventional Commits in English.

## Visual identity ("brutalist terminal", product mode)

Tokens are in `apps/web/src/styles/index.css`. Rules: 1px-bordered split panels like an IDE; square
corners (0–2px); no shadows, no gradients; a single accent (`--accent`) reserved for speaking
outline, active item, hover, primary action and the live indicator; labels/nav/buttons/metadata in
JetBrains Mono uppercase 11–13px (`.label`, `.label-lg`); numbered channels (`01. GERAL`); bracketed
buttons (`[ TRANSMITIR ]`, use `<Button>`); system-layer data must be real (RTT, bitrate, codec,
participant count, connection status); transitions 150–320ms, exits quicker than entrances; respect `prefers-reduced-motion`;
visible keyboard focus; AA contrast (`--muted` is the darkest text color allowed on `--bg`).

Motion: the opening screen (`BootScreen`, styled in `apps/web/index.html` so it paints before any
script) is the one authored moment; everything else is feedback or continuity. A wait is said with
`<Loading>` (the three-bar `Signal`), never a bare label. New badges use `.anim-badge`, a swapped
main view `.anim-view`. No bounce, no looping decoration.

## Environment notes

- mediasoup ships prebuilt workers for Linux, macOS and Windows x64, so the media service runs
  natively in dev. When the prebuilt binary is unavailable, use `pnpm dev:docker`.
- Without Docker, `scripts/lib/infra.mjs` starts an embedded Postgres (data in `.dev/postgres`) and
  an embedded Redis; the API test setup does the same on random ports. CI uses service containers
  (`TEST_DATABASE_URL`, `TEST_REDIS_URL`).
- The embedded Postgres is initialised as UTF-8 (`initdbFlags`). A `.dev/postgres` created on
  Windows before that defaults to WIN1252 and answers 500 to any message with emoji: delete the
  directory (losing local data) or convert the database.
- pnpm blocks install scripts by default; allowed ones are listed in `pnpm-workspace.yaml`
  (`allowBuilds`).
- TypeScript is pinned to 6.0.x until `typescript-eslint` supports 7.
- Runtime dependencies of the Node apps must be in `dependencies`: tsup bundles anything that is
  only a devDependency, and bundled CommonJS breaks the ESM output (it happened with `ws`).
- When writing files from a shell heredoc, backslashes get mangled; use the editor tools for
  anything containing regexes or escapes.
