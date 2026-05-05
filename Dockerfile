FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig*.json ./
RUN npm ci --ignore-scripts
COPY src/ ./src/
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=builder /app/dist/ ./dist/
ENV NODE_ENV=production
ENV CACHLY_JWT=""
ENV CACHLY_BRAIN_INSTANCE_ID=""
ENV CACHLY_NO_TELEMETRY=1
ENV CACHLY_NO_UPDATE_CHECK=1
ENTRYPOINT ["node", "dist/index.js"]
