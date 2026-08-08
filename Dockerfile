FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY . .
RUN npm ci \
  && npm prune --omit=dev --ignore-scripts

EXPOSE 3000

CMD ["node", "server.js"]
