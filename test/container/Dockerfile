# Linux container for the remote-mode integration suite. Glimmervoid is developed on Windows, but remote
# mode ships to a Linux box behind a reverse proxy, so the two-listener behavior is verified there.
# node-pty is a native module: python3/make/g++ are its build prerequisites.
FROM node:24-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY . .
RUN npm ci

# The image intentionally does not run the suite at build time: the script needs a writable
# /root/.glimmervoid and starts real listeners, both of which belong to `docker run`.
CMD ["bash", "test/container/remote-mode.sh"]
