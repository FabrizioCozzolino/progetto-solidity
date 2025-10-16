const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const https = require("https");
const axios = require("axios");
const { MerkleTree } = require("merkletreejs");
const keccak256 = require("keccak256");
const ethers = hre.ethers;

// Parametri di login
const LOGIN_CREDENTIALS = {
  username: "lorenzo",
  password: "puglet007"
};

const deployedPath = path.join(__dirname, "../deployed.json");
const deployed = JSON.parse(fs.readFileSync(deployedPath));
const CONTRACT_ADDRESS = deployed.ForestTracking || deployed.address;

const API_URL_FOREST_UNITS = "https://digimedfor.topview.it/api/get-forest-units/";

// --- Axios instance che ignora certificati scaduti ---
const axiosInstance = axios.create({
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  headers: { "Content-Type": "application/json" }
});

// --- Funzioni di hashing e normalizzazione ---
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

function getObservations(obj) {
  const obs = normalizeObservations(
    obj?.observations ||
    obj?.treeObservations ||
    obj?.phenomena ||
    obj?.obs ||
    obj?.observation
  );
  return obs && obs.length > 0 ? obs : "(nessuna osservazione)";
}

async function getEthPriceInEuro() {
  try {
    const res = await axiosInstance.get(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=eur"
    );
    return res.data.ethereum.eur;
  } catch {
    console.warn("⚠️ Errore recupero ETH/EUR, uso default 3000");
    return 3000;
  }
}

function summarizeForestUnitRaw(unit) {
  let treeCount = 0;
  let woodLogCount = 0;
  const sawnSet = new Set();

  const treesDict = unit.trees || {};
  const unitWoodLogs = unit.woodLogs || {};

  function resolveLog(ref) {
    if (!ref) return null;
    if (typeof ref === 'string') return unitWoodLogs[ref] || null;
    if (typeof ref === 'object') return ref;
    return null;
  }

  for (const treeKey of Object.keys(treesDict)) {
    const t = treesDict[treeKey];
    treeCount++;
    const treeLogs = t.woodLogs || [];
    if (Array.isArray(treeLogs)) {
      for (const logRef of treeLogs) {
        woodLogCount++;
        const logObj = resolveLog(logRef);
        if (logObj && logObj.sawnTimbers) {
          if (Array.isArray(logObj.sawnTimbers)) {
            for (const st of logObj.sawnTimbers) {
              const id = (st && st.EPC) ? st.EPC : (typeof st === 'string' ? st : JSON.stringify(st));
              sawnSet.add(id);
            }
          } else if (typeof logObj.sawnTimbers === 'object') {
            for (const k of Object.keys(logObj.sawnTimbers)) sawnSet.add(k);
          }
        }
      }
    } else if (typeof treeLogs === 'object') {
      for (const k of Object.keys(treeLogs)) {
        woodLogCount++;
        const val = treeLogs[k];
        let logObj = val.EPC || val.logSectionNumber || val.sawnTimbers ? val : unitWoodLogs[k] || null;
        if (logObj && logObj.sawnTimbers) {
          if (Array.isArray(logObj.sawnTimbers)) {
            for (const st of logObj.sawnTimbers) {
              const id = (st && st.EPC) ? st.EPC : (typeof st === 'string' ? st : JSON.stringify(st));
              sawnSet.add(id);
            }
          } else if (typeof logObj.sawnTimbers === 'object') {
            for (const kk of Object.keys(logObj.sawnTimbers)) sawnSet.add(kk);
          }
        }
      }
    }
  }

  if (unit.sawnTimbers && typeof unit.sawnTimbers === 'object') {
    for (const k of Object.keys(unit.sawnTimbers)) sawnSet.add(k);
  }

  console.log(`\n📊 Conteggio reale (RAW) forest unit "${unit.name || unit.forestUnitId || 'Unnamed'}":`);
  console.log(`🌳 Trees: ${treeCount}`);
  console.log(`🪵 WoodLogs (referenziati dagli alberi): ${woodLogCount}`);
  console.log(`🪚 SawnTimbers (unici): ${sawnSet.size}\n`);

  return { treeCount, woodLogCount, sawnTimberCount: sawnSet.size };
}

