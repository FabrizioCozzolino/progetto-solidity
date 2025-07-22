
const axios = require("axios");
const hre = require("hardhat");
const { ethers } = require("ethers");
const contractJSON = require("../artifacts/contracts/ForestTracking.sol/ForestTracking.json");

const CONTRACT_ADDRESS = "0x959922bE3CAee4b8Cd9a407cc3ac1C251C2007B1";

const API_URL = "https://pollicino.topview.it:9443/api/get-forest-units/";
const AUTH_TOKEN = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0b2tlbl90eXBlIjoiYWNjZXNzIiwiZXhwIjoxNzUzMTg1MzM0LCJpYXQiOjE3NTMxODE3MzQsImp0aSI6IjlkNjM2MmEwMzE1OTQzZWFhYzM4OWUyNjZiZGI1NTE1IiwidXNlcl9pZCI6MTEwfQ.jVOQvC_hUS30sSROhrdFxcsaTnnPIVYFR7wjocMhEec"; // accorciato per leggibilità

async function main() {
  const signer = (await hre.ethers.getSigners())[0];
  console.log("Using signer address:", await signer.getAddress());

  const contract = new hre.ethers.Contract(
    CONTRACT_ADDRESS,
    contractJSON.abi,
    signer
  );

  let response;
  try {
    response = await axios.get(API_URL, {
      headers: { Authorization: AUTH_TOKEN },
    });
  } catch (error) {
    console.error("❌ Errore chiamata API:", error.response?.data || error.message);
    process.exit(1);
  }

  // DEBUG: stampa la struttura delle forestUnits
  console.log("forestUnits keys:", Object.keys(response.data.forestUnits));

  // Cerca la forest unit 'Vallombrosa' come chiave o come nome
  let forestKey = null;
  // Prima cerca chiave esatta (case-insensitive)
  for (const key of Object.keys(response.data.forestUnits)) {
    if (key.toLowerCase() === "vallombrosa") {
      forestKey = key;
      break;
    }
  }
  // Se non trovata, cerca nel campo name/nome
  if (!forestKey) {
    for (const [key, value] of Object.entries(response.data.forestUnits)) {
      const name = (value.name || value.nome || "").toLowerCase();
      if (name.includes("vallombrosa")) {
        forestKey = key;
        break;
      }
    }
  }
  // Debug: mostra tutte le chiavi e nomi
  if (!forestKey) {
    console.log("⚠️ Nessuna forest unit 'Vallombrosa' trovata. Ecco le chiavi e i nomi disponibili:");
    for (const [key, value] of Object.entries(response.data.forestUnits)) {
      console.log(`- key: ${key}, name: ${value.name || value.nome || ''}`);
    }
    return;
  }

  const forestUnit = response.data.forestUnits[forestKey];
  const treesDict = forestUnit.trees || {};
  const treeKeys = Object.keys(treesDict);
  if (treeKeys.length === 0) {
    console.log(`⚠️ Nessun albero presente nella forest unit '${forestKey}'.`);
    return;
  }

  const batch = [];
  for (const treeId of treeKeys) {
    const tree = treesDict[treeId];
    const epc = tree.domainUUID || tree.domainUuid || treeId;
    if (!epc) {
      console.warn("⚠️ Skippato albero senza domainUUID valido.");
      continue;
    }
    const firstReading = tree.firstReadingTime
      ? Math.floor(new Date(tree.firstReadingTime).getTime() / 1000)
      : 0;
    const treeType = tree.treeType?.specie || "";
    const coordinates = tree.coordinates
      ? `${tree.coordinates.latitude},${tree.coordinates.longitude}`
      : "";
    const observations = tree.notes || "";
    batch.push({
      epc,
      firstReading,
      treeType,
      coordinates,
      observations,
    });
  }

  if (batch.length === 0) {
    console.log("⚠️ Nessun albero valido da inserire.");
    return;
  }

  try {
    const tx = await contract.addTreesBatch(batch);
    const receipt = await tx.wait();
    // Conversione BigNumber -> BigInt per calcoli
    const gasUsed = typeof receipt.gasUsed === 'bigint' ? receipt.gasUsed : receipt.gasUsed.toBigInt();
    const gasPriceRaw = tx.gasPrice || receipt.effectiveGasPrice;
    const gasPrice = typeof gasPriceRaw === 'bigint' ? gasPriceRaw : gasPriceRaw.toBigInt();
    const ethUsed = gasUsed * gasPrice;
    // Conversione in ETH
    const ethUsedFloat = Number(ethUsed) / 1e18;
    // Tasso di cambio ETH/EUR (puoi aggiornarlo manualmente o recuperarlo da un'API)
    const ETH_EUR = 3120.42; // esempio, aggiorna con il valore attuale
    const euro = ethUsedFloat * ETH_EUR;
    // Simulazione mainnet: gas price tipico 50 gwei, cambio ETH/EUR aggiornato
    const MAINNET_GAS_PRICE_GWEI = 50;
    const MAINNET_ETH_EUR = 3120.42; // aggiorna se vuoi
    const mainnetEthUsed = Number(gasUsed) * MAINNET_GAS_PRICE_GWEI * 1e-9; // ETH
    const mainnetEuro = mainnetEthUsed * MAINNET_ETH_EUR;
    console.log(`✅ Batch registrato con successo. Totale alberi: ${batch.length}`);
    console.log(`Gas usato: ${gasUsed.toString()}`);
    console.log(`Gas price (rete attuale): ${ethers.formatUnits(gasPrice.toString(), 'gwei')} gwei`);
    console.log(`Costo totale (rete attuale): ${ethUsedFloat} ETH ≈ €${euro.toFixed(2)}`);
    console.log(`--- Simulazione Ethereum mainnet ---`);
    console.log(`Gas price mainnet simulato: ${MAINNET_GAS_PRICE_GWEI} gwei`);
    console.log(`Costo stimato mainnet: ${mainnetEthUsed} ETH ≈ €${mainnetEuro.toFixed(2)}`);
  } catch (err) {
    console.error("❌ Errore durante il batch insert:", err.message);
  }
}

main().catch((err) => {
  console.error("❌ Errore nello script:", err);
  process.exit(1);
});
