# syntax=docker/dockerfile:1

FROM node:22-slim AS builder
WORKDIR /app

# Install full dependencies to compile Vite client and esbuild Node server bundle
COPY package.json ./
RUN npm install --no-audit --no-fund

COPY . .

# NEVER pass GEMINI_API_KEY as a Docker build arg; inject it at runtime via Secret Manager/secrets.

RUN npm run build

FROM node:22-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

# Production dependencies only (no devDependencies such as tsx, vite, typescript, or esbuild)
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/dist-server ./dist-server

USER node
EXPOSE 8080

CMD ["node", "dist-server/server.mjs"]
