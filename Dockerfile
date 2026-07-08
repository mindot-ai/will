# ─────────────────────────────────────────────────────────────
# @mindot/will — the sidecar image: one persistent mind over HTTP
# ─────────────────────────────────────────────────────────────
#
#   docker build -t will .
#   docker run -p 7777:7777 -v will-data:/data -e WILL_NAME=Aria will
#
# The mind PERSISTS across container restarts: it hibernates its PMA artifact
# to the /data volume on SIGTERM and wakes as the same self on the next start.
# Configure via env (see `will --help`): WILL_NAME, WILL_IDENTITY, WILL_TIER,
# WILL_LLM (+ ANTHROPIC_API_KEY for a live mind; defaults to the zero-key
# mock), WILL_TICK_MS, WILL_MCP_SERVERS.
#
# Builds from the repo's own tree (dist/ is checked in). To run the published
# package instead: FROM node:22-slim → npm i -g @mindot/will → CMD will serve.
# ─────────────────────────────────────────────────────────────

FROM node:22-slim

WORKDIR /app
COPY package.json bun.lock ./
COPY dist ./dist

# Runtime deps only (the MCP SDK + zod); dist is prebuilt.
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund

ENV WILL_HOST=0.0.0.0 \
    WILL_PORT=7777 \
    WILL_PMA_PATH=/data/will.pma.json \
    NODE_ENV=production

VOLUME /data
EXPOSE 7777

# Tini-less: node handles SIGTERM; the CLI hibernates the mind before exit.
CMD [ "node", "dist/cli.js", "serve" ]
