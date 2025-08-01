require("dotenv").config({ path: "./test.env" });
const hre = require("hardhat");
const { formatEther } = require("ethers");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { MerkleTree } = require("merkletreejs");
const keccak256 = require("keccak256");
const crypto = require("crypto");

const deployedPath = path.join(__dirname, "../deployed.json");
const deployed = JSON.parse(fs.readFileSync(deployedPath));
const CONTRACT_ADDRESS = deployed.Bitacora || deployed.address;

const API_BASE_URL = "http://51.91.111.200:3000";
const AUTH_TOKEN = process.env.AUTH_TOKEN;
let DEVICE_ID = process.env.DEVICE_ID || "";
const DATASET_IDS = (process.env.DATASET_IDS || "").split(",").map(d => d.trim()).filter(Boolean);
const PK = process.env.PK || "";

// Funzione per generare pk casuale esadecimale 64 caratteri
function generateRandomPk() {
  return "0x" + crypto.randomBytes(64).toString("hex");
}

// Nuova createDevice con retry e pk casuale
async function createDevice() {
  const fullPk = PK.startsWith("0x") ? PK : "0x" + PK;
  try {
    const res = await axios.post(
      `${API_BASE_URL}/device`,
      { pk: fullPk },
      { headers: { Authorization: `Bearer ${AUTH_TOKEN}` }, timeout: 10000 }
    );
    console.log("✅ Device creato via API, risposta completa:", res.data);

    const deviceId = res.data.id || res.data.device_id || null;
    if (!deviceId) {
      console.warn("⚠️ Attenzione: non è stato trovato un 'id' device valido nella risposta.");
      console.warn("Risposta API:", res.data);
      process.exit(1);
    }

    console.log("ℹ️ Device ID estratto dalla risposta:", deviceId);
    return deviceId;

  } catch (e) {
    if (e.response?.data?.code === 1001) {
      console.warn("⚠️ Device già esistente con questa pk. Inserisci DEVICE_ID corretto in .env per continuare.");
      process.exit(1);
    } else {
      console.error("❌ Errore creazione device via API:", e.response?.data || e.message);
      process.exit(1);
    }
  }
}

// Funzione per ottenere dettagli device via API GET
async function getDevice(deviceId) {
  try {
    const res = await axios.get(`${API_BASE_URL}/device/${encodeURIComponent(deviceId)}`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      timeout: 10000,
    });
    console.log(`✅ Dettagli device recuperati via GET:`, res.data);
    return res.data;
  } catch (e) {
    console.error(`❌ Errore recupero device via GET:`, e.response?.data || e.message);
    return null;
  }
}

async function getDatasetForDevice(deviceId) {
  const datasetId = `${deviceId}:2`;
  try {
    const res = await axios.get(`${API_BASE_URL}/dataset/${encodeURIComponent(datasetId)}?end=false`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      timeout: 10000,
    });
    console.log(`✅ Dataset per device ${deviceId} recuperato:`, res.data);
    return [datasetId]; // ritorna un array con un solo dataset ID
  } catch (e) {
    console.error(`❌ Errore recupero dataset per device ${deviceId}:`, e.response?.data || e.message);
    return [];
  }
}

