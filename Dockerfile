FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY src/ ./src/
COPY tsconfig.json ./
RUN npm run build && npm prune --omit=dev
EXPOSE 3000
ENTRYPOINT ["node", "dist/index.js"]
