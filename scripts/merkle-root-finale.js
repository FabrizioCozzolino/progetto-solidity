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
const AUTH_TOKEN = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0b2tlbl90eXBlIjoiYWNjZXNzIiwiZXhwIjoxNzU4NjMxODU3LCJpYXQiOjE3NTg2MjgyNTcsImp0aSI6IjViNDY2MjE1NGEzNDRjOTNhMmJjZjczZTExMTk4ODk3IiwidXNlcl9pZCI6MTE0fQ.MaNie1aBn05_jbl-9ku5IAPYD697kBvw9sjvdwfxIhM"; // Inserisci il token reale

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

function hashUnified(obj) {
  return keccak256(
    `${obj.type}|${obj.epc}|${obj.firstReading}|${obj.treeType || ""}|${obj.coordinates || ""}|${obj.notes || ""}|${obj.parentTree || ""}|${obj.parentWoodLog || ""}|${obj.observations || ""}|${obj.forestUnitId || ""}|${obj.domainUUID || ""}|${obj.deleted ? 1 : 0}|${obj.lastModification || ""}`
  );
}

function normalizeEpc(epcRaw, seed = "") {
  if (!epcRaw && !seed) return "";
  const s = String(epcRaw || "");
  if (s.toUpperCase().startsWith("E")) return s;
  const h = keccak256(s + "|" + seed).toString("hex").toUpperCase();
  return "E280" + h.slice(0, 20);
}

function normalizeObservations(obsArrayOrString) {
  if (!obsArrayOrString) return "";
  if (typeof obsArrayOrString === "string") return obsArrayOrString.trim();
  if (!Array.isArray(obsArrayOrString) || obsArrayOrString.length === 0) return "";

  return obsArrayOrString
    .map(o => {
      const name = o.phenomenonType?.phenomenonTypeName || o.phenomenonName || o.phenomenonTypeId || "";
      const qty = o.quantity || "";
      const unit = o.unit?.unitName || o.unitId || "";
      return `${name}${qty ? `: ${qty}` : ""}${unit ? ` ${unit}` : ""}`.trim();
    })
    .filter(s => s.length > 0)
    .join("; ");
}

// --- Funzione aggiornata per osservazioni sempre valorizzate
function getObservations(obj) {
  const obs = normalizeObservations(
    obj.observations ||
    obj.treeObservations ||
    obj.phenomena ||
    obj.obs ||
    obj.observation
  );
  return obs && obs.length > 0 ? obs : "(nessuna osservazione)";
}


async function getEthPriceInEuro() {
  try {
    const res = await axios.get(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=eur"
    );
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

  // Recupero forest units
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

  const userChoice = await new Promise(resolve => rl.question("\n✏️ Seleziona il numero della forest unit: ", resolve));
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

  const treesDict = unit.trees || {};
  const batch = [];
  const leaves = [];
  const seenEpcs = new Set();

  for (const treeId of Object.keys(treesDict)) {
    const t = treesDict[treeId];
    const treeEpc = t.domainUUID || t.domainUuid || t.epc || treeId;

    const treeObj = {
      type: "Tree",
      epc: treeEpc,
      firstReading: t.firstReadingTime ? Math.floor(new Date(t.firstReadingTime).getTime() / 1000) : 0,
      treeType: t.treeType?.specie || t.treeTypeId || t.specie || "Unknown",
      coordinates: t.coordinates ? `${t.coordinates.latitude || t.coordinates.lat || ""},${t.coordinates.longitude || t.coordinates.lon || ""}`.replace(/(^,|,$)/g, "") : "",
      notes: Array.isArray(t.notes) ? t.notes.map(n => n.description || n).join("; ") : t.notes || "",
      observations: getObservations(t),
      forestUnitId: selectedForestKey,
      domainUUID: treeEpc,
      deleted: t.deleted || false,
      lastModification: t.lastModification || t.lastModfication || ""
    };

    batch.push(treeObj);
    leaves.push(hashUnified(treeObj));
    seenEpcs.add(treeEpc);

    const treeLogs = t.woodLogs || {};
    for (const logKey of Object.keys(treeLogs)) {
      const log = treeLogs[logKey];
      const logEpc = normalizeEpc(log.EPC || log.epc || log.domainUUID, treeEpc);
      if (seenEpcs.has(logEpc)) continue;
      seenEpcs.add(logEpc);

      const logObj = {
        type: "WoodLog",
        epc: logEpc,
        firstReading: log.firstReadingTime ? Math.floor(new Date(log.firstReadingTime).getTime() / 1000) : 0,
        treeType: t.treeType?.specie || t.treeTypeId || "Unknown",
        logSectionNumber: log.logSectionNumber || 1,
        parentTree: treeEpc,
        coordinates: log.coordinates ? `${log.coordinates.latitude || log.coordinates.lat || ""},${log.coordinates.longitude || log.coordinates.lon || ""}`.replace(/(^,|,$)/g, "") : "",
        notes: Array.isArray(log.notes) ? log.notes.map(n => n.description || n).join("; ") : log.notes || "",
        observations: getObservations(log),
        forestUnitId: selectedForestKey,
        domainUUID: log.domainUUID || log.domainUuid || logEpc,
        deleted: log.deleted || false,
        lastModification: log.lastModification || log.lastModfication || ""
      };

      batch.push(logObj);
      leaves.push(hashUnified(logObj));

      const sawnTimbersObj = log.sawnTimbers || {};
if (sawnTimbersObj && Object.keys(sawnTimbersObj).length > 0) {
  for (const stKey of Object.keys(sawnTimbersObj)) {
    const st = sawnTimbersObj[stKey]; // prendi l'oggetto del singolo sawn timber
    const stEpc = normalizeEpc(st.EPC || st.epc || st.domainUUID || st.domainUuid || stKey, logEpc);
    if (seenEpcs.has(stEpc)) continue; // evita duplicati
    seenEpcs.add(stEpc);

    console.log("🔍 Raw SawnTimber:", st);

    const stObj = {
      type: "SawnTimber",
      epc: stEpc,
      firstReading: st.firstReadingTime ? Math.floor(new Date(st.firstReadingTime).getTime() / 1000) : st.firstReading || 0,
      treeType: t.treeType?.specie || t.treeTypeId || "Unknown",
      parentTreeEpc: treeEpc,
      parentWoodLog: logEpc,
      coordinates: st.coordinates ? `${st.coordinates.latitude || st.coordinates.lat || ""},${st.coordinates.longitude || st.coordinates.lon || ""}`.replace(/(^,|,$)/g, "") : "",
      notes: Array.isArray(st.notes) ? st.notes.map(n => n.description || n).join("; ") : st.notes || "",
      observations: getObservations(st.observations),
      forestUnitId: selectedForestKey,
      domainUUID: st.domainUUID || st.domainUuid || stEpc,
      deleted: st.deleted || false,
      lastModification: st.lastModification || st.lastModfication || ""
    };

    batch.push(stObj);
    leaves.push(hashUnified(stObj));
  }
}
}
  }

  if (leaves.length === 0) {
    console.error("❌ Forest Unit vuota: nessun albero o tronco trovato. Root non generata.");
    process.exit(1);
  }

  const merkleTree = new MerkleTree(leaves, keccak256, { sortPairs: true });
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
  fs.writeFileSync(path.join(outputDir, "forest-unified-batch.json"), JSON.stringify(batch, null, 2));
  console.log("💾 Salvato: forest-unified-batch.json");
}

main().catch(e => {
  console.error("❌ Errore:", e);
  process.exit(1);
});