// Funzione per recuperare device da PK
async function listDevicesByPk(pk) {
  try {
    const fullPk = pk.startsWith("0x") ? pk : "0x" + pk;
    const res = await axios.get(`${API_BASE_URL}/device?pk=${encodeURIComponent(fullPk)}`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      timeout: 10000
    });
    if (Array.isArray(res.data) && res.data.length > 0) {
      return res.data[0].id;
    }
  } catch (e) {
    console.error("❌ Errore nel recupero device esistente:", e.response?.data || e.message);
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
        if (typeof ds === "string") {
          console.log(`  ${idx + 1}. ${ds}`);
        } else if (ds.id) {
          console.log(`  ${idx + 1}. ${ds.id}`);
        } else {
          console.log(`  ${idx + 1}.`, ds);
        }
      });
      return response.data.map(d => (typeof d === "string" ? d : d.id));
    } else {
      console.log("ℹ️ Risposta API non è un array, contenuto:", response.data);
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
    if (res.data.devices && Array.isArray(res.data.devices) && res.data.devices.length > 0) {
      console.log(`✅ Device trovati nel dataset ${datasetId}:`, res.data.devices.map(d => d.id || d));
      return res.data.devices.map(d => (typeof d === "string" ? d : d.id));
    } else {
      console.warn(`⚠️ Nessun device trovato nel dataset ${datasetId}`);
      return [];
    }
  } catch (e) {
    console.error(`❌ Errore fetch device da dataset ${datasetId}:`, e.response?.data || e.message);
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

async function createFlightData(deviceId, timestamp = 20) {
  try {
    const res = await axios.post(
      `${API_BASE_URL}/flight_data`,
      {
        device_id: deviceId,
        timestamp,
        signature: "Fg6tt7UKb==",
        localization: {
          longitude: 42.45323,
          latitude: -150.4774,
        },
        payload: "cGF5bG9hZA==", // "payload" in base64
        signature_full: "8JK9u54=",
      },
      {
        headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
        timeout: 10000,
      }
    );

    console.log("✅ Flight data creato con successo:", res.data);
    return res.data;

  } catch (e) {
    console.error("❌ Errore creazione flight data:", e.response?.data || e.message);
    return null;
  }
}


async function fetchFlightData(deviceId) {
  try {
    const url = `${API_BASE_URL}/flight_data/${encodeURIComponent(deviceId)}`;
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      timeout: 10000,
    });
    console.log(`✅ Flight data recuperati per device ${deviceId}:`, response.data);
    return response.data;
  } catch (e) {
    console.error(`❌ Errore recupero flight data ${deviceId}:`, e.response?.status, e.response?.data || e.message);
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
    console.error(`❌ Errore fetch flight data dal dataset ${datasetId}:`, e.response?.data || e.message);
    return null;
  }
}


function hashFlightData(fd) {
  const deviceId = fd.device_id || "";
  const timestamp = fd.timestamp || 0;
  const lat = fd.localization?.latitude ?? 0;
  const lon = fd.localization?.longitude ?? 0;
  const signature = fd.signature || "";
  const concatStr = `${deviceId}|${timestamp}|${lat}|${lon}|${signature}`;
  return keccak256(concatStr);
}

async function getEthPriceInEuro() {
  try {
    const res = await axios.get("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=eur");
    return res.data.ethereum.eur;
  } catch {
    console.warn("⚠️ Errore recupero ETH/EUR, uso default 3000");
    return 3000;
  }
}

// Nuova funzione per gestire DEVICE_ID da PK o creazione
async function getOrCreateDevice() {
  if (DEVICE_ID) {
    console.log(`ℹ️ DEVICE_ID trovato in env: ${DEVICE_ID}`);
    return DEVICE_ID;
  }
  if (!PK) {
    console.error("❌ PK non impostata in env, impossibile procedere.");
    process.exit(1);
  }
  console.log("ℹ️ DEVICE_ID non impostato, provo a recuperarlo tramite PK...");

  let deviceId = null;
  deviceId = await listDevicesByPk(PK);
  if (deviceId) {
    console.log(`✅ Device trovato via PK, DEVICE_ID: ${deviceId}`);
    return deviceId;
  }

  console.log("ℹ️ Device con questa pk non trovato, provo a crearlo...");
  return await createDevice();
}

