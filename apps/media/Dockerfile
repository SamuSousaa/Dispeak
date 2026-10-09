# syntax=docker/dockerfile:1.7
# Build context: repository root.

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
# python3/make/g++ are only used if mediasoup has no prebuilt worker for the platform.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/media/package.json apps/media/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm install --frozen-lockfile --filter @frequencia/media...

# Development: sources are synced in by `docker compose watch`.
FROM deps AS dev
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/media apps/media
ENV NODE_ENV=development
CMD ["pnpm", "--filter", "@frequencia/media", "dev"]

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/media apps/media
RUN pnpm --filter @frequencia/media build \
  && pnpm --filter @frequencia/media deploy --prod --legacy /out \
  && cp -r apps/media/dist /out/dist

FROM node:24-bookworm-slim AS prod
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 4100
CMD ["node", "dist/index.js"]
