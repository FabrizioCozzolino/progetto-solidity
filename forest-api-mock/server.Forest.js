const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { MerkleTree } = require("merkletreejs");
const keccak256 = require("keccak256");
const ethers = require("ethers");
const fs = require("fs");
const path = require("path");

const app = express();
const port = 3000;

app.use(cors());
app.use(bodyParser.json({ limit: "50mb" }));

// --- Memoria in-memory delle forest unit ---
const forestUnits = {}; // { forestUnitId: { accountId, trees: {}, woodLogs: {}, sawnTimbers: {} } }

// --- Ethers setup (Hardhat o testnet) ---
const provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
const signer = new ethers.Wallet(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  provider
);

// ABI e address del contratto
const deployed = require("./deployed.json");
const contractJson = require(path.resolve(__dirname, "../artifacts/contracts/ForestTracking.sol/ForestTracking.json"));
const contract = new ethers.Contract(deployed.ForestTracking, contractJson.abi, signer);

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

// --- ENDPOINTS ---

// 1️⃣ GET: ottieni forest units per account
app.get("/api/forest-units/:account", (req, res) => {
  const accountId = req.params.account;
  const units = Object.keys(forestUnits)
    .filter(key => forestUnits[key].accountId === accountId)
    .map(key => ({ forestUnitId: key, ...forestUnits[key] }));
  res.json(units);
});

// 2️⃣ POST: aggiungi albero
app.post("/api/forest-units/:forestUnitId/tree", (req, res) => {
  const { forestUnitId } = req.params;
  const tree = req.body;
  if (!forestUnits[forestUnitId]) forestUnits[forestUnitId] = { accountId: "unknown", trees: {}, woodLogs: {}, sawnTimbers: {} };
  const key = tree.epc || tree.domainUUID || `tree-${Date.now()}`;
  forestUnits[forestUnitId].trees[key] = tree;
  res.json({ message: "Albero aggiunto", key });
});

// 3️⃣ POST: aggiungi tronco
app.post("/api/forest-units/:forestUnitId/woodlog", (req, res) => {
  const { forestUnitId } = req.params;
  const woodLog = req.body;
  if (!forestUnits[forestUnitId]) forestUnits[forestUnitId] = { accountId: "unknown", trees: {}, woodLogs: {}, sawnTimbers: {} };
  const key = woodLog.epc || woodLog.domainUUID || `woodlog-${Date.now()}`;
  forestUnits[forestUnitId].woodLogs[key] = woodLog;

  // Aggancio automatico all'albero padre
  if (woodLog.parentTree && forestUnits[forestUnitId].trees[woodLog.parentTree]) {
    forestUnits[forestUnitId].trees[woodLog.parentTree].woodLogs = forestUnits[forestUnitId].trees[woodLog.parentTree].woodLogs || {};
    forestUnits[forestUnitId].trees[woodLog.parentTree].woodLogs[key] = woodLog;
  }

  res.json({ message: "WoodLog aggiunto", key });
});

// 4️⃣ POST: aggiungi tavola
app.post("/api/forest-units/:forestUnitId/sawntimber", (req, res) => {
  const { forestUnitId } = req.params;
  const sawnTimber = req.body;
  if (!forestUnits[forestUnitId]) forestUnits[forestUnitId] = { accountId: "unknown", trees: {}, woodLogs: {}, sawnTimbers: {} };
  const key = sawnTimber.epc || sawnTimber.domainUUID || `sawntimber-${Date.now()}`;
  forestUnits[forestUnitId].sawnTimbers[key] = sawnTimber;

  // Aggancio automatico al tronco padre
  if (sawnTimber.parentWoodLog && forestUnits[forestUnitId].woodLogs[sawnTimber.parentWoodLog]) {
    forestUnits[forestUnitId].woodLogs[sawnTimber.parentWoodLog].sawnTimbers = forestUnits[forestUnitId].woodLogs[sawnTimber.parentWoodLog].sawnTimbers || {};
    forestUnits[forestUnitId].woodLogs[sawnTimber.parentWoodLog].sawnTimbers[key] = sawnTimber;
  }

  res.json({ message: "SawnTimber aggiunto", key });
});

