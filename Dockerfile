# -- Stage 1: Build TypeScript --
FROM node:22-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# -- Stage 2: Production runtime --
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist

# Run as non-root user (limits blast radius if container is compromised)
RUN groupadd -r app && useradd -r -g app -s /bin/false app
USER app

ENV PORT=8080
EXPOSE 8080
CMD ["node", "dist/index.js"]
