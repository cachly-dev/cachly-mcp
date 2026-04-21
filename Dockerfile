FROM node:22-alpine
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Build TypeScript
COPY src/ ./src/
COPY tsconfig.json ./
RUN npm run build && npm prune --omit=dev

# MCP servers communicate over stdio — no port needed
ENV CACHLY_JWT=""
ENV CACHLY_INSTANCE_ID=""
ENV CACHLY_NO_TELEMETRY=1
ENV CACHLY_NO_UPDATE_CHECK=1

ENTRYPOINT ["node", "dist/index.js"]
