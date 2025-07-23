const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { MerkleTree } = require("merkletreejs");
const keccak256 = require("keccak256");
const ethers = hre.ethers; // ethers v6

const deployedPath = path.join(__dirname, "../deployed.json");
const deployed = JSON.parse(fs.readFileSync(deployedPath));
const CONTRACT_ADDRESS = deployed.ForestTracking || deployed.address;

if (!CONTRACT_ADDRESS) {
  console.error("❌ Indirizzo contratto non trovato nel file deployed.json.");
  process.exit(1);
}


const API_URL = "https://pollicino.topview.it:9443/api/get-forest-units/";
const AUTH_TOKEN = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0b2tlbl90eXBlIjoiYWNjZXNzIiwiZXhwIjoxNzUzMjg2NDcyLCJpYXQiOjE3NTMyODI4NzIsImp0aSI6IjYxMzk1N2M1ODFhZTRkNDlhOWVhNTZjNjI5NTgxMGVjIiwidXNlcl9pZCI6MTEwfQ.7as9-BUffHkEU4eWcxHawMch_NH16zxVb0bHp2p3mYU";

function leafHash(tree) {
  return keccak256(
    tree.epc +
      tree.firstReading.toString() +
      tree.treeType +
      tree.coordinates +
      tree.observations
  );
}

async function main() {
  console.log("=== INIZIO SCRIPT ===");

  const signer = (await ethers.getSigners())[0];
  console.log("👤 Signer address:", await signer.getAddress());

  // Carica ABI dal JSON del contratto
  const contractJson = require("../artifacts/contracts/ForestTracking.sol/ForestTracking.json");

  // Crea il contratto usando ABI e indirizzo
  const contract = new ethers.Contract(CONTRACT_ADDRESS, contractJson.abi, signer);

  // ethers v6: interface.fragments è un array, filtriamo solo funzioni
  if (contract.interface && Array.isArray(contract.interface.fragments)) {
    const funcs = contract.interface.fragments
      .filter(f => f.type === "function")
      .map(f => f.name);
    console.log("📋 Funzioni disponibili:", funcs);
  } else {
    console.warn("⚠️ contract.interface.fragments non definito o non un array");
  }

  console.log("✅ Contratto caricato da:", CONTRACT_ADDRESS);

  // Chiamata API
  let response;
  try {
    response = await axios.get(API_URL, { headers: { Authorization: AUTH_TOKEN } });
    console.log("✅ Chiamata API riuscita, status:", response.status);
  } catch (e) {
    console.error("❌ Errore chiamata API:", e.response?.data || e.message);
    process.exit(1);
  }

  const forestUnits = response.data.forestUnits;
  const forestKey = Object.keys(forestUnits).find(
    k =>
      k.toLowerCase() === "vallombrosa" ||
      forestUnits[k].name?.toLowerCase().includes("vallombrosa")
  );

  if (!forestKey) {
    console.error("❌ Nessuna forest unit 'Vallombrosa' trovata.");
    process.exit(1);
  }

  console.log(`🌲 Forest unit trovata: '${forestKey}'`);
  const treesDict = forestUnits[forestKey].trees;
  const treeKeys = Object.keys(treesDict);

  if (treeKeys.length === 0) {
    console.warn("⚠️ Nessun albero trovato nella forest unit.");
    process.exit(1);
  }

  const batch = [];
  const leaves = [];

  for (const id of treeKeys) {
    const t = treesDict[id];
    const epc = t.domainUUID || t.domainUuid || id;
    const firstReading = t.firstReadingTime
      ? Math.floor(new Date(t.firstReadingTime).getTime() / 1000)
      : 0;
    const treeType = t.treeType?.specie || "";
    const coordinates = t.coordinates
      ? `${t.coordinates.latitude},${t.coordinates.longitude}`
      : "";
    const observations = t.notes || "";

    const obj = { epc, firstReading, treeType, coordinates, observations };
    batch.push(obj);
    leaves.push(leafHash(obj));
  }

  console.log(`✅ Alberi validi per Merkle tree: ${batch.length}`);

  const merkleTree = new MerkleTree(leaves, keccak256, { sortPairs: true });
  const root = merkleTree.getHexRoot();
  console.log("🌲 Merkle Root calcolata:", root);

  // Transazione setMerkleRoot
  // Transazione setMerkleRoot
try {
  if (typeof contract.setMerkleRoot !== "function") {
    console.error("❌ La funzione setMerkleRoot non è disponibile nel contratto.");
    process.exit(1);
  }

  const gasEstimate = await contract.setMerkleRoot.estimateGas(root);
  const gasPrice = await hre.ethers.provider.send("eth_gasPrice", []);


  const ethCostBigInt = BigInt(gasEstimate.toString()) * BigInt(gasPrice);

  const ethCostFloat = Number(hre.ethers.formatEther(ethCostBigInt));

// Forza ethEur a number per evitare errori con BigInt
let ethEur = 3120.42;
try {
  const res = await axios.get("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=eur");
  ethEur = Number(res.data.ethereum.eur); // 👈 assicurati che sia un number
} catch {
  console.warn("⚠️ Errore recupero ETH/EUR, uso 3000.");
}

const eurEstimate = ethCostFloat * ethEur;

console.log(`💰 Costo stimato: ${ethCostFloat.toFixed(6)} ETH ≈ €${eurEstimate.toFixed(2)}`);


  const tx = await contract.setMerkleRoot(root);
  const receipt = await tx.wait();

  const gasUsedBigInt = BigInt(receipt.gasUsed.toString()) * BigInt(gasPrice.toString());
const actualEth = Number(hre.ethers.formatEther(gasUsedBigInt));

// Forza `ethEur` a number
const ethEurNumber = Number(ethEur);
const eurFinal = actualEth * ethEurNumber;

console.log("✅ Merkle root aggiornata.");
console.log(`⛽ Gas usato: ${receipt.gasUsed.toString()}`);
console.log(`💸 Costo reale: ${actualEth.toFixed(6)} ETH ≈ €${eurFinal.toFixed(2)}`);


  const proof = merkleTree.getHexProof(leafHash(batch[0]));
  console.log("📌 Proof primo albero:", proof);
} catch (e) {
  console.error("❌ Errore durante update Merkle root:", e.message);
  process.exit(1);
}

}

main().catch((err) => {
  console.error("❌ Errore generale:", err);
  process.exit(1);
});
