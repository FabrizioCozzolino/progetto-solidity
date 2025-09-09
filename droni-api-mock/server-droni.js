require("dotenv").config({ path: "./test.env" });
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const hre = require("hardhat");
const { formatEther } = require("ethers");
const fs = require("fs");
const path = require("path");
const { MerkleTree } = require("merkletreejs");
const keccak256 = require("keccak256");

// Funzioni principali dal tuo script
const {
  getOrCreateDevice,
  getDevice,
  getDatasetForDevice,
  hashFlightData,
  PK,
  CONTRACT_ADDRESS,
  getEthPriceInEuro,
  checkDeviceExists
} = require("../scripts/merkle-root-droni");

const app = express();
const port = 3000;

app.use(cors());
app.use(bodyParser.json());

// --- Configurazione ---
const FLIGHT_DATAS_PER_DATASET = 5; // Numero di flight data automatici per dataset

// --- Funzione per generare flight data casuali ---
function generateFlightData(deviceId, datasetId) {
  return {
    device_id: deviceId,
    dataset_id: datasetId,
    timestamp: Math.floor(Date.now() / 1000),
    localization: {
      latitude: (Math.random() * 180 - 90).toFixed(6),
      longitude: (Math.random() * 360 - 180).toFixed(6)
    },
    payload: JSON.stringify({ info: "flight sample", random: Math.floor(Math.random() * 1000) })
  };
}

// --- 1) Init Device On-Chain (tutto automatico) ---
app.post("/init-device-onchain", async (req, res) => {
  try {
    const deviceId = await getOrCreateDevice();
    const deviceDetails = await getDevice(deviceId);
    let datasetIds = await getDatasetForDevice(deviceId);

    // Crea un dataset automatico se non esiste
    if (!datasetIds || datasetIds.length === 0) {
      const datasetId = "dataset_" + Date.now();
      const datasetDir = path.join(__dirname, "..", "file-json", deviceId, "datasets");
      if (!fs.existsSync(datasetDir)) fs.mkdirSync(datasetDir, { recursive: true });
      fs.writeFileSync(path.join(datasetDir, `${datasetId}.json`), JSON.stringify({
        datasetId,
        device_id: deviceId,
        name: "Automatic Dataset",
        description: "Generated automatically"
      }, null, 2));
      datasetIds = [datasetId];
    }

    const allDatasetsInfo = [];

    for (const DATASET_ID of datasetIds) {
      const flightDatas = [];
      for (let i = 0; i < FLIGHT_DATAS_PER_DATASET; i++) {
        flightDatas.push(generateFlightData(deviceId, DATASET_ID));
      }

      // Salva flight data
      const flightDir = path.join(__dirname, "..", "file-json", deviceId, "datasets", DATASET_ID, "flight_datas");
      if (!fs.existsSync(flightDir)) fs.mkdirSync(flightDir, { recursive: true });
      flightDatas.forEach(fd => {
        const flightFile = path.join(flightDir, `${fd.dataset_id}_${Date.now()}_${Math.floor(Math.random() * 10000)}.json`);
        fs.writeFileSync(flightFile, JSON.stringify(fd, null, 2));
      });

      // Calcola Merkle root
      const leaves = flightDatas.map(hashFlightData);
      const merkleTree = new MerkleTree(leaves, keccak256, { sortPairs: true });
      const root = merkleTree.getHexRoot();

      // Salva batch JSON
      const outputDir = path.join(__dirname, "..", "file-json", deviceId);
      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
      const safeFilename = `${DATASET_ID}-${deviceId}-batch.json`.replace(/[:]/g, "_");
      fs.writeFileSync(path.join(outputDir, safeFilename), JSON.stringify(flightDatas, null, 2));

      // Smart contract
      const signer = (await hre.ethers.getSigners())[0];
      const contractJson = require("../artifacts/contracts/DroneTracking.sol/Bitacora.json");
      const contract = new hre.ethers.Contract(CONTRACT_ADDRESS, contractJson.abi, signer);

      const deviceExists = await checkDeviceExists(contract, deviceId);
      if (!deviceExists) {
        const fullPk = PK.startsWith("0x") ? PK : "0x" + PK;
        const pk32 = fullPk.slice(2, 66);
        const pkBytes32 = "0x" + pk32;
        const txDevice = await contract.registerDevice(deviceId, pkBytes32);
        await txDevice.wait();
      }

      const txDataset = await contract.registerDataset(DATASET_ID, deviceId, root);
      const receiptDataset = await txDataset.wait();

      const ethPrice = await getEthPriceInEuro();
      const gasEstimate = await hre.ethers.provider.estimateGas({
        to: CONTRACT_ADDRESS,
        data: contract.interface.encodeFunctionData("registerDataset", [DATASET_ID, deviceId, root]),
        from: await signer.getAddress(),
      });
      const feeData = await hre.ethers.provider.getFeeData();
      const gasPrice = feeData.gasPrice ?? 1n;
      const gasCostEth = Number(formatEther(gasEstimate * gasPrice));

      const testLeaf = leaves[0];
      const proof = merkleTree.getHexProof(testLeaf);
      const isValid = merkleTree.verify(proof, testLeaf, root);

      allDatasetsInfo.push({
        datasetId: DATASET_ID,
        flightData: flightDatas,
        merkleRoot: root,
        batchFile: path.join(deviceId, safeFilename),
        txHash: receiptDataset.transactionHash,
        gasEstimate: gasEstimate.toString(),
        gasCostEth: gasCostEth.toFixed(6),
        gasCostEuro: (gasCostEth * ethPrice).toFixed(2),
        proofValid: isValid
      });
    }

    res.json({ deviceId, deviceDetails, datasets: allDatasetsInfo });
  } catch (e) {
    console.error("❌ Errore /init-device-onchain:", e);
    res.status(500).json({ error: e.message || e });
  }
});

