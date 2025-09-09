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
