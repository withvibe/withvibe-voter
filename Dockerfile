# SPDX-FileCopyrightText: 2026 WithVibe
# SPDX-License-Identifier: Apache-2.0
#
# Vibe Reef plugin for WithVibe.
#   docker build -t local/reef:0.1 .
#
# Multi-stage build:
#   1. Builder installs deps with `npm ci` against the committed lockfile.
#   2. Runtime drops npm/npx itself — the npm CLI's own bundled deps are
#      where ~95% of Trivy findings live, and we don't need npm at runtime.

FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:20-alpine
WORKDIR /app
# Strip the npm CLI from the runtime — once deps are installed we never
# need npm or npx. Removing it deletes /usr/local/lib/node_modules/npm
# which is where tar/glob/minimatch/brace-expansion/diff live in the
# base image.
RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/bin/npm \
           /usr/local/bin/npx
COPY --from=builder /app/node_modules ./node_modules
COPY server.js db.js mcp.js ui.js ./
EXPOSE 8080
ENV NODE_ENV=production
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1
CMD ["node", "server.js"]
