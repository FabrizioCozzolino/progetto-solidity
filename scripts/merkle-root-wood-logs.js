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
const AUTH_TOKEN = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0b2tlbl90eXBlIjoiYWNjZXNzIiwiZXhwIjoxNzU4NjI4NDkxLCJpYXQiOjE3NTg2MjQ4OTEsImp0aSI6ImU2MDY3YjdkZWFiMDRjY2FhYThkOTQwOWU5MjVlYWU2IiwidXNlcl9pZCI6MTE0fQ.AJucqndkGrGYekyqB35dWDQbdAtk0ma8DOyitmwps3U"; // Inserisci il token reale

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
  
    // --- Recupero dati forest units ---
    let response;
    try {
      response = await axios.get(API_URL, { headers: { Authorization: AUTH_TOKEN } });
    } catch (e) {
      console.error("❌ Errore chiamata API:", e.message);
      process.exit(1);
    }
  
    const forestUnits = response.data.forestUnits || {};
    const readline = require("readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  
    console.log("\n🌲 Forest Units disponibili:\n");
    Object.entries(forestUnits).forEach(([key, val], index) => {
      console.log(`${index + 1}) ${val.name || "(senza nome)"} — key: ${key}`);
    });
  
    const userChoice = await new Promise((resolve) => {
      rl.question("\n✏️ Inserisci il numero della forest unit da selezionare: ", resolve);
    });
    rl.close();
  
    const choiceIndex = parseInt(userChoice) - 1;
    const forestKeys = Object.keys(forestUnits);
    if (isNaN(choiceIndex) || choiceIndex < 0 || choiceIndex >= forestKeys.length) {
      console.error("❌ Scelta non valida.");
      process.exit(1);
    }
    const selectedForestKey = forestKeys[choiceIndex];
    const unit = forestUnits[selectedForestKey];
    console.log(`\n✅ Forest Unit selezionata: ${unit.name || selectedForestKey}\n`);

  const treesDict = forestUnits[selectedForestKey].trees;
  const woodLogs = [];

  for (const id of Object.keys(treesDict)) {
    const tree = treesDict[id];
    if (!tree.woodLogs) continue;

    for (const epc of Object.keys(tree.woodLogs)) {
      const log = tree.woodLogs[epc];
      const obsArr = log.observations || [];
      const obs = obsArr.map(o => `${o.phenomenonType?.phenomenonTypeName || ''}: ${o.quantity} ${o.unit?.unitName || ''}`).join("; ");
      console.log("DEBUG log object:", log);
      console.log("DEBUG log.observations:", log.observations);
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
