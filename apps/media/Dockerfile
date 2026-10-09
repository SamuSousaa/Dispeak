# syntax=docker/dockerfile:1.7
# Build context: repository root.
#   docker build -f apps/media/Dockerfile -t frequencia-media .
#
# mediasoup downloads a prebuilt worker for linux x64/arm64 during install. The compiler
# toolchain is only there for platforms without a prebuilt binary, where the worker is built
# from source; it never reaches the final image.

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/media/package.json apps/media/package.json
COPY packages/shared/package.json packages/shared/package.json

FROM base AS deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm install --frozen-lockfile --filter @frequencia/media...
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/media apps/media

# Development (docker-compose.yml, profile "media"): sources are kept in sync by
# `docker compose watch` and the service restarts on change.
FROM deps AS dev
ENV NODE_ENV=development
CMD ["pnpm", "--filter", "@frequencia/media", "dev"]

FROM deps AS build
RUN pnpm --filter @frequencia/media build

# Runtime dependencies only (this is where the mediasoup worker binary comes from).
FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm install --frozen-lockfile --prod --filter @frequencia/media...

FROM node:24-bookworm-slim AS prod
ENV NODE_ENV=production
# Same layout as the workspace, so pnpm's relative symlinks keep resolving.
WORKDIR /repo/apps/media
COPY --from=prod-deps /repo/node_modules /repo/node_modules
COPY --from=prod-deps /repo/apps/media/node_modules ./node_modules
COPY --from=build /repo/apps/media/dist ./dist
COPY apps/media/package.json ./
USER node
EXPOSE 4100
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:4100/media/health').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/index.js"]
