# ---- build the static frontend ----
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG SEARCH_ENGINES=false
# webpack.config.js refuses to run without a .env file
RUN printf 'SEARCH_ENGINES=%s\nDEV_SERVER_AUTO_OPEN=false\n' "$SEARCH_ENGINES" > .env \
    && npm run build

# ---- static files + reverse proxy for /mp and /api ----
FROM nginx:1.27-alpine AS web
COPY docker/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html

# ---- multiplayer websocket server ----
FROM node:20-alpine AS mp
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
# the shared modules the server imports from the frontend source
COPY src/js/scoring.js ./src/js/scoring.js
COPY src/js/data/maps.js ./src/js/data/maps.js
COPY src/js/chatLimits.js ./src/js/chatLimits.js
USER node
EXPOSE 3001
CMD ["node", "server/index.js"]
