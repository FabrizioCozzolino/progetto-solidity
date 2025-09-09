require("dotenv").config({ path: "./test.env" });

const hre = require("hardhat");
const { formatEther } = require("ethers");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { MerkleTree } = require("merkletreejs");
const keccak256 = require("keccak256");
const crypto = require("crypto");

// --- Percorsi e variabili principali ---
const envPath = path.join(__dirname, "../test.env");
let PK = process.env.PK || "";
const deployedPath = path.join(__dirname, "../deployed.json");
const deployed = JSON.parse(fs.readFileSync(deployedPath));
const CONTRACT_ADDRESS = deployed.Bitacora || deployed.address;
const API_BASE_URL = "http://51.91.111.200:3000";
const AUTH_TOKEN = process.env.AUTH_TOKEN;
let DEVICE_ID = process.env.DEVICE_ID || "";
const DATASET_IDS = (process.env.DATASET_IDS || "")
  .split(",")
  .map(d => d.trim())
  .filter(Boolean);

// --- Funzioni utilitarie ---

// Genera una pk casuale esadecimale (64 caratteri)
function generateRandomPk() {
  return crypto.randomBytes(64).toString("hex");
}

// Genera una pk 64 byte con 0x davanti
function generateRandomPk64() {
  return "0x" + crypto.randomBytes(64).toString("hex");
}

// Salva PK generata in test.env se mancante
if (!PK) {
  PK = generateRandomPk();
  console.log("⚠️ PK non trovata, ne genero una nuova...");

  let envContent = "";
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, "utf8");
  }
  envContent += `\nPK=${PK}\n`;

  console.log("✅ Nuova PK salvata in test.env:", PK);
}

// --- Funzioni API ---

async function createDevice() {
  const fullPk = PK.startsWith("0x") ? PK : "0x" + PK;
  try {
    const res = await axios.post(
      `${API_BASE_URL}/device`,
      { pk: fullPk },
      { headers: { Authorization: `Bearer ${AUTH_TOKEN}` }, timeout: 30000 }
    );
    console.log("✅ Device creato via API, risposta completa:", res.data);

    const deviceId = res.data.id || res.data.device_id || null;
    if (!deviceId) {
      console.warn("⚠️ Nessun 'id' device trovato nella risposta.");
      console.warn("Risposta API:", res.data);
      process.exit(1);
    }

    console.log("ℹ️ Device ID estratto:", deviceId);
    return deviceId;
  } catch (e) {
    if (e.response?.data?.code === 1001) {
      console.warn("⚠️ Device già esistente con questa PK. Inserisci DEVICE_ID corretto in .env.");
      process.exit(1);
    } else {
      console.error("❌ Errore creazione device via API:", e.response?.data || e.message);
      process.exit(1);
    }
  }
}

async function getDevice(deviceId) {
  try {
    const res = await axios.get(`${API_BASE_URL}/device/${encodeURIComponent(deviceId)}`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      timeout: 30000,
    });
    console.log(`✅ Dettagli device recuperati:`, res.data);
    return res.data;
  } catch (e) {
    console.error("❌ Errore recupero device:", e.response?.data || e.message);
    return null;
  }
}

async function getDatasetForDevice(deviceId) {
  try {
    const res = await axios.get(`${API_BASE_URL}/dataset?device_id=${encodeURIComponent(deviceId)}`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      timeout: 10000,
    });

    if (Array.isArray(res.data) && res.data.length > 0) {
      console.log(`✅ Dataset esistente per device ${deviceId}:`, res.data.map(d => d.id || d));
      return res.data.map(d => d.id || d);
    }

    console.log(`⚠️ Nessun dataset trovato per ${deviceId}, ne creo uno nuovo...`);
    const newDs = await axios.post(
      `${API_BASE_URL}/dataset`,
      { device_id: deviceId, name: "flight_data", description: "Dataset creato automaticamente" },
      { headers: { Authorization: `Bearer ${AUTH_TOKEN}` }, timeout: 10000 }
    );

    const newDatasetId = newDs.data.id;
    console.log("✅ Dataset creato:", newDatasetId);
    await createFlightData(deviceId);

    return [newDatasetId];
  } catch (e) {
    console.error("❌ Errore gestione dataset:", e.response?.data || e.message);
    return [];
  }
}

async function listDevicesByPk(pk) {
  try {
    const fullPk = pk.startsWith("0x") ? pk : "0x" + pk;
    const res = await axios.get(`${API_BASE_URL}/device?pk=${encodeURIComponent(fullPk)}`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      timeout: 10000
    });
    if (Array.isArray(res.data) && res.data.length > 0) return res.data[0].id;
  } catch (e) {
    console.error("❌ Errore recupero device esistente:", e.response?.data || e.message);
  }
  return null;
}