// 5️⃣ POST: unificato migliorato
app.post("/api/forest-units/unified", async (req, res) => {
  const { forestUnitId: selectedForestKey, accountId } = req.body;
  if (!selectedForestKey || !accountId)
    return res.status(400).json({ error: "forestUnitId e accountId richiesti" });

  try {
    // crea o aggiorna Forest Unit in memoria
    if (!forestUnits[selectedForestKey]) {
      forestUnits[selectedForestKey] = { accountId, trees: {}, woodLogs: {}, sawnTimbers: {} };
    } else {
      forestUnits[selectedForestKey].accountId = accountId; // aggiorna accountId esistente
    }

    const unit = forestUnits[selectedForestKey];
    const treesDict = unit.trees || {};
    const batch = [];
    const leaves = [];
    const seenEpcs = new Set();

    const processObservations = obj => getObservations(obj);

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
        observations: processObservations(t),
        forestUnitId: selectedForestKey,
        domainUUID: treeEpc,
        deleted: t.deleted || false,
        lastModification: t.lastModification || t.lastModfication || ""
      };

      batch.push(treeObj);
      leaves.push(hashUnified(treeObj));
      seenEpcs.add(treeEpc);

      // --- Gestione WoodLogs e SawnTimbers annidati
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
          firstReading: log.firstReadingTime ? Math.floor(new Date(log.firstReadingTime).getTime() / 1000) : 0,
          treeType: t.treeType?.specie || t.treeTypeId || "Unknown",
          logSectionNumber: log.logSectionNumber || 1,
          parentTree: treeEpc,
          coordinates: log.coordinates ? `${log.coordinates.latitude || log.coordinates.lat || ""},${log.coordinates.longitude || log.coordinates.lon || ""}`.replace(/(^,|,$)/g, "") : "",
          notes: Array.isArray(log.notes) ? log.notes.map(n => n.description || n).join("; ") : log.notes || "",
          observations: processObservations(log),
          forestUnitId: selectedForestKey,
          domainUUID: log.domainUUID || log.domainUuid || logEpc,
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
            firstReading: st?.firstReadingTime ? Math.floor(new Date(st.firstReadingTime).getTime() / 1000) : 0,
            treeType: t.treeType?.specie || t.treeTypeId || "Unknown",
            parentTreeEpc: treeEpc,
            parentWoodLog: logEpc,
            coordinates: st?.coordinates ? `${st.coordinates.latitude || st.coordinates.lat || ""},${st.coordinates.longitude || st.coordinates.lon || ""}`.replace(/(^,|,$)/g, "") : "",
            notes: Array.isArray(st?.notes) ? st.notes.map(n => n.description || n).join("; ") : st?.notes || "",
            observations: processObservations(st || {}),
            forestUnitId: selectedForestKey,
            domainUUID: st?.domainUUID || st?.domainUuid || stEpc,
            deleted: st?.deleted || false,
            lastModification: st?.lastModification || st?.lastModfication || ""
          };

          batch.push(stObj);
          leaves.push(hashUnified(stObj));
        }
      }
    }

    if (leaves.length === 0) {
      return res.status(400).json({ error: "Impossibile generare Merkle root: nessun elemento valido nella ForestUnit" });
    }

    // --- Generazione Merkle root
    const merkleTree = new MerkleTree(leaves, keccak256, { sortPairs: true });
    const root = "0x" + merkleTree.getRoot().toString("hex");

    // --- Scrittura su contratto Solidity
    const txResponse = await contract["setMerkleRootUnified(string,bytes32)"](selectedForestKey, root);
    const receipt = await txResponse.wait();

    // --- Salvataggio su file JSON
    const outputDir = path.join(__dirname, "file-json");
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);
    fs.writeFileSync(path.join(outputDir, "forest-unified-batch.json"), JSON.stringify(batch, null, 2));

    res.json({
      message: "ForestUnit creata, Merkle root generata e scritta su blockchain",
      forestUnitId: selectedForestKey,
      root,
      txHash: receipt.transactionHash,
      batchSize: batch.length
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore durante operazione unificata", details: err.message });
  }
});

app.listen(port, () => console.log(`Server avviato su http://localhost:${port}`));