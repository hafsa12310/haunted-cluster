# Build context is the repo root (needs shared/):
#   docker build -f haunting-engine/Dockerfile .
FROM node:20-alpine AS builder
WORKDIR /app/haunting-engine
COPY haunting-engine/package*.json ./
RUN npm ci
COPY shared/ /app/shared/
COPY haunting-engine/ ./
RUN npm run build            # prebuild compiles shared/ to .d.ts first

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/haunting-engine/dist ./dist
COPY --from=builder /app/haunting-engine/node_modules ./node_modules
COPY --from=builder /app/haunting-engine/package.json ./
ENV NODE_ENV=production
CMD ["node", "dist/main"]
