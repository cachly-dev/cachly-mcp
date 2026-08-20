FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig*.json ./
RUN npm ci --ignore-scripts
COPY src/ ./src/
# notifier.ts re-exports from packages/telegram-notify; tsconfig includes packages/**.
# Without this, `tsc` fails with TS2307 (cannot find ../packages/telegram-notify/client.js).
COPY packages/ ./packages/
# `npm run build` ist seit dem 20.08.2026 nicht mehr nur `tsc` — es ruft
# danach scripts/bauabdruck.mjs. Ohne diese Zeile bricht der Abbild-Bau mit
#   Error: Cannot find module '/app/scripts/bauabdruck.mjs'
# ab. Der Fehler fiel erst auf main auf, weil die PR-Pruefungen `npm run
# build` gar nicht fahren: sie pruefen `tsc --noEmit` und `npm test`.
COPY scripts/ ./scripts/
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
