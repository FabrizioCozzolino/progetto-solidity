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

if (!CONTRACT_ADDRESS) {
  console.error("❌ Indirizzo contratto non trovato nel file deployed.json.");
  process.exit(1);
}

const API_URL = "https://pollicino.topview.it:9443/api/get-forest-units/";
const AUTH_TOKEN = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0b2tlbl90eXBlIjoiYWNjZXNzIiwiZXhwIjoxNzUzMzU2ODU4LCJpYXQiOjE3NTMzNTMyNTgsImp0aSI6IjExZTg1YTExZWIxMzRjZGE4MzM2M2YwZDNmYjY2ODVkIiwidXNlcl9pZCI6MTEwfQ.bnJUkG0ecQe_TEOfqHxRgPxno12WUB_Sue7QS3eusys";

// Hash functions
function leafHashTree(tree) {
  return keccak256(
    `${tree.epc}|${tree.firstReading}|${tree.treeType}|${tree.coordinates}|${tree.observations}`
  );
}
function leafHashWoodLog(log) {
  return keccak256(
    `${log.epc}|${log.firstReading}|${log.treeType}|${log.logSectionNumber}|${log.parentTreeEpc}|${log.observations}`
  );
}
function leafHashSawnTimber(st) {
  return keccak256(
    `${st.epc}|${st.firstReading}|${st.treeType}|${st.observations}`
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
  console.log("=== INIZIO SCRIPT UNIFICATO ===");

  const signer = (await ethers.getSigners())[0];
  console.log("👤 Signer address:", await signer.getAddress());

  const contractJson = require("../artifacts/contracts/ForestTracking.sol/ForestTracking.json");
  const contract = new ethers.Contract(CONTRACT_ADDRESS, contractJson.abi, signer);

  // 1) Fetch forest units
  let response;
  try {
    response = await axios.get(API_URL, { headers: { Authorization: AUTH_TOKEN } });
console.log("✅ Chiamata API riuscita, status:", response.status);
  } catch (e) {
    console.error("❌ Errore chiamata API:", e.message);
    process.exit(1);
  }

  const forestUnits = response.data.forestUnits;  // <-- aggiungi questa riga

const forestUnitName = process.env.FOREST_UNIT?.toLowerCase() || "vallombrosa";

const forestKey = Object.keys(forestUnits).find(
  k =>
    k.toLowerCase() === forestUnitName ||
    forestUnits[k].name?.toLowerCase().includes(forestUnitName)
);

if (!forestKey) {
  console.error(`❌ Nessuna forest unit '${forestUnitName}' trovata.`);
  process.exit(1);
}
console.log(`🌲 Forest unit trovata: '${forestKey}'`);

  const forestUnit = forestUnits[forestKey];
  const treesDict = forestUnit.trees || {};

  // 2) Preparazione batch Trees
  const batchTrees = [];
  const leavesTrees = [];

  // 3) Preparazione batch Wood Logs
  const woodLogs = [];
  const leavesWoodLogs = [];

  // 4) Preparazione batch Sawn Timbers
  const sawnTimbers = [];
  const leavesSawnTimbers = [];

  for (const treeId of Object.keys(treesDict)) {
    const tree = treesDict[treeId];

    // Trees batch
    const epc = tree.domainUUID || tree.domainUuid || treeId;
    const firstReading = tree.firstReadingTime ? Math.floor(new Date(tree.firstReadingTime).getTime() / 1000) : 0;
    const treeType = tree.treeType?.specie || "";
    const coordinates = tree.coordinates ? `${tree.coordinates.latitude},${tree.coordinates.longitude}` : "";
    const observations = tree.notes || "";

    const treeObj = { epc, firstReading, treeType, coordinates, observations };
    batchTrees.push(treeObj);
    leavesTrees.push(leafHashTree(treeObj));

    // Wood logs batch
    if (tree.woodLogs) {
      for (const logEpc of Object.keys(tree.woodLogs)) {
        const log = tree.woodLogs[logEpc];
        const obsArr = log.observations || [];
        const obs = obsArr.map(o => `${o.phenomenonType?.phenomenonTypeName || ''}: ${o.quantity} ${o.unit?.unitName || ''}`).join("; ");
        woodLogs.push({
          epc: logEpc,
          firstReading: log.firstReadingTime ? Math.floor(new Date(log.firstReadingTime).getTime() / 1000) : 0,
          treeType,
          logSectionNumber: 1, // statico per ora
          parentTreeEpc: epc,
          observations: obs
        });
      }
    }

    // Sawn Timbers batch
    if (tree.woodLogs) {
      for (const logEpc of Object.keys(tree.woodLogs)) {
        const woodLog = tree.woodLogs[logEpc];
        const list = woodLog.sawnTimbers || {};
        for (const stEpc of Object.keys(list)) {
          const st = list[stEpc];
          const obs = (st.observations || []).map(o => `${o.phenomenonType?.phenomenonTypeName || ''}: ${o.quantity} ${o.unit?.unitName || ''}`).join("; ");
          sawnTimbers.push({
            epc: st.epc || stEpc || "",
            firstReading: st.firstReadingTime ? Math.floor(new Date(st.firstReadingTime).getTime() / 1000) : 0,
            treeType,
            observations: obs
          });
        }
      }
    }
  }

  // Leaves Merkle trees
  leavesWoodLogs.push(...woodLogs.map(leafHashWoodLog));
  leavesSawnTimbers.push(...sawnTimbers.map(leafHashSawnTimber));

  console.log(`✅ Alberi per Merkle tree: ${batchTrees.length}`);
  console.log(`✅ Wood logs totali: ${woodLogs.length}`);
  console.log(`✅ Sawn timbers totali: ${sawnTimbers.length}`);

  // Calcolo Merkle root per tutti e tre
  const merkleTreeTrees = new MerkleTree(leavesTrees, keccak256, { sortPairs: true });
  const rootTrees = merkleTreeTrees.getHexRoot();

  const merkleTreeWoodLogs = new MerkleTree(leavesWoodLogs, keccak256, { sortPairs: true });
  const rootWoodLogs = merkleTreeWoodLogs.getHexRoot();

  const merkleTreeSawnTimbers = new MerkleTree(leavesSawnTimbers, keccak256, { sortPairs: true });
  const rootSawnTimbers = merkleTreeSawnTimbers.getHexRoot();

  console.log("🌲 Merkle root trees:", rootTrees);
  console.log("🌲 Merkle root wood logs:", rootWoodLogs);
  console.log("🌲 Merkle root sawn timbers:", rootSawnTimbers);

  // Funzione helper per stimare gas e inviare tx
  async function sendTxSetMerkleRoot(methodName, root) {
    if (typeof contract[methodName] !== "function") {
      throw new Error(`Funzione ${methodName} non trovata nel contratto`);
    }

    const gasEstimate = await hre.ethers.provider.estimateGas({
      to: CONTRACT_ADDRESS,
      data: contract.interface.encodeFunctionData(methodName, [root]),
      from: await signer.getAddress()
    });

    const feeData = await hre.ethers.provider.getFeeData();
    const gasPrice = feeData.gasPrice;
    if (!gasPrice) throw new Error("Gas price non disponibile");

    const gasCostWei = gasEstimate * gasPrice;
    const gasCostEth = Number(hre.ethers.formatEther(gasCostWei.toString()));

    const tx = await contract[methodName](root);
    const receipt = await tx.wait();

    const actualGasCostWei = receipt.gasUsed * gasPrice;
    const actualGasCostEth = Number(hre.ethers.formatEther(actualGasCostWei.toString()));

    return {
      gasEstimate,
      gasPrice: Number(hre.ethers.formatUnits(gasPrice, "gwei")),
      gasCostEth,
      actualGasUsed: receipt.gasUsed.toString(),
      actualGasCostEth,
      txHash: receipt.transactionHash,
    };
  }

  const ethPriceEUR = await getEthPriceInEuro();

  // Aggiorna Merkle root trees
  console.log("\n⏳ Aggiorno Merkle root trees...");
  const resTrees = await sendTxSetMerkleRoot("setMerkleRootTrees", rootTrees);
  console.log(`Gas stimato: ${resTrees.gasEstimate.toString()} | Gas price: ${resTrees.gasPrice} Gwei | Costo stimato: ${resTrees.gasCostEth.toFixed(6)} ETH ≈ €${(resTrees.gasCostEth * ethPriceEUR).toFixed(2)}`);
  console.log(`Gas usato: ${resTrees.actualGasUsed} | Costo reale: ${resTrees.actualGasCostEth.toFixed(6)} ETH ≈ €${(resTrees.actualGasCostEth * ethPriceEUR).toFixed(2)}`);
  console.log(`Tx hash: ${resTrees.txHash}`);

  // Aggiorna Merkle root wood logs
  console.log("\n⏳ Aggiorno Merkle root wood logs...");
  const resWoodLogs = await sendTxSetMerkleRoot("setMerkleRootWoodLogs", rootWoodLogs);
  console.log(`Gas stimato: ${resWoodLogs.gasEstimate.toString()} | Gas price: ${resWoodLogs.gasPrice} Gwei | Costo stimato: ${resWoodLogs.gasCostEth.toFixed(6)} ETH ≈ €${(resWoodLogs.gasCostEth * ethPriceEUR).toFixed(2)}`);
  console.log(`Gas usato: ${resWoodLogs.actualGasUsed} | Costo reale: ${resWoodLogs.actualGasCostEth.toFixed(6)} ETH ≈ €${(resWoodLogs.actualGasCostEth * ethPriceEUR).toFixed(2)}`);
  console.log(`Tx hash: ${resWoodLogs.txHash}`);

  // Aggiorna Merkle root sawn timbers
  console.log("\n⏳ Aggiorno Merkle root sawn timbers...");
  const resSawnTimbers = await sendTxSetMerkleRoot("setMerkleRootSawnTimbers", rootSawnTimbers);
  console.log(`Gas stimato: ${resSawnTimbers.gasEstimate.toString()} | Gas price: ${resSawnTimbers.gasPrice} Gwei | Costo stimato: ${resSawnTimbers.gasCostEth.toFixed(6)} ETH ≈ €${(resSawnTimbers.gasCostEth * ethPriceEUR).toFixed(2)}`);
  console.log(`Gas usato: ${resSawnTimbers.actualGasUsed} | Costo reale: ${resSawnTimbers.actualGasCostEth.toFixed(6)} ETH ≈ €${(resSawnTimbers.actualGasCostEth * ethPriceEUR).toFixed(2)}`);
  console.log(`Tx hash: ${resSawnTimbers.txHash}`);

  // Totali gas e costi
 const totalGasEstimate =
  BigInt(resTrees.gasEstimate) +
  BigInt(resWoodLogs.gasEstimate) +
  BigInt(resSawnTimbers.gasEstimate);

  const totalGasUsed = BigInt(resTrees.actualGasUsed) + BigInt(resWoodLogs.actualGasUsed) + BigInt(resSawnTimbers.actualGasUsed);
  const totalCostEth = resTrees.actualGasCostEth + resWoodLogs.actualGasCostEth + resSawnTimbers.actualGasCostEth;
const totalCostEur = totalCostEth * ethPriceEUR;


  console.log("\n=== RIEPILOGO COSTI TOTALI ===");
  console.log(`Gas stimato totale: ${totalGasEstimate.toString()}`);
  console.log(`Gas usato totale: ${totalGasUsed.toString()}`);
  console.log(`Costo reale totale: ${totalCostEth.toFixed(6)} ETH ≈ €${totalCostEur.toFixed(2)}`);

// === VERIFICA PROOF SU CONTRATTO ===
console.log("\n🔍 Verifica di un esempio per ciascun tipo via contratto...");

function getProofAndRoot(item, leaves, hashFn) {
  const leaf = hashFn(item);
  const merkleTree = new MerkleTree(leaves, keccak256, { sortPairs: true });
  const proof = merkleTree.getHexProof(leaf);
  const root = merkleTree.getHexRoot();
  return { proof, leaf, root };
}

const verifyResult = {};

if (batchTrees.length > 0) {
  const sample = batchTrees[0];
  const { proof, leaf, root } = getProofAndRoot(sample, leavesTrees, leafHashTree);
  const isValid = await contract.verifyTreeProofWithRoot(leaf, proof, root);
  verifyResult.tree = isValid;
  console.log(`🌲 Tree proof valida: ${isValid}`);
}

if (woodLogs.length > 0) {
  const sample = woodLogs[0];
  const { proof, leaf, root } = getProofAndRoot(sample, leavesWoodLogs, leafHashWoodLog);
  const isValid = await contract.verifyWoodLogProofWithRoot(leaf, proof, root);
  verifyResult.woodLog = isValid;
  console.log(`🪵 Wood Log proof valida: ${isValid}`);
}

if (sawnTimbers.length > 0) {
  const sample = sawnTimbers[0];
  const { proof, leaf, root } = getProofAndRoot(sample, leavesSawnTimbers, leafHashSawnTimber);
  const isValid = await contract.verifySawnTimberProofWithRoot(leaf, proof, root);
  verifyResult.sawnTimber = isValid;
  console.log(`🪚 Sawn Timber proof valida: ${isValid}`);
}

// Salvataggio file batch JSON
fs.writeFileSync(path.join(__dirname, "forest-trees-batch.json"), JSON.stringify(batchTrees, null, 2));
fs.writeFileSync(path.join(__dirname, "wood-logs-batch.json"), JSON.stringify(woodLogs, null, 2));
fs.writeFileSync(path.join(__dirname, "sawn-timbers-batch.json"), JSON.stringify(sawnTimbers, null, 2));

console.log("\n💾 File batch salvati:");
console.log(" - forest-trees-batch.json");
console.log(" - wood-logs-batch.json");
console.log(" - sawn-timbers-batch.json");
}

main().catch(err => {
  console.error("❌ Errore:", err);
  process.exit(1);
});
