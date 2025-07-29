require("dotenv").config({ path: "./test.env" });
const hre = require("hardhat");
const { Wallet, formatEther, getPublicKey } = require("ethers");  // <- qui tutto insieme
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { MerkleTree } = require("merkletreejs");
const keccak256 = require("keccak256");

const deployedPath = path.join(__dirname, "../deployed.json");
const deployed = JSON.parse(fs.readFileSync(deployedPath));
const CONTRACT_ADDRESS = deployed.Bitacora || deployed.address;

const API_URL = "http://51.91.111.200:3000/flight_data";
const DEVICE_API = "http://51.91.111.200:3000/device";

const AUTH_TOKEN = process.env.AUTH_TOKEN;
const DEVICE_ID = process.env.DEVICE_ID || "device_123";
const DATASET_IDS = (process.env.DATASET_IDS || "dataset_001").split(",").map(d => d.trim());

async function generatePublicKey() {
  const wallet = Wallet.createRandom();
  console.log("🔐 Wallet generato:", wallet.address);

  const rawPublicKeyUncompressed = getPublicKey(wallet.privateKey, false);

  console.log("🔑 Public Key NON compressa:", rawPublicKeyUncompressed);

  return { wallet, rawPublicKeyCompressed: rawPublicKeyUncompressed };
}


function hexStringToByteArray(hex) {
  if (typeof hex !== "string") return hex; // se è già array, ritorna così
  if (hex.startsWith("0x")) hex = hex.slice(2);
  const bytes = [];
  for (let c = 0; c < hex.length; c += 2) {
    bytes.push(parseInt(hex.substr(c, 2), 16));
  }
  return bytes;
}

async function trySendPkFormats(rawPublicKeyCompressed) {
  const formats = [
    {
      name: "Hex with 0x prefix",
      value: rawPublicKeyCompressed,
    },
    {
      name: "Hex without 0x prefix",
      value: rawPublicKeyCompressed.startsWith("0x")
        ? rawPublicKeyCompressed.slice(2)
        : rawPublicKeyCompressed,
    },
    {
      name: "Hex without prefix byte (0x02/0x03), no 0x",
      value: rawPublicKeyCompressed.startsWith("0x")
        ? rawPublicKeyCompressed.slice(4)
        : rawPublicKeyCompressed.slice(2),
    },
    {
      name: "Byte array from full hex",
      value: hexStringToByteArray(rawPublicKeyCompressed),
    },
    {
      name: "Byte array from hex without 0x prefix byte",
      value: hexStringToByteArray(
        rawPublicKeyCompressed.startsWith("0x")
          ? rawPublicKeyCompressed.slice(4)
          : rawPublicKeyCompressed.slice(2)
      ),
    },
  ];

  for (const fmt of formats) {
    console.log(`\n🔄 Provo formato: ${fmt.name}`);
    try {
      await axios.post(
        DEVICE_API,
        {
          id: DEVICE_ID,
          pk: fmt.value,
        },
        { headers: { Authorization: AUTH_TOKEN } }
      );
      console.log(`✅ Formato "${fmt.name}" accettato dall'API!`);
      return true; // esce al primo successo
    } catch (e) {
      console.error(
        `❌ Formato "${fmt.name}" rifiutato:`,
        e.response?.data || e.message
      );
    }
  }
  console.error("⚠️ Nessun formato è stato accettato dall'API.");
  return false;
}

async function main() {
  const signer = (await hre.ethers.getSigners())[0];
  const contractJson = require("../artifacts/contracts/DroneTracking.sol/Bitacora.json");
  const contract = new hre.ethers.Contract(CONTRACT_ADDRESS, contractJson.abi, signer);

  const { wallet, rawPublicKeyCompressed } = await generatePublicKey();

  // Provo a registrare il device con tutti i formati di pk finché uno non va bene
  const success = await trySendPkFormats(rawPublicKeyCompressed);
  if (!success) {
    console.error("Errore: nessun formato PK accettato dall'API, esco.");
    return;
  }

  try {
    await contract.getDevice(DEVICE_ID);
    console.log("✅ Device già presente on-chain.");
  } catch {
    const pkForOnChain = rawPublicKeyCompressed.slice(4, 4 + 64);
    const pkBytes32 = "0x" + pkForOnChain;
    const txReg = await contract.registerDevice(DEVICE_ID, pkBytes32);
    await txReg.wait();
    console.log("✅ Device registrato on-chain!");
  }

  const ethPrice = await getEthPriceInEuro();

  const outputDir = path.join(__dirname, "..", "file-json");
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

  for (const DATASET_ID of DATASET_IDS) {
    console.log(`\n📦 Dataset: ${DATASET_ID}`);

    let response;
    try {
      response = await axios.post(
        API_URL,
        {
          id: DEVICE_ID,
          dataset_id: DATASET_ID,
        },
        {
          headers: { Authorization: AUTH_TOKEN },
          timeout: 10000,
        }
      );
    } catch (e) {
      console.error("❌ Errore chiamata API:", e.message);
      continue;
    }

    const flightDatas = response.data;
    if (!Array.isArray(flightDatas) || flightDatas.length === 0) {
      console.error("❌ Nessun dato trovato nel dataset.");
      continue;
    }

    const leaves = flightDatas.map(hashFlightData);
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

    const testLeaf = hashFlightData(flightDatas[0]);
    const proof = merkleTree.getHexProof(testLeaf);
    const isValid = merkleTree.verify(proof, testLeaf, root);
    console.log(`🔍 Proof valida? ${isValid}`);
  }
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

function hashFlightData(fd) {
  const deviceId = fd.device_id || "";
  const timestamp = fd.timestamp || 0;
  const lat = fd.localization?.latitude ?? 0;
  const lon = fd.localization?.longitude ?? 0;
  const signature = fd.signature || "";
  const concatStr = `${deviceId}|${timestamp}|${lat}|${lon}|${signature}`;
  return keccak256(concatStr);
}

main().catch((e) => {
  console.error("❌ Errore generale:", e);
  process.exit(1);
});
