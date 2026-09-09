#!/usr/bin/env bash
# dev.sh — Start the openvfr-app development environment.
#
# Docker services (PostGIS, Martin, Hono API, PostgREST) run in containers.
# The Vite dev server runs on the host so HMR works natively.
#
# Usage:
#   bash dev.sh
#
# Map/aviation data (tiles, GeoJSON) is not included in this repo — see
# docs/self-hosting.md for how to generate it. Without it, the map renders
# with an empty basemap/aviation layers, which is fine for app development
# that doesn't depend on real tile data.

set -euo pipefail

echo "[dev] Starting PostGIS, Martin, API, and PostgREST containers..."
docker compose up -d db martin api postgrest

echo "[dev] Waiting for PostGIS to be healthy..."
until docker compose exec -T db pg_isready -U openvfr -d openvfr -q 2>/dev/null; do
  sleep 1
done
echo "[dev] PostGIS is ready."

echo ""
echo "[dev] Starting Vite dev server at http://localhost:5173 ..."
echo ""
pnpm --filter web dev