async function main() {
  DEVICE_ID = await getOrCreateDevice();

  let datasets = DATASET_IDS;

  if (datasets.length === 0) {
    console.log("ℹ️ Nessun DATASET_ID in env, recupero dataset per DEVICE_ID...");
    datasets = await getDatasetForDevice(DEVICE_ID);
    if (datasets.length === 0) {
      console.error("❌ Nessun dataset disponibile per device, esco.");
      process.exit(1);
    }
  }

  const signer = (await hre.ethers.getSigners())[0];
  const contractJson = require("../artifacts/contracts/DroneTracking.sol/Bitacora.json");
  const contract = new hre.ethers.Contract(CONTRACT_ADDRESS, contractJson.abi, signer);

  const ethPrice = await getEthPriceInEuro();

  for (const DATASET_ID of datasets) {
  console.log(`\n📁 Elaborazione dataset: ${DATASET_ID}`);

  const usedDeviceId = DEVICE_ID;

  const exists = await checkDeviceExists(contract, usedDeviceId);
  if (exists) {
    console.log(`✅ Device ${usedDeviceId} già registrato on-chain.`);
  } else {
    const fullPk = "3d888e8be9907d60c8a21e84e20cb72659a77caafe6165be39fe730a44465d8130942563edd89e0cf9ecea2b6ab6e475502264e042dcac3b301d4268f89f3b38";
    const pk32 = fullPk.slice(0, 64);
    const pkBytes32 = "0x" + pk32;
    try {
      const tx = await contract.registerDevice(usedDeviceId, pkBytes32);
      const receipt = await tx.wait();
      console.log("✅ Device registrato on-chain con chiave (32 byte), tx hash:", receipt.transactionHash);
    } catch (e) {
      console.error("❌ Errore registrazione device on-chain:", e.error?.message || e.message);
      continue;
    }
  }

  await createFlightData(usedDeviceId);
  const flightDatas = await fetchFlightDatasFromDataset(DATASET_ID);
  if (!flightDatas || flightDatas.length === 0) {
    console.error(`❌ Nessun flight_data per device ${usedDeviceId} nel dataset ${DATASET_ID}, salto.`);
    continue;
  }

    flightDatas.forEach(fd => {
      if (!fd.device_id) fd.device_id = usedDeviceId;
    });

    const leaves = flightDatas.map(hashFlightData);
    const merkleTree = new MerkleTree(leaves, keccak256, { sortPairs: true });
    const root = merkleTree.getHexRoot();

    const gasEstimate = await hre.ethers.provider.estimateGas({
  to: CONTRACT_ADDRESS,
  data: contract.interface.encodeFunctionData("registerDataset", [DATASET_ID, usedDeviceId, root]),
  from: await signer.getAddress(),
});

const feeData = await hre.ethers.provider.getFeeData();
const gasPrice = feeData.gasPrice ?? 1n; // fallback di sicurezza

const gasCostWei = gasEstimate * gasPrice;
const gasCostEth = Number(formatEther(gasCostWei.toString())); // perché formatEther vuole una stringa in ethers 6



    console.log(`🧩 Merkle Root: ${root}`);
    console.log(`⛽ Gas stimato: ${gasEstimate.toString()}`);
    console.log(`💸 Costo stimato: ${gasCostEth.toFixed(6)} ETH ≈ €${(gasCostEth * ethPrice).toFixed(2)}`);

    const outputDir = path.join(__dirname, "..", "file-json", usedDeviceId);

// Assicuro che tutta la cartella esista, con recursive
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

const safeFilename = `${DATASET_ID}-${usedDeviceId}-batch.json`.replace(/[:]/g, "_");

const fullPath = path.join(outputDir, safeFilename);

console.log("ℹ️ Salvo batch JSON in:", fullPath);

fs.writeFileSync(
  fullPath,
  JSON.stringify(flightDatas, null, 2)
);

console.log(`💾 Salvato batch JSON: ${path.join(usedDeviceId, safeFilename)}`);



    try {
      const tx = await contract.registerDataset(DATASET_ID, usedDeviceId, root);
      const receipt = await tx.wait();
      console.log(`✅ Dataset registrato on-chain. Tx hash: ${receipt.transactionHash}`);
    } catch (e) {
      console.error("❌ Errore registrazione on-chain:", e.error?.message || e.message);
    }

    const testLeaf = leaves[0];
    const proof = merkleTree.getHexProof(testLeaf);
    const isValid = merkleTree.verify(proof, testLeaf, root);
    console.log(`🔍 Proof valida? ${isValid}`);
  }
}

main().catch(e => {
  console.error("❌ Errore generale:", e);
  process.exit(1);
});
