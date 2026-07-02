# Reference image for the dashboard (static build served by nginx). Build from the repo root:
#   docker build -f apps/dashboard/Dockerfile -t throughline-dashboard .
FROM node:20-slim AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile && pnpm -r build

FROM nginx:alpine AS runtime
COPY --from=build /repo/apps/dashboard/dist /usr/share/nginx/html
COPY apps/dashboard/nginx.conf /etc/nginx/nginx.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
