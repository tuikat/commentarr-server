# Commentarr server: one container, no dependencies, data in /data.
FROM node:22.14.0-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
ENV NODE_ENV=production PORT=8790 DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8790
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8790/healthz || exit 1
CMD ["node", "--experimental-sqlite", "--no-warnings=ExperimentalWarning", "src/server.js"]