async function listDatasets() {
  try {
    const response = await axios.get(`${API_BASE_URL}/dataset`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      timeout: 10000,
    });
    if (Array.isArray(response.data)) {
      console.log("✅ Lista dataset disponibili:");
      response.data.forEach((ds, idx) => {
        console.log(`  ${idx + 1}. ${typeof ds === "string" ? ds : ds.id || JSON.stringify(ds)}`);
      });
      return response.data.map(d => (typeof d === "string" ? d : d.id));
    } else {
      console.log("ℹ️ Risposta API non è un array:", response.data);
      return [];
    }
  } catch (e) {
    console.error("❌ Errore chiamata API:", e.response?.data || e.message);
    return [];
  }
}

async function fetchDevicesFromDataset(datasetId) {
  try {
    const res = await axios.get(`${API_BASE_URL}/dataset/${datasetId}`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      timeout: 10000,
    });
    if (res.data.devices?.length > 0) {
      console.log(`✅ Device trovati nel dataset ${datasetId}:`, res.data.devices.map(d => d.id || d));
      return res.data.devices.map(d => d.id || d);
    }
    console.warn(`⚠️ Nessun device trovato nel dataset ${datasetId}`);
    return [];
  } catch (e) {
    console.error("❌ Errore fetch device da dataset:", e.response?.data || e.message);
    return [];
  }
}

async function checkDeviceExists(contract, deviceId) {
  try {
    await contract.getDevice(deviceId);
    return true;
  } catch {
    return false;
  }
}

// --- Flight data ---
async function createFlightData(deviceId, timestamp = 20) {
  try {
    const res = await axios.post(
      `${API_BASE_URL}/flight_data`,
      {
        device_id: deviceId,
        timestamp,
        signature: "Fg6tt7UKb==",
        localization: { longitude: 42.45323, latitude: -150.4774 },
        payload: "cGF5bG9hZA==",
        signature_full: "8JK9u54=",
      },
      { headers: { Authorization: `Bearer ${AUTH_TOKEN}` }, timeout: 10000 }
    );
    console.log("✅ Flight data creato:", res.data);
    return res.data;
  } catch (e) {
    console.error("❌ Errore creazione flight data:", e.response?.data || e.message);
    return null;
  }
}

async function fetchFlightDatasFromDataset(datasetId) {
  try {
    const res = await axios.get(`${API_BASE_URL}/dataset/${encodeURIComponent(datasetId)}/flight_datas`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      timeout: 10000
    });
    console.log(`✅ Flight data ottenuti per dataset ${datasetId}:`, res.data);
    return res.data;
  } catch (e) {
    console.error("❌ Errore fetch flight data:", e.response?.data || e.message);
    return null;
  }
}

function hashFlightData(fd) {
  const deviceId = fd.device_id || "";
  const timestamp = fd.timestamp || 0;
  const lat = fd.localization?.latitude ?? 0;
  const lon = fd.localization?.longitude ?? 0;
  const signature = fd.signature || "";
  return keccak256(`${deviceId}|${timestamp}|${lat}|${lon}|${signature}`);
}

// --- ETH ---
async function getEthPriceInEuro() {
  try {
    const res = await axios.get("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=eur");
    return res.data.ethereum.eur;
  } catch {
    console.warn("⚠️ Errore recupero ETH/EUR, uso default 3000");
    return 3000;
  }
}

// --- DEVICE ID ---
// Versione semplificata per evitare la GET fallita con 405
async function getOrCreateDevice() {
  if (DEVICE_ID) {
    console.log(`ℹ️ DEVICE_ID trovato in env: ${DEVICE_ID}`);
    return DEVICE_ID;
  }

  if (!PK) {
    console.error("❌ PK non impostata, impossibile procedere.");
    process.exit(1);
  }

  console.log("ℹ️ DEVICE_ID non impostato, provo a crearlo...");

  try {
    return await createDevice();
  } catch (e) {
    if (e.response?.data?.code === 1001) {
      console.warn("⚠️ Device già esistente con questa PK. Devi inserire il DEVICE_ID corretto in test.env per continuare.");
      process.exit(1);
    } else {
      console.error("❌ Errore creazione device:", e.response?.data || e.message);
      process.exit(1);
    }
  }
}

// --- EXPORT ---
module.exports = {
  getOrCreateDevice,
  getDevice,
  getDatasetForDevice,
  createFlightData,
  fetchFlightDatasFromDataset,
  hashFlightData,
  PK,
  CONTRACT_ADDRESS,
  getEthPriceInEuro,
  checkDeviceExists
};


