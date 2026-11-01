FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git openssh-client ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json server.js merge.js seed.js store.js ./
COPY public ./public

ENV NODE_ENV=production
EXPOSE 8787
CMD ["node", "server.js"]
