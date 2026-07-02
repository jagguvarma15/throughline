# Reference image for the control-plane. Build from the repo root:
#   docker build -f apps/control-plane/Dockerfile -t throughline-control-plane .
FROM node:20-slim AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile && pnpm -r build

FROM node:20-slim AS runtime
RUN corepack enable
WORKDIR /repo
COPY --from=build /repo /repo
WORKDIR /repo/apps/control-plane
ENV PORT=3001
EXPOSE 3001
CMD ["node", "dist/index.js"]
