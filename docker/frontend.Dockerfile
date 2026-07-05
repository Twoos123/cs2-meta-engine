# syntax=docker/dockerfile:1

# ---- build stage: compile the React/Vite bundle -----------------------------
FROM node:22-alpine AS build

WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---- runtime stage: unprivileged nginx serves static + proxies /api ---------
# nginx-unprivileged runs the master as uid 101 (not root) and listens on 8080
FROM nginxinc/nginx-unprivileged:1.29-alpine

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
