# ---- build stage ----
FROM node:26-slim AS build

WORKDIR /app

# Copy dependency manifests first for better layer caching
COPY package.json bun.lock .bun-version ./

# Install the Bun version tracked by the repo
RUN set -eu; \
    BUN_VERSION="$(tr -d '\r\n' < .bun-version)"; \
    printf '%s' "$BUN_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; \
    npm install -g "bun@$BUN_VERSION"

# Install all dependencies (including devDependencies for build)
RUN bun install --frozen-lockfile

# Copy source code
COPY src/ src/
COPY scripts/ scripts/
COPY bin/ bin/
COPY tsconfig.json ./

# Build the CLI bundle
RUN bun run build

# Prune devDependencies
RUN rm -rf node_modules && bun install --frozen-lockfile --production

# ---- runtime stage ----
FROM node:26-slim

WORKDIR /app

# Copy only what's needed to run
COPY --from=build /app/dist/cli.mjs dist/cli.mjs
COPY --from=build /app/bin/ bin/
COPY --from=build /app/node_modules/ node_modules/
COPY --from=build /app/package.json package.json
COPY README.md ./

# Install git and ripgrep — many CLI tool operations depend on them
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep \
    && rm -rf /var/lib/apt/lists/*

# Run as non-root user
USER node

ENTRYPOINT ["node", "/app/bin/openclaude"]