// --- MAIN aggiornato secondo il flusso ---
async function main() {
  // 1) Creazione o recupero device
  DEVICE_ID = await getOrCreateDevice();

  // 2) Recupero dettagli device
  const deviceDetails = await getDevice(DEVICE_ID);

  // 3) Inserimento flight data (almeno uno)
  const flightData = await createFlightData(DEVICE_ID);

  if (!flightData?.dataset_id) {
    console.error("❌ Impossibile ottenere dataset_id dal flight_data, esco.");
    process.exit(1);
  }

  const DATASET_ID = flightData.dataset_id;
  console.log(`ℹ️ Dataset disponibile: ${DATASET_ID}`);

  const signer = (await hre.ethers.getSigners())[0];
  const contractJson = require("../artifacts/contracts/DroneTracking.sol/Bitacora.json");
  const contract = new hre.ethers.Contract(CONTRACT_ADDRESS, contractJson.abi, signer);
  const ethPrice = await getEthPriceInEuro();

  // 4) Verifica se il device è registrato on-chain
  const exists = await checkDeviceExists(contract, DEVICE_ID);
  if (!exists) {
    const fullPk = PK.startsWith("0x") ? PK : "0x" + PK;
    const pk32 = fullPk.slice(2, 66);
    const pkBytes32 = "0x" + pk32;
    try {
      const tx = await contract.registerDevice(DEVICE_ID, pkBytes32);
      const receipt = await tx.wait();
      console.log("✅ Device registrato on-chain, tx hash:", receipt.transactionHash);
    } catch (e) {
      console.error("❌ Errore registrazione device on-chain:", e.error?.message || e.message);
      process.exit(1);
    }
  } else {
    console.log(`✅ Device ${DEVICE_ID} già registrato on-chain.`);
  }

  // 5) Recupero flight data dal dataset
  const flightDatas = await fetchFlightDatasFromDataset(DATASET_ID);
  if (!flightDatas?.length) {
    console.error(`❌ Nessun flight_data per device ${DEVICE_ID}, esco.`);
    process.exit(1);
  }

  // Assicura che ogni flight_data abbia device_id
  flightDatas.forEach(fd => { if (!fd.device_id) fd.device_id = DEVICE_ID; });

  // 6) Calcolo Merkle root
  const leaves = flightDatas.map(hashFlightData);
  const merkleTree = new MerkleTree(leaves, keccak256, { sortPairs: true });
  const root = merkleTree.getHexRoot();

  // 7) Stima gas
  const gasEstimate = await hre.ethers.provider.estimateGas({
    to: CONTRACT_ADDRESS,
    data: contract.interface.encodeFunctionData("registerDataset", [DATASET_ID, DEVICE_ID, root]),
    from: await signer.getAddress(),
  });
  const feeData = await hre.ethers.provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? 1n;
  const gasCostEth = Number(formatEther(gasEstimate * gasPrice));

  console.log(`🧩 Merkle Root: ${root}`);
  console.log(`⛽ Gas stimato: ${gasEstimate.toString()}`);
  console.log(`💸 Costo stimato: ${gasCostEth.toFixed(6)} ETH ≈ €${(gasCostEth * ethPrice).toFixed(2)}`);

  // 8) Salvataggio batch JSON
  const outputDir = path.join(__dirname, "..", "file-json", DEVICE_ID);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const safeFilename = `${DATASET_ID}-${DEVICE_ID}-batch.json`.replace(/[:]/g, "_");
  const fullPath = path.join(outputDir, safeFilename);
  fs.writeFileSync(fullPath, JSON.stringify(flightDatas, null, 2));
  console.log(`💾 Salvato batch JSON: ${path.join(DEVICE_ID, safeFilename)}`);

  // 9) Registrazione dataset on-chain
  try {
    const tx = await contract.registerDataset(DATASET_ID, DEVICE_ID, root);
    const receipt = await tx.wait();
    console.log(`✅ Dataset registrato on-chain. Tx hash: ${receipt.transactionHash}`);
  } catch (e) {
    console.error("❌ Errore registrazione on-chain:", e.error?.message || e.message);
  }

  // 10) Verifica Merkle proof
  const testLeaf = leaves[0];
  const proof = merkleTree.getHexProof(testLeaf);
  const isValid = merkleTree.verify(proof, testLeaf, root);
  console.log(`🔍 Proof valida? ${isValid}`);
}



main().catch(e => {
  console.error("❌ Errore generale:", e);
  process.exit(1);
});
