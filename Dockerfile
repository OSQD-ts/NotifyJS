# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Build stage: compile every package, then bundle the CLI into one file.
# ---------------------------------------------------------------------------
# Pinned by digest, not just by tag: `20-alpine` is republished whenever the
# base is rebuilt, so a tag alone means the image this produces is not the one
# that was reviewed. Nothing bumps this automatically; move the digest and the
# comment together.
#
# `--platform=$BUILDPLATFORM` keeps this stage on the machine doing the
# building, whatever architectures are being produced. What it emits is a
# bundled `notifyjs.cjs` and a directory of HTML, CSS and JavaScript - not one
# byte of it architecture-specific - so running `npm ci` and a TypeScript build
# again under emulation buys nothing.
#
# It also cost the arm64 leg of a multi-platform build entirely: Node under
# QEMU aarch64 dies partway through `npm ci` with
#
#   qemu: uncaught target signal 4 (Illegal instruction) - core dumped
#
# and the build then sits there rather than failing. Only the runtime stage
# below is built per-architecture now, and it runs no Node at all.
FROM --platform=$BUILDPLATFORM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS build

WORKDIR /app

# Copy manifests first so `npm ci` is cached until a dependency actually
# changes, rather than on every source edit.
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/core/package.json packages/core/
COPY packages/web/package.json packages/web/
COPY packages/cli/package.json packages/cli/

# `--ignore-scripts`: an npm lifecycle script is arbitrary code running with
# the build's filesystem and network. Nothing in this dependency set needs one
# (the runtime deps are `ws` and `qrcode-generator`), so the capability is
# simply withheld rather than trusted.
RUN npm ci --ignore-scripts

COPY tsconfig.base.json LICENSE ./
COPY packages ./packages
COPY scripts ./scripts
COPY packaging ./packaging
# The build generates every icon from these, including the dashboard favicon,
# so the image cannot be built without them.
COPY assets ./assets

RUN npm run build && node scripts/bundle.mjs

# ---------------------------------------------------------------------------
# Runtime stage: the bundle and the dashboard, with no node_modules at all.
# ---------------------------------------------------------------------------
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293

RUN addgroup -S notifyjs && adduser -S notifyjs -G notifyjs

WORKDIR /app

COPY --from=build /app/build/notifyjs.cjs ./notifyjs.cjs
COPY --from=build /app/build/dashboard ./dashboard
COPY --from=build /app/LICENSE ./LICENSE

# The hub cannot resolve @osqd/notifyjs-web as a module here, so point it directly.
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
