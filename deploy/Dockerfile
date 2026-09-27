# syntax=docker/dockerfile:1

FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@10.25.0 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
COPY apps/mock-gateway/package.json apps/mock-gateway/
COPY apps/mock-agent/package.json apps/mock-agent/
COPY apps/web/package.json apps/web/

RUN pnpm install --frozen-lockfile

COPY packages/contracts packages/contracts
COPY apps/api apps/api
COPY apps/mock-gateway apps/mock-gateway
COPY apps/mock-agent apps/mock-agent
COPY apps/web apps/web

RUN pnpm --filter @platform/contracts build \
  && pnpm --filter @platform/api build \
  && pnpm --filter @platform/mock-gateway build \
  && pnpm --filter @platform/mock-agent build

ARG VITE_API_URL=http://localhost:13000
ARG VITE_WS_URL=ws://localhost:13000/ws
ENV VITE_API_URL=${VITE_API_URL} VITE_WS_URL=${VITE_WS_URL}
RUN pnpm --filter @platform/web build

# Keep the full pnpm layout (symlinks under apps/*/node_modules); stash web dist for nginx stage.
RUN cp -r apps/web/dist /tmp/web-dist && rm -rf apps/web

FROM node:22-alpine AS runtime-node
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app

FROM runtime-node AS runtime-api
EXPOSE 3000
CMD ["sh", "-c", "node apps/api/dist/db/migrate.js && node apps/api/dist/main.js"]

FROM runtime-node AS runtime-gateway
ENV PORT=4001
EXPOSE 4001
CMD ["node", "apps/mock-gateway/dist/main.js"]

FROM runtime-node AS runtime-agent
ENV PORT=4002
EXPOSE 4002
CMD ["node", "apps/mock-agent/dist/main.js"]

FROM nginx:1.27-alpine AS runtime-web
COPY deploy/nginx-web.conf /etc/nginx/conf.d/default.conf
COPY --from=build /tmp/web-dist /usr/share/nginx/html
EXPOSE 80
