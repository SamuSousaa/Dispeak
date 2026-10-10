# syntax=docker/dockerfile:1.7
# Build context: repository root.
#   docker build -f apps/api/Dockerfile -t frequencia-api .

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY packages/shared/package.json packages/shared/package.json

FROM base AS build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm install --frozen-lockfile --filter @frequencia/api...
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @frequencia/api build

# Runtime dependencies only, installed for the target platform.
FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm install --frozen-lockfile --prod --filter @frequencia/api...

FROM node:24-bookworm-slim AS prod
ENV NODE_ENV=production
# Same layout as the workspace, so pnpm's relative symlinks keep resolving.
WORKDIR /repo/apps/api
COPY --from=prod-deps /repo/node_modules /repo/node_modules
COPY --from=prod-deps /repo/apps/api/node_modules ./node_modules
COPY --from=build /repo/apps/api/dist ./dist
COPY apps/api/drizzle ./drizzle
COPY apps/api/package.json ./
# Chat attachments live here; the volume mounted on it inherits this ownership.
RUN mkdir -p /data/uploads && chown node:node /data/uploads
USER node
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/health').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/index.js"]
