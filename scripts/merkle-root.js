const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { MerkleTree } = require("merkletreejs");
const keccak256 = require("keccak256");

const ethers = hre.ethers;

// ✅ Carica indirizzo contratto da deployed.json
const deployedPath = path.join(__dirname, "../deployed.json");
const deployed = JSON.parse(fs.readFileSync(deployedPath));
const CONTRACT_ADDRESS = deployed.ForestTracking;

const API_URL = "https://pollicino.topview.it:9443/api/get-forest-units/";
const AUTH_TOKEN = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0b2tlbl90eXBlIjoiYWNjZXNzIiwiZXhwIjoxNzUzMTg5MDIzLCJpYXQiOjE3NTMxODU0MjMsImp0aSI6ImFiNGZiOTljNDJmYTRjOTJhZjNjOWFlNTFmNzBlZjg1IiwidXNlcl9pZCI6MTEwfQ.SyFXFqBZDjUjWS_g6OKe3De1bHZ2YAdSUOH-B9X5ZE4"; // taglia per privacy

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

  // Step 1: Signer
  const signer = (await ethers.getSigners())[0];
  console.log("Signer address:", await signer.getAddress());

  // Step 2: Contratto
  const contract = await hre.ethers.getContractAt("ForestTracking", CONTRACT_ADDRESS, signer);
  console.log("✅ Contratto caricato da:", CONTRACT_ADDRESS);

  // Step 3: API alberi
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
    (k) => k.toLowerCase() === "vallombrosa" || forestUnits[k].name?.toLowerCase().includes("vallombrosa")
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
    const firstReading = t.firstReadingTime ? Math.floor(new Date(t.firstReadingTime).getTime() / 1000) : 0;
    const treeType = t.treeType?.specie || "";
    const coordinates = t.coordinates ? `${t.coordinates.latitude},${t.coordinates.longitude}` : "";
    const observations = t.notes || "";

    const obj = { epc, firstReading, treeType, coordinates, observations };
    batch.push(obj);
    leaves.push(leafHash(obj));
  }

  console.log(`✅ Alberi validi per Merkle tree: ${batch.length}`);

  // Step 9: Costruzione Merkle Tree
  const merkleTree = new MerkleTree(leaves, keccak256, { sortPairs: true });
  const root = merkleTree.getHexRoot();
  console.log("🌲 Merkle Root calcolata:", root);

  // Step 10: Transazione
  try {
    const gasEstimate = await contract.estimateGas.setMerkleRoot(root);
    const gasPrice = await signer.provider.getGasPrice();
    const ethCost = gasEstimate.mul(gasPrice);
    const ethCostFloat = Number(ethers.utils.formatEther(ethCost));

    let ethEur = 3000;
    try {
      const res = await axios.get("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=eur");
      ethEur = res.data.ethereum.eur;
    } catch {
      console.warn("⚠️ Errore recupero ETH/EUR, uso 3000.");
    }

    console.log(`💰 Costo stimato: ${ethCostFloat.toFixed(6)} ETH ≈ €${(ethCostFloat * ethEur).toFixed(2)}`);

    const tx = await contract.setMerkleRoot(root);
    const receipt = await tx.wait();

    const actualGasUsed = receipt.gasUsed.mul(gasPrice);
    const actualEth = Number(ethers.utils.formatEther(actualGasUsed));
    console.log("✅ Merkle root aggiornata.");
    console.log(`⛽ Gas usato: ${receipt.gasUsed.toString()}`);
    console.log(`💸 Costo reale: ${actualEth.toFixed(6)} ETH ≈ €${(actualEth * ethEur).toFixed(2)}`);

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
