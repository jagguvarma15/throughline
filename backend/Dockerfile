# =============================================================================
# Multi-Stage Production Build for TaskFlow Backend
# =============================================================================

# Stage 1: Build Environment
FROM node:25-alpine AS builder

# Install build dependencies
RUN apk add --no-cache python3 make g++ git

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm ci --include=dev

# Copy source code
COPY src/ ./src/

# Build application
RUN npm run build

# Run tests
RUN npm test

# Remove development dependencies
RUN npm prune --omit=dev

# Stage 2: Production Runtime
FROM node:25-alpine AS production

# Install runtime dependencies
RUN apk add --no-cache dumb-init curl

# Create app user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S taskflow -u 1001 -G nodejs

WORKDIR /app

# Copy built application
COPY --from=builder --chown=taskflow:nodejs /app/dist ./dist
COPY --from=builder --chown=taskflow:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=taskflow:nodejs /app/package.json ./

# Create logs directory
RUN mkdir -p logs && chown taskflow:nodejs logs

USER taskflow

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3001/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]

# Stage 3: Development Environment
FROM node:25-alpine AS development

RUN apk add --no-cache git bash vim

WORKDIR /app

RUN npm install -g nodemon ts-node

COPY package*.json tsconfig.json ./
RUN npm ci

RUN addgroup -g 1001 -S nodejs && \
    adduser -S taskflow -u 1001 -G nodejs && \
    chown -R taskflow:nodejs /app

USER taskflow

EXPOSE 3001

CMD ["npm", "run", "dev"]