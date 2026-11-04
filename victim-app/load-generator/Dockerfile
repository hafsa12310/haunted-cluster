# Load generator image. Build context is victim-app/ (the monorepo root):
#   docker build -f load-generator/Dockerfile .
# Requirements: 10.1

FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx tsc -p load-generator/tsconfig.json

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist/load-generator ./dist
COPY --from=builder /app/node_modules ./node_modules
CMD ["node", "dist/index.js"]
