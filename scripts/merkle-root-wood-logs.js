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

const API_URL = "https://pollicino.topview.it:9443/api/get-forest-units/";
const AUTH_TOKEN = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0b2tlbl90eXBlIjoiYWNjZXNzIiwiZXhwIjoxNzUzMzUxNzMyLCJpYXQiOjE3NTMzNDgxMzIsImp0aSI6IjY2YTIzNmFlNjY2YTRkN2ZhMDA0YzQ5NzJjODA3NzJiIiwidXNlcl9pZCI6MTEwfQ.hhtuCeyZBN6a2fJh0kF6vyNp6r8olhrfFz33FEN0We4";

function leafHashWoodLog(log) {
  return keccak256(
    `${log.epc}|${log.firstReading}|${log.treeType}|${log.logSectionNumber}|${log.parentTreeEpc}|${log.observations}`
  );
}

async function getEthPriceInEuro() {
  try {
    const res = await axios.get("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=eur");
    return res.data.ethereum.eur;
  } catch {
    console.warn("⚠️ Errore recupero ETH/EUR, uso default 3120");
    return 3120;
  }
}

async function main() {
  console.log("=== SCRIPT WOOD LOGS ===");

  const signer = (await ethers.getSigners())[0];
  const contractJson = require("../artifacts/contracts/ForestTracking.sol/ForestTracking.json");
  const contract = new ethers.Contract(CONTRACT_ADDRESS, contractJson.abi, signer);

  console.log("👤 Signer:", await signer.getAddress());

  // Fetch forest unit
  const res = await axios.get(API_URL, { headers: { Authorization: AUTH_TOKEN } });
  const forestUnits = res.data.forestUnits;
  const forestKey = Object.keys(forestUnits).find(k =>
    k.toLowerCase() === "vallombrosa" || forestUnits[k].name?.toLowerCase().includes("vallombrosa")
  );

  if (!forestKey) throw new Error("❌ Forest unit 'Vallombrosa' non trovata");

  const treesDict = forestUnits[forestKey].trees;
  const woodLogs = [];

  for (const id of Object.keys(treesDict)) {
    const tree = treesDict[id];
    if (!tree.woodLogs) continue;

    for (const epc of Object.keys(tree.woodLogs)) {
      const log = tree.woodLogs[epc];
      const obsArr = log.observations || [];
      const obs = obsArr.map(o => `${o.phenomenonType?.phenomenonTypeName || ''}: ${o.quantity} ${o.unit?.unitName || ''}`).join("; ");
      woodLogs.push({
        epc,
        firstReading: log.firstReadingTime ? Math.floor(new Date(log.firstReadingTime).getTime() / 1000) : 0,
        treeType: tree.treeType?.specie || "",
        logSectionNumber: 1, // valore statico, adattabile
        parentTreeEpc: tree.domainUUID || tree.domainUuid || id,
        observations: obs
      });
    }
  }

  if (woodLogs.length === 0) return console.warn("⚠️ Nessun wood log trovato.");

  console.log("✅ Wood logs trovati:", woodLogs.length);

  const leaves = woodLogs.map(leafHashWoodLog);
  const merkleTree = new MerkleTree(leaves, keccak256, { sortPairs: true });
  const root = merkleTree.getHexRoot();

  console.log("🌲 Merkle root wood logs:", root);

  const gasEstimate = await hre.ethers.provider.estimateGas({
    to: CONTRACT_ADDRESS,
    data: contract.interface.encodeFunctionData("setMerkleRootWoodLogs", [root]),
    from: await signer.getAddress()
  });

  const feeData = await hre.ethers.provider.getFeeData();
  const gasPrice = feeData.gasPrice;
  const gasCost = gasEstimate * gasPrice;
  const ethCost = hre.ethers.formatEther(gasCost.toString());

  const ethEur = await getEthPriceInEuro();
  console.log(`💰 Costo stimato: ${ethCost} ETH ≈ €${(parseFloat(ethCost) * ethEur).toFixed(2)}`);

  // Invio transazione
  const tx = await contract.setMerkleRootWoodLogs(root);
  const receipt = await tx.wait();

  const actualGasCost = receipt.gasUsed * gasPrice;
  const actualEth = hre.ethers.formatEther(actualGasCost.toString());
  console.log("✅ Merkle root wood logs aggiornata.");
  console.log(`⛽ Gas usato: ${receipt.gasUsed.toString()}`);
  console.log(`💸 Costo reale: ${actualEth} ETH ≈ €${(parseFloat(actualEth) * ethEur).toFixed(2)}`);

  // Proof per verifica
  const proof = merkleTree.getHexProof(leafHashWoodLog(woodLogs[0]));
  const isValid = await contract.verifyWoodLogProof(leafHashWoodLog(woodLogs[0]), proof);
  console.log(`🔍 Proof valida per primo wood log? ${isValid ? "✅ SÌ" : "❌ NO"}`);

  // Scrittura su file
  const outputPath = path.join(__dirname, "wood-logs-batch.json");
  fs.writeFileSync(outputPath, JSON.stringify(woodLogs, null, 2));
  console.log(`💾 Log salvato in ${outputPath}`);
}

main().catch(console.error);
