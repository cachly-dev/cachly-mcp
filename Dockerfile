FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig*.json ./
RUN npm ci --ignore-scripts
COPY src/ ./src/
# notifier.ts re-exports from packages/telegram-notify; tsconfig includes packages/**.
# Without this, `tsc` fails with TS2307 (cannot find ../packages/telegram-notify/client.js).
COPY packages/ ./packages/
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=builder /app/dist/ ./dist/
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
# tsc rootDir is "." (src/ + packages/) so output lives at dist/src/index.js,
# matching package.json bin/main/start. NOT dist/index.js.
ENTRYPOINT ["node", "dist/src/index.js"]
