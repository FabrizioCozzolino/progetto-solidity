require("dotenv").config({ path: "./test.env" });
const hre = require("hardhat");
const { Wallet, formatEther } = require("ethers");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { MerkleTree } = require("merkletreejs");
const keccak256 = require("keccak256");
const secp = require("@noble/secp256k1");

const deployedPath = path.join(__dirname, "../deployed.json");
const deployed = JSON.parse(fs.readFileSync(deployedPath));
const CONTRACT_ADDRESS = deployed.Bitacora || deployed.address;

const API_BASE_URL = "http://51.91.111.200:3000";
const API_URL = `${API_BASE_URL}/flight_data`;
const DEVICE_API = `${API_BASE_URL}/device`;

const AUTH_TOKEN = process.env.AUTH_TOKEN;
const DEVICE_ID = process.env.DEVICE_ID || "device_123";
const DATASET_IDS = (process.env.DATASET_IDS || "dataset_001").split(",").map(d => d.trim());

async function generatePublicKey() {
  const wallet = Wallet.createRandom();
  console.log("🔐 Wallet generato:", wallet.address);

  const compressed = secp.getPublicKey(wallet.privateKey.slice(2), true);
  const compressedHex = "0x" + Buffer.from(compressed).toString("hex");

  console.log("🔑 Public Key COMPRESSA:", compressedHex);
  return { wallet, rawPublicKeyCompressed: compressedHex };
}

async function fetchDataset(datasetId) {
  try {
    const url = `${API_BASE_URL}/dataset/${datasetId}`;
    const response = await axios.get(url, {
      headers: { Authorization: AUTH_TOKEN },
      timeout: 10000,
    });
    console.log(`📦 Dataset ${datasetId} recuperato, ${response.data.count || response.data.length} elementi.`);
    return response.data;
  } catch (e) {
    console.error(`❌ Errore recupero dataset ${datasetId}:`, e.message);
    return null;
  }
}

async function trySendPkExact(rawPublicKeyCompressed) {
  try {
    await axios.post(
      DEVICE_API,
      { id: DEVICE_ID, pk: rawPublicKeyCompressed }, // invia esattamente la stringa con "0x" davanti
      { headers: { Authorization: AUTH_TOKEN } }
    );
    console.log("✅ Public key inviata esattamente con prefisso 0x.");
    return true;
  } catch (e) {
    console.error("❌ Errore invio public key:", e.response?.data || e.message);
    return false;
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
  const signer = (await hre.ethers.getSigners())[0];
  const contractJson = require("../artifacts/contracts/DroneTracking.sol/Bitacora.json");
  const contract = new hre.ethers.Contract(CONTRACT_ADDRESS, contractJson.abi, signer);

  const { wallet, rawPublicKeyCompressed } = await generatePublicKey();

  const pkSuccess = await trySendPkExact(rawPublicKeyCompressed);
if (!pkSuccess) {
  console.error("Errore: public key non accettata dall'API, esco.");
  return;
}



  try {
    await contract.getDevice(DEVICE_ID);
    console.log("✅ Device già presente on-chain.");
  } catch {
    // Registro la pk on-chain senza il byte di compressione (primo byte)
    const pkForOnChain = rawPublicKeyCompressed.startsWith("0x")
      ? rawPublicKeyCompressed.slice(4) // tolgo 0x + 1 byte (2 cifre esadecimali)
      : rawPublicKeyCompressed.slice(2);
    const pkBytes32 = "0x" + pkForOnChain;
    const txReg = await contract.registerDevice(DEVICE_ID, pkBytes32);
    await txReg.wait();
    console.log("✅ Device registrato on-chain!");
  }

  const ethPrice = await getEthPriceInEuro();

  const outputDir = path.join(__dirname, "..", "file-json");
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

  for (const DATASET_ID of DATASET_IDS) {
    const datasetData = await fetchDataset(DATASET_ID);
    if (!datasetData) continue;

    const flightDatas = Array.isArray(datasetData)
      ? datasetData
      : datasetData.flight_datas || datasetData.data || [];

    if (!flightDatas.length) {
      console.error(`❌ Nessun dato flight_data nel dataset ${DATASET_ID}`);
      continue;
    }

    const leaves = flightDatas.map(fd => {
      fd.device_id = DEVICE_ID;
      return hashFlightData(fd);
    });

    const merkleTree = new MerkleTree(leaves, keccak256, { sortPairs: true });
    const root = merkleTree.getHexRoot();

    const gasEstimate = await hre.ethers.provider.estimateGas({
      to: CONTRACT_ADDRESS,
      data: contract.interface.encodeFunctionData("registerDataset", [DATASET_ID, DEVICE_ID, root]),
      from: await signer.getAddress(),
    });

    const feeData = await hre.ethers.provider.getFeeData();
    const gasCostWei = gasEstimate.mul(feeData.gasPrice);
    const gasCostEth = Number(formatEther(gasCostWei));

    console.log(`🧩 Merkle Root: ${root}`);
    console.log(`⛽ Gas stimato: ${gasEstimate.toString()}`);
    console.log(`💸 Costo stimato: ${gasCostEth.toFixed(6)} ETH ≈ €${(gasCostEth * ethPrice).toFixed(2)}`);

    fs.writeFileSync(path.join(outputDir, `${DATASET_ID}-batch.json`), JSON.stringify(flightDatas, null, 2));
    console.log(`💾 Salvato: ${DATASET_ID}-batch.json`);

    try {
      const tx = await contract.registerDataset(DATASET_ID, DEVICE_ID, root);
      const receipt = await tx.wait();
      console.log(`✅ Dataset registrato. Tx hash: ${receipt.transactionHash}`);
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
