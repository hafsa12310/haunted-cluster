# Orders image. Build context is victim-app/ (the monorepo root):
#   docker build -f apps/orders/Dockerfile .
# Requirements: 10.1, 10.2

# Stage 1: build
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx nest build orders

# Stage 2: runtime
FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist/apps/orders ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
ENV NODE_ENV=production
# nest build keeps the monorepo layout (apps/ and libs/ side by side) because
# the app compiles the shared libs in with it, so the entry point is nested.
CMD ["node", "dist/apps/orders/src/main"]