// --- Funzione principale ---
async function main() {
  const signer = (await ethers.getSigners())[0];
  const contractJson = require("../artifacts/contracts/ForestTracking.sol/ForestTracking.json");
  const contract = new ethers.Contract(CONTRACT_ADDRESS, contractJson.abi, signer);

  // --- Ottieni access token ---
  let tokenResponse;
  try {
    tokenResponse = await axiosInstance.post(
      "https://digimedfor.topview.it/api/get-token/",
      LOGIN_CREDENTIALS
    );
  } catch (e) {
    console.error("❌ Errore login:", e.message);
    process.exit(1);
  }
  const AUTH_TOKEN = `Bearer ${tokenResponse.data.access}`;

  // --- Recupera forest units ---
  let response;
  try {
    response = await axiosInstance.get(API_URL_FOREST_UNITS, { headers: { Authorization: AUTH_TOKEN } });
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
  summarizeForestUnitRaw(unit);

  // --- Creazione batch e Merkle Tree ---
  const treesDict = unit.trees || {};
  const batch = [];
  const leaves = [];
  const seenEpcs = new Set();
   const formatDate = d => d ? new Date(d).toISOString() : "";

  for (const treeId of Object.keys(treesDict)) {
    const t = treesDict[treeId];
    const treeEpc = t.EPC || t.epc || t.domainUUID || t.domainUuid || treeKey;

    const treeObj = {
      type: "Tree",
      epc: treeEpc,
      firstReading: formatDate(t.firstReadingTime),
      treeType: t.treeType?.specie || t.treeTypeId || t.specie || "Unknown",
      coordinates: t.coordinates ? `${t.coordinates.latitude || t.coordinates.lat || ""},${t.coordinates.longitude || t.coordinates.lon || ""}`.replace(/(^,|,$)/g, "") : "",
      notes: Array.isArray(t.notes) ? t.notes.map(n => n.description || n).join("; ") : t.notes || "",
      observations: getObservations(t),
      forestUnitId: selectedForestKey,
      domainUUID: t.domainUUID || t.domainUuid,
      deleted: t.deleted || false,
      lastModification: t.lastModification || t.lastModfication || ""
    };

    batch.push(treeObj);
    leaves.push(hashUnified(treeObj));
    seenEpcs.add(treeEpc);

    // --- Gestione WoodLogs e SawnTimbers
    const treeLogs = t.woodLogs || {};
    for (const logKey of Object.keys(treeLogs)) {
      let log = treeLogs[logKey];
      if (typeof log === "string") log = (unit.woodLogs && unit.woodLogs[log]) || {};
      const logEpc = normalizeEpc(log.EPC || log.epc || log.domainUUID, treeEpc);
      if (seenEpcs.has(logEpc)) continue;
      seenEpcs.add(logEpc);

      const logObj = {
        type: "WoodLog",
        epc: logEpc,
        firstReading: formatDate(log.firstReadingTime),
        treeType: t.treeType?.specie || t.treeTypeId || "Unknown",
        logSectionNumber: log.logSectionNumber || 1,
        parentTree: treeEpc,
        coordinates: log.coordinates ? `${log.coordinates.latitude || log.coordinates.lat || ""},${log.coordinates.longitude || log.coordinates.lon || ""}`.replace(/(^,|,$)/g, "") : "",
        notes: Array.isArray(log.notes) ? log.notes.map(n => n.description || n).join("; ") : log.notes || "",
        observations: getObservations(log),
        forestUnitId: selectedForestKey,
        domainUUID: log.domainUUID || log.domainUuid,
        deleted: log.deleted || false,
        lastModification: log.lastModification || log.lastModfication || ""
      };

      batch.push(logObj);
      leaves.push(hashUnified(logObj));

      const sawnTimbersObj = log.sawnTimbers || {};
      for (const stKey of Object.keys(sawnTimbersObj)) {
        let st = sawnTimbersObj[stKey];
        if (typeof st === "string") st = (unit.sawnTimbers && unit.sawnTimbers[st]) || { EPC: st };

        const stEpc = normalizeEpc(st.EPC || st.epc || st.domainUUID || st.domainUuid || stKey, logEpc);
        if (seenEpcs.has(stEpc)) continue;
        seenEpcs.add(stEpc);

        const stObj = {
          type: "SawnTimber",
          epc: stEpc,
          firstReading: formatDate(st.firstReadingTime),
          treeType: t.treeType?.specie || t.treeTypeId || "Unknown",
          parentTreeEpc: treeEpc,
          parentWoodLog: logEpc,
          coordinates: st?.coordinates ? `${st.coordinates.latitude || st.coordinates.lat || ""},${st.coordinates.longitude || st.coordinates.lon || ""}`.replace(/(^,|,$)/g, "") : "",
          notes: Array.isArray(st?.notes) ? st.notes.map(n => n.description || n).join("; ") : st?.notes || "",
          observations: getObservations(st || {}),
          forestUnitId: selectedForestKey,
          domainUUID: st?.domainUUID || st?.domainUuid,
          deleted: st?.deleted || false,
          lastModification: st?.lastModification || st?.lastModfication || "",
        };

        batch.push(stObj);
        leaves.push(hashUnified(stObj));
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

// --- Stima del gas usando registerForestData (non setMerkleRootUnified) ---
const gasEstimate = await hre.ethers.provider.estimateGas({
  to: CONTRACT_ADDRESS,
  data: contract.interface.encodeFunctionData(
    "registerForestData",
    [selectedForestKey, root, ""] // IPFS vuoto se non vuoi salvare il JSON
  ),
  from: await signer.getAddress()
});

const feeData = await hre.ethers.provider.getFeeData();
const gasPrice = feeData.gasPrice || ethers.parseUnits("20", "gwei");
const gasCostWei = gasEstimate * gasPrice;
const gasCostEth = Number(ethers.formatEther(gasCostWei.toString()));
const ethPrice = await getEthPriceInEuro();
console.log(`⛽ Gas stimato: ${gasEstimate.toString()} | Costo: ${gasCostEth.toFixed(6)} ETH ≈ €${(gasCostEth * ethPrice).toFixed(2)}`);

console.log("⏳ Invio transazione per registrare la Forest Data...");
const txResponse = await contract.registerForestData(selectedForestKey, root, "");
const receipt = await txResponse.wait();

console.log(`✅ Forest Data registrata con successo!`);
console.log(`🔗 Tx hash: ${receipt.transactionHash}`);
console.log(`Block number: ${receipt.blockNumber}`);

// --- Salvataggio batch JSON ---
const outputDir = path.join(__dirname, "..", "file-json");
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);
fs.writeFileSync(path.join(outputDir, "forest-unified-batch.json"), JSON.stringify(batch, null, 2));
console.log("💾 Salvato: forest-unified-batch.json");
}

main().catch(e => {
  console.error("❌ Errore:", e);
  process.exit(1);
});