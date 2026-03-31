PROCEDURA PER RUNNARE IN LOCALE

APRIRE LE PAGINE DEL TERMINALE QUI: PS C:\progetto-solidity>

PAGINA TERMINALE 1

Step 1: AVVIO DEL SERVER

npx serve

PAGINA TERMINALE 2

Step 2: AVVIO HARDHAT NODE

npx hardhat node

PAGINA TERMINALE 3

Step 3: DEPLOY DEL CONTRATTO DELLE FOREST UNITS

npx hardhat run scripts/ForestTracking.js --network localhost

Step 3b: AVVIO DELLO SCRIPT PER LA SCRITTURA DELLA FOREST UNIT E CALOCLO DEL GAS, ETH E EURO SPESI.

PS C:\progetto-solidity> npx hardhat run scripts/merkle-root-finale.js --network localhost

Step 4: DEPLOY DEL CONTRATTO DEL TRACKING DEI DRONI

PS C:\progetto-solidity> npx hardhat run scripts/DroneTracking.js --network localhost

Step 4b: AVVIO DELLO SCRIPT PER LA SCRITTURA DEL TRACKING DI UN DRONE E CALOCLO DEL GAS, ETH E EURO SPESI.

PS C:\progetto-solidity> npx hardhat run scripts/merkle-root-droni.js --network localhost

COMANDI PER I SERVER PER PROVARE LE RICHIESTE POSTMAN:

PS C:\progetto-solidity\droni-api-mock> node server-droni.js

PS C:\progetto-solidity\forest-api-mock> node server.Forest.js


PROCEDURA PER RUNNARE CON SEPOLIA

APRIRE LE PAGINE DEL TERMINALE QUI: C:\progetto-solidity\contratto-ricardiano-api-mock

PAGINA TERMINALE 1

Step 1: AVVIO DEL SERVER

node .\server.registerRicardianForest.js

PER UPLODARE E FIRMARE IL CONTRATTO RICARDIANO IN FORMATO PDF.P7M

FIRMARE IL FILE CON QUESTO COMANDO: openssl smime -sign -binary -in C:\progetto-solidity\contratto-ricardiano-api-mock\storage\ricardians\ricardian-Vallombrosa.pdf -signer C:\progetto-solidity\contratto-ricardiano-api-mock\storage\ricardians\user-cert.pem -inkey C:\progetto-solidity\contratto-ricardiano-api-mock\storage\ricardians\user-key.pem -certfile C:\progetto-solidity\contratto-ricardiano-api-mock\storage\ricardians\ca-cert.pem -outform DER -out C:\progetto-solidity\contratto-ricardiano-api-mock\storage\ricardians\ricardian-Vallombrosa.pdf.p7m -nodetach

UPLODARE IL FILE NEL BODY DEL POSTMAN

PER USARE IL CONTAINER TRAMITE DOCKER

REQUISITI

Docker

Docker Compose

AVVIO

docker compose up --build

AVVIO IN BACKGROUNG

docker compose up --build -d

ARRESTO

docker compose down
