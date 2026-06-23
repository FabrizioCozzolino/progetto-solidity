FROM node:20-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm install
COPY . .
# compile durante la build
RUN npx hardhat compile
RUN mkdir -p \
    /app/contratto-ricardiano-api-mock/storage/ricardians \
    /app/contratto-ricardiano-api-mock/storage/cades \
    /app/contratto-ricardiano-api-mock/storage/tmp \
    /app/contratto-ricardiano-api-mock/file-json
EXPOSE 3000
# IMPORTANTE: il deploy NON deve girare a ogni avvio del container.
# Deploya una sola volta a mano (docker compose run --rm ricardian-api npm run deploy)
# e fissa l'indirizzo in deployed.json. Lo start esegue solo il server.
CMD ["npm", "start"]