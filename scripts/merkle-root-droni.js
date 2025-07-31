require("dotenv").config({ path: "./test.env" });
const hre = require("hardhat");
const { formatEther } = require("ethers");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { MerkleTree } = require("merkletreejs");
const keccak256 = require("keccak256");

const deployedPath = path.join(__dirname, "../deployed.json");
const deployed = JSON.parse(fs.readFileSync(deployedPath));
const CONTRACT_ADDRESS = deployed.Bitacora || deployed.address;

const API_BASE_URL = "http://51.91.111.200:3000";
const AUTH_TOKEN = process.env.AUTH_TOKEN;
let DEVICE_ID = process.env.DEVICE_ID || "";
const DATASET_IDS = (process.env.DATASET_IDS || "").split(",").map(d => d.trim()).filter(Boolean);

async function createDevice() {
  // Usa una pk fissa o generane una random, qui fissa per comodità
  const fullPk = "3d888e8be9907d60c8a21e84e20cb72659a77caafe6165be39fe730a44465d8130942563edd89e0cf9ecea2b6ab6e475502264e042dcac3b301d4268f89f3b38";
  try {
    const res = await axios.post(
      `${API_BASE_URL}/device`,
      { pk: fullPk },
      { headers: { Authorization: `Bearer ${AUTH_TOKEN}` }, timeout: 10000 }
    );
    console.log("✅ Device creato via API:", res.data);
    return res.data.device_id || res.data.id || res.data; // adattare in base alla risposta API
  } catch (e) {
    console.error("❌ Errore creazione device via API:", e.response?.data || e.message);
    return null;
  }
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

async function main() {
  // Se DEVICE_ID non impostato, crealo
  if (!DEVICE_ID) {
    console.log("ℹ️ DEVICE_ID non impostato, creo device via API...");
    const newDeviceId = await createDevice();
    if (!newDeviceId) {
      console.error("❌ Non è stato possibile creare il device, esco.");
      process.exit(1);
    }
    DEVICE_ID = newDeviceId;
    console.log(`ℹ️ Nuovo DEVICE_ID creato: ${DEVICE_ID}`);
  }

  // Se non hai dataset in env, listali tutti e usa i primi 1-2 di default
  let datasets = DATASET_IDS;
  if (datasets.length === 0) {
    console.log("ℹ️ Nessun DATASET_ID in env, recupero lista da API...");
    datasets = await listDatasets();
    if (datasets.length === 0) {
      console.error("❌ Nessun dataset disponibile, esco.");
      process.exit(1);
    }
    // Prendi al massimo 2 dataset per sicurezza
    datasets = datasets.slice(0, 2);
  }

  const signer = (await hre.ethers.getSigners())[0];
  const contractJson = require("../artifacts/contracts/DroneTracking.sol/Bitacora.json");
  const contract = new hre.ethers.Contract(CONTRACT_ADDRESS, contractJson.abi, signer);

  const ethPrice = await getEthPriceInEuro();

  for (const DATASET_ID of datasets) {
    console.log(`\n📁 Elaborazione dataset: ${DATASET_ID}`);

    // Prendi devices dal dataset
    const devices = await fetchDevicesFromDataset(DATASET_ID);
    if (devices.length === 0) {
      console.warn(`⚠️ Nessun device nel dataset ${DATASET_ID}, ma usiamo DEVICE_ID creato o impostato: ${DEVICE_ID}`);
    }

    // Usa DEVICE_ID creato o primo device dataset (se presente)
    const usedDeviceId = devices.length > 0 ? devices[0] : DEVICE_ID;

    // Controlla se device registrato on-chain
    const exists = await checkDeviceExists(contract, usedDeviceId);
    if (exists) {
      console.log(`✅ Device ${usedDeviceId} già registrato on-chain.`);
    } else {
      // Registra device on-chain con chiave pk32 fissa (puoi cambiare se vuoi)
      const fullPk = "3d888e8be9907d60c8a21e84e20cb72659a77caafe6165be39fe730a44465d8130942563edd89e0cf9ecea2b6ab6e475502264e042dcac3b301d4268f89f3b38";
      const pk32 = fullPk.slice(0, 64);
      const pkBytes32 = "0x" + pk32;
      try {
        const tx = await contract.registerDevice(usedDeviceId, pkBytes32);
        const receipt = await tx.wait();
        console.log("✅ Device registrato on-chain con chiave (32 byte), tx hash:", receipt.transactionHash);
      } catch (e) {
        console.error("❌ Errore registrazione device on-chain:", e.error?.message || e.message);
        continue; // passa al prossimo dataset
      }
    }

    // Prendi flight data per device
    const flightDatas = await fetchFlightData(usedDeviceId);
    if (!flightDatas || flightDatas.length === 0) {
      console.error(`❌ Nessun flight_data per device ${usedDeviceId} nel dataset ${DATASET_ID}, salto.`);
      continue;
    }

    // Assicura che ogni record abbia device_id
    flightDatas.forEach(fd => {
      if (!fd.device_id) fd.device_id = usedDeviceId;
    });

    // Merkle tree
    const leaves = flightDatas.map(hashFlightData);
    const merkleTree = new MerkleTree(leaves, keccak256, { sortPairs: true });
    const root = merkleTree.getHexRoot();

    const gasEstimate = await hre.ethers.provider.estimateGas({
      to: CONTRACT_ADDRESS,
      data: contract.interface.encodeFunctionData("registerDataset", [DATASET_ID, usedDeviceId, root]),
      from: await signer.getAddress(),
    });

    const feeData = await hre.ethers.provider.getFeeData();
    const gasCostWei = gasEstimate.mul(feeData.gasPrice);
    const gasCostEth = Number(formatEther(gasCostWei));

    console.log(`🧩 Merkle Root: ${root}`);
    console.log(`⛽ Gas stimato: ${gasEstimate.toString()}`);
    console.log(`💸 Costo stimato: ${gasCostEth.toFixed(6)} ETH ≈ €${(gasCostEth * ethPrice).toFixed(2)}`);

    // Salva batch json
    const outputDir = path.join(__dirname, "..", "file-json");
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

    fs.writeFileSync(
      path.join(outputDir, `${DATASET_ID}-${usedDeviceId}-batch.json`),
      JSON.stringify(flightDatas, null, 2)
    );
    console.log(`💾 Salvato batch JSON: ${DATASET_ID}-${usedDeviceId}-batch.json`);

    try {
      const tx = await contract.registerDataset(DATASET_ID, usedDeviceId, root);
      const receipt = await tx.wait();
      console.log(`✅ Dataset registrato on-chain. Tx hash: ${receipt.transactionHash}`);
    } catch (e) {
      console.error("❌ Errore registrazione on-chain:", e.error?.message || e.message);
    }

    // Verifica prova Merkle
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
