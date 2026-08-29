# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Build stage: compile every package, then bundle the CLI into one file.
# ---------------------------------------------------------------------------
FROM node:20-alpine AS build

WORKDIR /app

# Copy manifests first so `npm ci` is cached until a dependency actually
# changes, rather than on every source edit.
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/core/package.json packages/core/
COPY packages/web/package.json packages/web/
COPY packages/cli/package.json packages/cli/

RUN npm ci

COPY tsconfig.base.json ./
COPY packages ./packages
COPY scripts ./scripts
COPY packaging ./packaging

RUN npm run build && node scripts/bundle.mjs

# ---------------------------------------------------------------------------
# Runtime stage: the bundle and the dashboard, with no node_modules at all.
# ---------------------------------------------------------------------------
FROM node:20-alpine

RUN addgroup -S notifyjs && adduser -S notifyjs -G notifyjs

WORKDIR /app

COPY --from=build /app/build/notifyjs.cjs ./notifyjs.cjs
COPY --from=build /app/build/dashboard ./dashboard

# The hub cannot resolve @notifyjs/web as a module here, so point it directly.
ENV NOTIFYJS_DASHBOARD_DIR=/app/dashboard

# Hub state (devices, roles, history) belongs on a volume, not in the image.
RUN mkdir -p /data && chown notifyjs:notifyjs /data
VOLUME ["/data"]

USER notifyjs
EXPOSE 7741

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:7741/health || exit 1

ENTRYPOINT ["node", "/app/notifyjs.cjs"]
CMD ["serve", "--host", "0.0.0.0", "--port", "7741", "--data", "/data"]
