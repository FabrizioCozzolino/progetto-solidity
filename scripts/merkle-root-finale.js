const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { MerkleTree } = require("merkletreejs");
const keccak256 = require("keccak256");
const ethers = hre.ethers;

const deployedPath = path.join(__dirname, "../deployed.json");
const deployed = JSON.parse(fs.readFileSync(deployedPath));
const CONTRACT_ADDRESS = deployed.ForestTracking || deployed.address;

const API_URL = "https://digimedfor.topview.it/api/get-forest-units/";

const AUTH_TOKEN = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0b2tlbl90eXBlIjoiYWNjZXNzIiwiZXhwIjoxNzU2OTg3Mjk3LCJpYXQiOjE3NTY5ODM2OTcsImp0aSI6ImEwMTgxODM1ZDIwYjQ4YTc4MjhmZjVjZGExZGYzM2UwIiwidXNlcl9pZCI6MTE0fQ.DTbKvbOieYD5ymyzmNhRwP8asgQ2Fv23R0uz9qx-cEs";

function hashUnified(obj) {
  return keccak256(
    `${obj.type}|${obj.epc}|${obj.firstReading}|${obj.treeType}|${obj.extra1}|${obj.extra2}`
  );
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
  const signer = (await ethers.getSigners())[0];
  const contractJson = require("../artifacts/contracts/ForestTracking.sol/ForestTracking.json");
  const contract = new ethers.Contract(CONTRACT_ADDRESS, contractJson.abi, signer);

  let response;
  try {
    response = await axios.get(API_URL, { headers: { Authorization: AUTH_TOKEN } });
  } catch (e) {
    console.error("❌ Errore chiamata API:", e.message);
    process.exit(1);
  }

  const forestUnits = response.data.forestUnits;
  const readline = require("readline");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Mostra tutte le forest units disponibili
console.log("\n🌲 Forest Units disponibili:\n");
Object.entries(forestUnits).forEach(([key, val], index) => {
  console.log(`${index + 1}) ${val.name || "(senza nome)"} — key: ${key}`);
});

// Aspetta la scelta dell'utente
const userChoice = await new Promise((resolve) => {
  rl.question("\n✏️ Inserisci il numero della forest unit da selezionare: ", resolve);
});
rl.close();

// Prende la key corrispondente
const choiceIndex = parseInt(userChoice) - 1;
const forestKeys = Object.keys(forestUnits);

if (isNaN(choiceIndex) || choiceIndex < 0 || choiceIndex >= forestKeys.length) {
  console.error("❌ Scelta non valida.");
  process.exit(1);
}

const forestKey = forestKeys[choiceIndex];
console.log(`\n✅ Forest Unit selezionata: ${forestUnits[forestKey].name || forestKey}\n`);


  const unit = forestUnits[forestKey];
  const treesDict = unit.trees || {};

  const unifiedBatch = [];
  const unifiedLeaves = [];

  for (const treeId of Object.keys(treesDict)) {
    const tree = treesDict[treeId];
    const epc = tree.domainUUID || tree.domainUuid || treeId;
    const firstReading = tree.firstReadingTime ? Math.floor(new Date(tree.firstReadingTime).getTime() / 1000) : 0;
    const treeType = tree.treeType?.specie || "";
    const coord = tree.coordinates ? `${tree.coordinates.latitude},${tree.coordinates.longitude}` : "";
    const obs = tree.notes || "";

    const treeEntry = { type: "Tree", epc, firstReading, treeType, extra1: coord, extra2: obs };
    unifiedBatch.push(treeEntry);
    unifiedLeaves.push(hashUnified(treeEntry));

    if (tree.woodLogs) {
      for (const logEpc of Object.keys(tree.woodLogs)) {
        const log = tree.woodLogs[logEpc];
        const obsLog = (log.observations || []).map(o => `${o.phenomenonType?.phenomenonTypeName || ""}: ${o.quantity} ${o.unit?.unitName || ""}`).join("; ");
        const logEntry = {
          type: "WoodLog",
          epc: logEpc,
          firstReading: log.firstReadingTime ? Math.floor(new Date(log.firstReadingTime).getTime() / 1000) : 0,
          treeType,
          extra1: epc,
          extra2: obsLog
        };
        unifiedBatch.push(logEntry);
        unifiedLeaves.push(hashUnified(logEntry));

        const stList = log.sawnTimbers || {};
        for (const stEpc of Object.keys(stList)) {
          const st = stList[stEpc];
          const obsSt = (st.observations || []).map(o => `${o.phenomenonType?.phenomenonTypeName || ""}: ${o.quantity} ${o.unit?.unitName || ""}`).join("; ");
          const stEntry = {
            type: "SawnTimber",
            epc: st.epc || stEpc,
            firstReading: st.firstReadingTime ? Math.floor(new Date(st.firstReadingTime).getTime() / 1000) : 0,
            treeType,
            extra1: "",
            extra2: obsSt
          };
          unifiedBatch.push(stEntry);
          unifiedLeaves.push(hashUnified(stEntry));
        }
      }
    }
  }

  // 🔍 Verifica se ci sono dati da usare per la root
if (unifiedLeaves.length === 0) {
  console.error("❌ Forest Unit vuota: nessun albero, tronco o tavola trovato. Root non generata.");
  process.exit(1);
}

  const merkleTree = new MerkleTree(unifiedLeaves, keccak256, { sortPairs: true });
  const root = merkleTree.getHexRoot();

  const gasEstimate = await hre.ethers.provider.estimateGas({
    to: CONTRACT_ADDRESS,
    data: contract.interface.encodeFunctionData("setMerkleRootUnified", [root]),
    from: await signer.getAddress()
  });

  const feeData = await hre.ethers.provider.getFeeData();
  const gasPrice = feeData.gasPrice;
  const gasCostWei = gasEstimate * gasPrice;
  const gasCostEth = Number(hre.ethers.formatEther(gasCostWei.toString()));
  const ethPrice = await getEthPriceInEuro();

  console.log(`Merkle Root: ${root}`);
  console.log(`Gas stimato: ${gasEstimate.toString()} | Costo: ${gasCostEth.toFixed(6)} ETH ≈ €${(gasCostEth * ethPrice).toFixed(2)}`);

  const tx = await contract.setMerkleRootUnified(root);
  const receipt = await tx.wait();
  console.log(`✅ Root aggiornata. Tx hash: ${receipt.transactionHash}`);

  const outputDir = path.join(__dirname, "..", "file-json");
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir);
}
fs.writeFileSync(path.join(outputDir, "forest-unified-batch.json"), JSON.stringify(unifiedBatch, null, 2));


  console.log("💾 Salvato: forest-unified-batch.json");

  // Verifica di un esempio
  if (unifiedBatch.length > 0) {
    const sample = unifiedBatch[0];
    const leaf = hashUnified(sample);
    const proof = merkleTree.getHexProof(leaf);
    const isValid = await contract.verifyUnifiedProofWithRoot(leaf, proof, root);
    console.log(`🔍 Proof di esempio valida? ${isValid}`);
  }
}

main().catch(e => {
  console.error("❌ Errore:", e);
  process.exit(1);
});
