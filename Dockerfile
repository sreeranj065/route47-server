# syntax=docker/dockerfile:1

# ---- build stage: compile TypeScript to dist/ ----
# node:sqlite (DatabaseSync) requires Node >= 23.4 without flags, so the image
# uses the Node 24 LTS line rather than Node 20.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage: production deps + compiled JS only ----
FROM node:24-slim
ENV NODE_ENV=production \
    DATA_DIR=/data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# Persistent state (SQLite DB + proof photos) lives under /data — mount a volume
# here (declared in render.yaml / Railway dashboard / docker-compose.yml, NOT via
# a VOLUME instruction: Railway rejects Dockerfiles containing VOLUME). The
# container runs as root because Render/Railway mount persistent disks
# root-owned; a non-root user would hit EACCES on first write.
# Self-update on VPS: Docker CLI talks to the host daemon via mounted socket.
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker
RUN mkdir -p /usr/local/lib/docker/cli-plugins
COPY --from=docker:27-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/lib/docker/cli-plugins/docker-compose
EXPOSE 4700
# PORT is injected by Render/Railway; the server falls back to 4700 locally.
CMD ["node", "dist/index.js"]
