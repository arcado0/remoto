# Server ID di Remoto. Da costruire dalla radice del progetto:
#   docker build -f server/Dockerfile -t remoto-server .
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production \
    REMOTO_DATA_DIR=/data \
    REMOTO_PORT=47800

COPY server/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src/shared ./src/shared
COPY src/server ./src/server

RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 47800

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:47800/health > /dev/null || exit 1

CMD ["node", "src/server/cli.js"]
