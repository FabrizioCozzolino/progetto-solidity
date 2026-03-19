FROM node:20-bookworm-slim

WORKDIR /app

# OpenSSL serve perché il codice usa execFile("openssl", ...)
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copia i file delle dipendenze
COPY package*.json ./

# Installa tutte le dipendenze
RUN npm install

# Copia tutto il progetto
COPY . .

# Crea le directory usate dal server
RUN mkdir -p \
    /app/contratto-ricardiano-api-mock/storage/ricardians \
    /app/contratto-ricardiano-api-mock/storage/cades \
    /app/contratto-ricardiano-api-mock/storage/tmp \
    /app/contratto-ricardiano-api-mock/file-json

EXPOSE 3000

CMD ["node", "contratto-ricardiano-api-mock/server.registerRicardianForest.js"]