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
const AUTH_TOKEN = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0b2tlbl90eXBlIjoiYWNjZXNzIiwiZXhwIjoxNzU4MjAwMDI0LCJpYXQiOjE3NTgxOTY0MjQsImp0aSI6IjI2ODYxYzdkYjBjZDRlNjY5MjJkZWZjZDQ1YzNlNjk1IiwidXNlcl9pZCI6MTE0fQ.ujmr-9ZMsgUbUP3iGl_OjH8iN4aFVx_cGcqSzfQkvn4";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

// --- Funzione hash ---
function hashUnified(obj) {
  return keccak256(
    `${obj.type}|${obj.epc}|${obj.firstReading}|${obj.treeType || ""}|${obj.coordinates || ""}|${obj.notes || ""}|${obj.parentTree || ""}|${obj.parentWoodLog || ""}|${obj.observations || ""}`
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

  // --- Recupero dati forest units ---
  let response;
  try {
    response = await axios.get(API_URL, { headers: { Authorization: AUTH_TOKEN } });
  } catch (e) {
    console.error("❌ Errore chiamata API:", e.message);
    process.exit(1);
  }

  const forestUnits = response.data.forestUnits;
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
  const forestKey = forestKeys[choiceIndex];
  const unit = forestUnits[forestKey];
  console.log(`\n✅ Forest Unit selezionata: ${unit.name || forestKey}\n`);

  const unifiedBatch = [];
  const unifiedLeaves = [];

  const treesSource = unit.trees || unit.treesData || {};
  for (const treeKey of Object.keys(treesSource)) {
    const tree = treesSource[treeKey];

    const epc = tree.EPC || tree.epc || tree.domainUUID || tree.domainUuid || `tree-${treeKey}`;
    const firstReading = tree.firstReadingTime ? Math.floor(new Date(tree.firstReadingTime).getTime() / 1000) : tree.firstReading || 0;
    const treeType = tree.treeTypeId || tree.treeType?.specie || tree.treeType?.type || "";
    const coordinates = tree.coordinates ? `${tree.coordinates.latitude || tree.coordinates.lat || ""},${tree.coordinates.longitude || tree.coordinates.lon || ""}`.replace(/(^,|,$)/g, "") : "";
    const notes = Array.isArray(tree.notes) ? tree.notes.map(n => n.description || n).join("; ") : tree.notes || "";
    const observations = Array.isArray(tree.observations) ? tree.observations.map(o => `${o.phenomenonTypeId || o.phenomenonName}:${o.quantity || ""}`).join("; ") : "";

    const treeEntry = {
      type: "Tree",
      epc,
      firstReading,
      treeType,
      coordinates,
      notes,
      observations,
      forestUnitId: unit.forestUnitId,
      domainUUID: tree.domainUUID || tree.domainUuid || "",
      deleted: tree.deleted || false,
      lastModification: tree.lastModification || tree.lastModfication || ""
    };
    unifiedBatch.push(treeEntry);
    unifiedLeaves.push(hashUnified(treeEntry));

    // --- WoodLogs: gestione array o oggetto ---
    const woodLogsArr = [];
    const treeLogs = tree.woodLogs || [];

    if (Array.isArray(treeLogs)) {
      for (let i = 0; i < treeLogs.length; i++) {
        const log = treeLogs[i];
        const epcLog = log.EPC || log.epc || `log-${i}`;
        const obsArr = log.observations || [];
        const obs = obsArr.map(o => `${o.phenomenonType?.phenomenonTypeName || ''}: ${o.quantity || ''} ${o.unit?.unitName || ''}`).join("; ");
        woodLogsArr.push({
          epc: epcLog,
          firstReading: log.firstReadingTime ? Math.floor(new Date(log.firstReadingTime).getTime() / 1000) : 0,
          treeType: tree.treeType?.specie || "",
          logSectionNumber: 1,
          parentTreeEpc: tree.domainUUID || tree.domainUuid || treeKey,
          observations: obs,
          rawLog: log
        });
      }
    } else {
      for (const logEpc of Object.keys(treeLogs)) {
        const log = treeLogs[logEpc];
        const obsArr = log.observations || [];
        const obs = obsArr.map(o => `${o.phenomenonType?.phenomenonTypeName || ''}: ${o.quantity || ''} ${o.unit?.unitName || ''}`).join("; ");
        woodLogsArr.push({
          epc: logEpc,
          firstReading: log.firstReadingTime ? Math.floor(new Date(log.firstReadingTime).getTime() / 1000) : 0,
          treeType: tree.treeType?.specie || "",
          logSectionNumber: 1,
          parentTreeEpc: tree.domainUUID || tree.domainUuid || treeKey,
          observations: obs,
          rawLog: log
        });
      }
    }

    for (const logObj of woodLogsArr) {
      const logEntry = {
        type: "WoodLog",
        epc: logObj.epc,
        firstReading: logObj.firstReading,
        treeType: logObj.treeType,
        parentTree: logObj.parentTreeEpc,
        coordinates: "",
        notes: logObj.rawLog.notes ? (Array.isArray(logObj.rawLog.notes) ? logObj.rawLog.notes.map(n => n.description || n).join("; ") : logObj.rawLog.notes) : "",
        observations: logObj.observations,
        forestUnitId: unit.forestUnitId,
        domainUUID: logObj.rawLog.domainUUID || logObj.rawLog.domainUuid || "",
        deleted: logObj.rawLog.deleted || false,
        lastModification: logObj.rawLog.lastModification || logObj.rawLog.lastModfication || ""
      };
      unifiedBatch.push(logEntry);
      unifiedLeaves.push(hashUnified(logEntry));

      // --- SawnTimbers ---
      let sawnTimbers = Array.isArray(logObj.rawLog.sawnTimbers) ? logObj.rawLog.sawnTimbers : [];
      if (sawnTimbers.length === 0 && logObj.rawLog.domainUUID) {
        sawnTimbers = await fetchWoodLogDetails(logObj.rawLog.domainUUID);
      }

      for (let j = 0; j < sawnTimbers.length; j++) {
        const st = sawnTimbers[j];
        if (!st) continue;
        const stEpc = st.EPC || st.epc || st.domainUUID || st.domainUuid || `st-${j}`;
        const notesSt = Array.isArray(st.notes) ? st.notes.map(n => n.description || n).join("; ") : st.notes || "";
        const observationsSt = Array.isArray(st.observations) ? st.observations.map(o => `${o.phenomenonTypeId || o.phenomenonName}:${o.quantity || ""}`).join("; ") : "";
        const coordinatesSt = st.coordinates ? `${st.coordinates.latitude || st.coordinates.lat || ""},${st.coordinates.longitude || st.coordinates.lon || ""}`.replace(/(^,|,$)/g, "") : "";

        const stEntry = {
          type: "SawnTimber",
          epc: stEpc,
          firstReading: st.firstReadingTime ? Math.floor(new Date(st.firstReadingTime).getTime() / 1000) : st.firstReading || 0,
          treeType: treeType,
          parentTree: treeEntry.epc,
          parentWoodLog: logObj.epc,
          coordinates: coordinatesSt,
          notes: notesSt,
          observations: observationsSt,
          forestUnitId: unit.forestUnitId,
          domainUUID: st.domainUUID || st.domainUuid || "",
          deleted: st.deleted || false,
          lastModification: st.lastModification || st.lastModfication || ""
        };
        unifiedBatch.push(stEntry);
        unifiedLeaves.push(hashUnified(stEntry));
      }
    }
  }

  if (unifiedLeaves.length === 0) {
    console.error("❌ Forest Unit vuota: nessun albero, tronco o tavola trovato. Root non generata.");
    process.exit(1);
  }

  const merkleTree = new MerkleTree(unifiedLeaves, keccak256, { sortPairs: true });
  const root = merkleTree.getHexRoot();
  console.log(`\n🔑 Merkle Root: ${root}`);

  if (!dryRun) {
    const gasEstimate = await hre.ethers.provider.estimateGas({
      to: CONTRACT_ADDRESS,
      data: contract.interface.encodeFunctionData("setMerkleRootUnified", [root]),
      from: await signer.getAddress()
    });
    const feeData = await hre.ethers.provider.getFeeData();
    const gasPrice = feeData.gasPrice || ethers.parseUnits("20", "gwei");
    const gasCostWei = gasEstimate * gasPrice;
    const gasCostEth = Number(ethers.formatEther(gasCostWei.toString()));
    const ethPrice = await getEthPriceInEuro();
    console.log(`⛽ Gas stimato: ${gasEstimate.toString()} | Costo: ${gasCostEth.toFixed(6)} ETH ≈ €${(gasCostEth * ethPrice).toFixed(2)}`);

    try {
      console.log("⏳ Invio transazione per aggiornare Merkle Root...");
      const txResponse = await contract.setMerkleRootUnified(root);
      const receipt = await txResponse.wait();
      console.log(`✅ Root aggiornata con successo!`);
      console.log(`🔗 Tx hash: ${receipt.transactionHash}`);
      console.log(`Block number: ${receipt.blockNumber}`);
    } catch (err) {
      console.error("❌ Errore durante l'invio della transazione:", err);
    }
  } else {
    console.log("⚠️ Dry run attivo: transazione non eseguita.");
  }

  const outputDir = path.join(__dirname, "..", "file-json");
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);
  fs.writeFileSync(path.join(outputDir, "forest-unified-batch.json"), JSON.stringify(unifiedBatch, null, 2));
  console.log("💾 Salvato: forest-unified-batch.json");
}

main().catch(e => {
  console.error("❌ Errore:", e);
  process.exit(1);
});