// --- 2) Create Device (REST) automatico ---
app.post("/device", async (req, res) => {
  try {
    let { pk } = req.body;
    if (!pk) pk = PK; // usa PK predefinita se non passata

    const deviceId = "device_" + Date.now();
    const deviceData = { id: deviceId, pk };

    const dir = path.join(__dirname, "..", "file-json", deviceId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "device.json"), JSON.stringify(deviceData, null, 2));

    res.json(deviceData);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- 3) Get Device ---
app.post("/device/get", async (req, res) => {
  try {
    let { deviceId } = req.body;
    if (!deviceId) {
      // Se non passato, prendi l'ultimo device creato
      const devices = fs.readdirSync(path.join(__dirname, "..", "file-json"));
      devices.sort();
      deviceId = devices[devices.length - 1];
    }

    const deviceJsonPath = path.join(__dirname, "..", "file-json", deviceId, "device.json");
    if (!fs.existsSync(deviceJsonPath)) return res.status(404).json({ error: "Device non trovato" });

    const deviceData = JSON.parse(fs.readFileSync(deviceJsonPath));
    res.json(deviceData);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- Create Dataset automatico ---
app.post("/dataset", async (req, res) => {
  try {
    let { device_id, name, description } = req.body;

    // Prendi l'ultimo device se non passato
    const devicesPath = path.join(__dirname, "..", "file-json");
    const devices = fs.readdirSync(devicesPath).filter(f => fs.statSync(path.join(devicesPath, f)).isDirectory());
    devices.sort();
    if (!device_id) device_id = devices[devices.length - 1];

    if (!name) name = "Automatic Dataset";
    if (!description) description = "Generated automatically";

    const datasetId = "dataset_" + Date.now();
    const datasetData = { datasetId, device_id, name, description };

    const dir = path.join(devicesPath, device_id, "datasets");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const datasetFilePath = path.join(dir, `${datasetId}.json`);
    fs.writeFileSync(datasetFilePath, JSON.stringify(datasetData, null, 2));

    res.json(datasetData);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- Add Flight Data automatico ---
app.post("/flight_data", async (req, res) => {
  try {
    let { device_id, dataset_id } = req.body;

    const devicesPath = path.join(__dirname, "..", "file-json");
    const devices = fs.readdirSync(devicesPath).filter(f => fs.statSync(path.join(devicesPath, f)).isDirectory());
    devices.sort();
    if (!device_id) device_id = devices[devices.length - 1];

    const datasetsDir = path.join(devicesPath, device_id, "datasets");
    const datasets = fs.readdirSync(datasetsDir).filter(f => f.endsWith(".json"));
    datasets.sort();
    if (!dataset_id) dataset_id = datasets[datasets.length - 1].replace(".json", "");

    // Genera flight data casuale
    const flightData = generateFlightData(device_id, dataset_id);

    const flightDir = path.join(datasetsDir, dataset_id, "flight_datas");
    if (!fs.existsSync(flightDir)) fs.mkdirSync(flightDir, { recursive: true });

    const flightFilePath = path.join(flightDir, `${flightData.dataset_id}_${Date.now()}_${Math.floor(Math.random() * 10000)}.json`);
    fs.writeFileSync(flightFilePath, JSON.stringify(flightData, null, 2));

    res.json(flightData);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- 6) Get Flight Data for Dataset ---
app.post("/dataset/flight_datas", async (req, res) => {
  try {
    let { dataset_id } = req.body;
    const datasetDir = path.join(__dirname, "..", "file-json");
    const flightDataFiles = [];

    function scan(dirPath) {
      if (!fs.existsSync(dirPath)) return;
      const items = fs.readdirSync(dirPath);
      for (const item of items) {
        const fullPath = path.join(dirPath, item);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) scan(fullPath);
        else if (stat.isFile() && fullPath.includes(dataset_id) && fullPath.endsWith(".json")) {
          const data = JSON.parse(fs.readFileSync(fullPath));
          flightDataFiles.push(data);
        }
      }
    }
    scan(datasetDir);

    res.json(flightDataFiles);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- 7) Register Dataset On-Chain (simulazione endpoint) ---
app.post("/register-onchain", async (req, res) => {
  try {
    let { deviceId, datasetId, merkleRoot } = req.body;

    // Se non passati, prendi gli ultimi generati
    const devices = fs.readdirSync(path.join(__dirname, "..", "file-json"));
    devices.sort();
    if (!deviceId) deviceId = devices[devices.length - 1];

    const datasetsDir = path.join(__dirname, "..", "file-json", deviceId, "datasets");
    const datasets = fs.readdirSync(datasetsDir);
    datasets.sort();
    if (!datasetId) datasetId = datasets[datasets.length - 1].replace(".json", "");

    // Se non passata merkleRoot, calcolala automaticamente
    if (!merkleRoot) {
      const flightDir = path.join(datasetsDir, datasetId, "flight_datas");
      const files = fs.existsSync(flightDir) ? fs.readdirSync(flightDir) : [];
      const flightDatas = files.map(f => JSON.parse(fs.readFileSync(path.join(flightDir, f))));
      const leaves = flightDatas.map(hashFlightData);
      const merkleTree = new MerkleTree(leaves, keccak256, { sortPairs: true });
      merkleRoot = merkleTree.getHexRoot();
    }

    const txHash = "0x" + Math.random().toString(16).slice(2, 66);
    res.json({ deviceId, datasetId, merkleRoot, txHash });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(port, () => {
  console.log(`✅ Server Express attivo su http://localhost:${port}`);
});
