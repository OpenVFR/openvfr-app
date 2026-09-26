# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:24-alpine AS builder

WORKDIR /app

# pnpm's dependency-status check tries to interactively confirm a
# node_modules purge/reinstall when it detects drift (e.g. after new
# workspace members' source lands via COPY . . below) -- that prompt has
# no TTY to answer in a Docker build and fails hard
# (ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY). CI=true makes pnpm behave
# non-interactively throughout.
ENV CI=true

# Corepack picks the exact pnpm version pinned in the root package.json's
# `packageManager` field. Never `corepack prepare pnpm@latest` here: that
# floats to whatever npm's `latest` tag is (a new major can land there
# at any time) instead of the version the lockfile was written with.
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Copy EVERY workspace member's manifest before installing -- pnpm computes
# lockfile consistency across the whole workspace, not just the filtered
# target. Missing a member here (e.g. apps/native, apps/api) makes a later
# `pnpm --filter web build` detect an out-of-sync node_modules once the
# full source lands via `COPY . .` below, and try to interactively
# purge/reinstall -- which fails in a non-TTY Docker build with
# ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY.
COPY apps/web/package.json ./apps/web/
COPY apps/native/package.json ./apps/native/
COPY apps/api/package.json ./apps/api/
COPY packages/shared/package.json ./packages/shared/
# pnpm (v10+) blocks all install scripts by default; --ignore-scripts bypasses the
# check, then we rebuild only esbuild so its platform binary is downloaded.
RUN pnpm install --frozen-lockfile --ignore-scripts || pnpm install --ignore-scripts
RUN pnpm rebuild esbuild

COPY . .

# VITE_MARTIN_URL controls which URL the bundled JS uses to reach the Martin
# tile server. In production this is set to /martin so nginx can proxy it
# internally. In dev, the default http://localhost:3000 is used via the
# fallback in apps/web/src/styles/map-style.ts.
ARG VITE_MARTIN_URL
ENV VITE_MARTIN_URL=${VITE_MARTIN_URL}

RUN pnpm --filter web build

# ── Stage 2: Serve ────────────────────────────────────────────────────────────
FROM nginx:1.30-alpine AS runner

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html

# .pmtiles/GeoJSON tile files are mounted at runtime (public/tiles →
# /usr/share/nginx/html/tiles) so they are not baked into the image. See
# docs/self-hosting.md for how to generate them. This keeps the image small
# and allows tile updates without a rebuild.

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
