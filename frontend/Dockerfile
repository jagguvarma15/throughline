# Multi-stage build for React frontend
FROM node:26-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

# Production server
FROM nginx:alpine AS production

COPY --from=builder /app/build /usr/share/nginx/html
COPY nginx.conf /etc/nginx/nginx.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]

# Development environment
FROM node:26-alpine AS development

WORKDIR /app

COPY package*.json ./
RUN npm ci

RUN addgroup -g 1001 -S react && \
    adduser -S reactuser -u 1001 -G react && \
    chown -R reactuser:react /app

USER reactuser

EXPOSE 3000

CMD ["npm", "start"]