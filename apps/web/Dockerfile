# syntax=docker/dockerfile:1.7
# Build context: repository root.
#   docker build -f apps/web/Dockerfile -t frequencia-web .
#
# The final image is Caddy itself: it serves the built single-page app and is the HTTPS
# reverse proxy in front of the API and the media service (see deploy/Caddyfile).

FROM node:24-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm install --frozen-lockfile --filter @frequencia/web...
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @frequencia/web build

FROM caddy:2-alpine AS prod
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/web/dist /srv
EXPOSE 80 443 443/udp
