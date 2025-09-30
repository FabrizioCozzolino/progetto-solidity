const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const https = require("https");
const { MerkleTree } = require("merkletreejs");
const keccak256 = require("keccak256");

const app = express();
const port = 3000;

app.use(cors());
app.use(bodyParser.json({ limit: "50mb" }));

// --- Memoria in-memory delle forest unit ---
const forestUnits = {}; // { forestUnitId: { accountId, trees: {}, woodLogs: {}, sawnTimbers: {} } }

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

// --- Endpoint: ricevere tutte le forest unit di un account ---
app.get("/api/forest-units/:accountId", (req, res) => {
  const { accountId } = req.params;

  const units = Object.keys(forestUnits)
    .filter(fuId => forestUnits[fuId].accountId === accountId)
    .map(fuId => ({
      forestUnitId: fuId,
      forestUnit: forestUnits[fuId]
    }));

  if (units.length === 0) {
    return res.status(404).json({ error: "Nessuna forest unit trovata per questo account" });
  }

  res.json({ accountId, forestUnits: units });
});

// --- Endpoint: aggiungere una nuova forest unit ---
app.post("/api/forest-units", (req, res) => {
  const { forestUnitId, accountId } = req.body;
  if (!forestUnitId || !accountId) return res.status(400).json({ error: "forestUnitId e accountId richiesti" });

  if (forestUnits[forestUnitId]) return res.status(400).json({ error: "forestUnitId già esistente" });

  forestUnits[forestUnitId] = { accountId, trees: {}, woodLogs: {}, sawnTimbers: {} };
  res.json({ message: "Forest unit creata", forestUnitId });
});

// --- Endpoint: aggiungere un Tree ---
app.post("/api/forest-units/:forestUnitId/tree", (req, res) => {
  const { forestUnitId } = req.params;
  const tree = req.body;

  const fu = forestUnits[forestUnitId];
  if (!fu) return res.status(404).json({ error: "Forest unit non trovata" });

  const treeEpc = normalizeEpc(tree.epc || tree.domainUUID || tree.domainUuid, "");
  fu.trees[treeEpc] = tree;
  res.json({ message: "Tree aggiunto", epc: treeEpc });
});

// --- Endpoint: aggiungere un WoodLog ---
app.post("/api/forest-units/:forestUnitId/woodlog", (req, res) => {
  const { forestUnitId } = req.params;
  const log = req.body;

  const fu = forestUnits[forestUnitId];
  if (!fu) return res.status(404).json({ error: "Forest unit non trovata" });

  const logEpc = normalizeEpc(log.EPC || log.epc || log.domainUUID || log.domainUuid, log.parentTree || "");
  fu.woodLogs[logEpc] = log;
  res.json({ message: "WoodLog aggiunto", epc: logEpc });
});

// --- Endpoint: aggiungere un SawnTimber ---
app.post("/api/forest-units/:forestUnitId/sawntimber", (req, res) => {
  const { forestUnitId } = req.params;
  const st = req.body;

  const fu = forestUnits[forestUnitId];
  if (!fu) return res.status(404).json({ error: "Forest unit non trovata" });

  const stEpc = normalizeEpc(st.EPC || st.epc || st.domainUUID || st.domainUuid, st.parentWoodLog || "");
  fu.sawnTimbers[stEpc] = st;
  res.json({ message: "SawnTimber aggiunto", epc: stEpc });
});

// --- Endpoint: calcolare Merkle root unificata ---
app.post("/api/merkle-root-unified", (req, res) => {
  const { forestUnitId } = req.body;
  if (!forestUnitId) return res.status(400).json({ error: "forestUnitId richiesto" });

  const forestUnit = forestUnits[forestUnitId];
  if (!forestUnit) return res.status(404).json({ error: "Forest unit non trovata" });

  try {
    const batch = [];
    const leaves = [];
    const seenEpcs = new Set();

    const treesDict = forestUnit.trees || {};
    for (const treeId of Object.keys(treesDict)) {
      const t = treesDict[treeId];
      const treeEpc = normalizeEpc(t.epc || t.domainUUID || t.domainUuid || treeId, "");
      if (seenEpcs.has(treeEpc)) continue;
      seenEpcs.add(treeEpc);

      const treeObj = {
        type: "Tree",
        epc: treeEpc,
        firstReading: t.firstReadingTime || "",
        treeType: t.treeType?.specie || t.treeTypeId || t.specie || "Unknown",
        coordinates: t.coordinates ? `${t.coordinates.latitude || t.coordinates.lat || ""},${t.coordinates.longitude || t.coordinates.lon || ""}`.replace(/(^,|,$)/g, "") : "",
        notes: Array.isArray(t.notes) ? t.notes.map(n => n.description || n).join("; ") : t.notes || "",
        observations: getObservations(t),
        forestUnitId,
        domainUUID: treeEpc,
        deleted: t.deleted || false,
        lastModification: t.lastModification || ""
      };

      batch.push(treeObj);
      leaves.push(hashUnified(treeObj));
    }

    const logsDict = forestUnit.woodLogs || {};
    for (const logKey of Object.keys(logsDict)) {
      const log = logsDict[logKey];
      const logEpc = normalizeEpc(log.EPC || log.epc || log.domainUUID || log.domainUuid || logKey, log.parentTree || "");
      if (seenEpcs.has(logEpc)) continue;
      seenEpcs.add(logEpc);

      const logObj = {
        type: "WoodLog",
        epc: logEpc,
        firstReading: log.firstReadingTime || "",
        treeType: log.treeType || "Unknown",
        parentTree: log.parentTree || "",
        coordinates: log.coordinates ? `${log.coordinates.latitude || log.coordinates.lat || ""},${log.coordinates.longitude || log.coordinates.lon || ""}`.replace(/(^,|,$)/g, "") : "",
        notes: Array.isArray(log.notes) ? log.notes.map(n => n.description || n).join("; ") : log.notes || "",
        observations: getObservations(log),
        forestUnitId,
        domainUUID: logEpc,
        deleted: log.deleted || false,
        lastModification: log.lastModification || ""
      };

      batch.push(logObj);
      leaves.push(hashUnified(logObj));
    }

    const stDict = forestUnit.sawnTimbers || {};
    for (const stKey of Object.keys(stDict)) {
      const st = stDict[stKey];
      const stEpc = normalizeEpc(st.EPC || st.epc || st.domainUUID || st.domainUuid || stKey, st.parentWoodLog || "");
      if (seenEpcs.has(stEpc)) continue;
      seenEpcs.add(stEpc);

      const stObj = {
        type: "SawnTimber",
        epc: stEpc,
        firstReading: st.firstReadingTime || "",
        treeType: st.treeType || "Unknown",
        parentTreeEpc: st.parentTree || "",
        parentWoodLog: st.parentWoodLog || "",
        coordinates: st.coordinates ? `${st.coordinates.latitude || st.coordinates.lat || ""},${st.coordinates.longitude || st.coordinates.lon || ""}`.replace(/(^,|,$)/g, "") : "",
        notes: Array.isArray(st.notes) ? st.notes.map(n => n.description || n).join("; ") : st.notes || "",
        observations: getObservations(st),
        forestUnitId,
        domainUUID: stEpc,
        deleted: st.deleted || false,
        lastModification: st.lastModification || ""
      };

      batch.push(stObj);
      leaves.push(hashUnified(stObj));
    }

    const merkleTree = new MerkleTree(leaves, keccak256, { sortPairs: true });
    const root = merkleTree.getHexRoot();
    res.json({ root, batch });

  } catch (e) {
    res.status(500).json({ error: "Errore generazione Merkle root", details: e.message });
  }
});

// --- Endpoint mock: scrivere su blockchain ---
app.post("/api/write-blockchain/:forestUnitId", (req, res) => {
  const { forestUnitId } = req.params;
  const fu = forestUnits[forestUnitId];
  if (!fu) return res.status(404).json({ error: "Forest unit non trovata" });

  // Mock: simuliamo scrittura su blockchain
  const txHash = "0x" + keccak256(forestUnitId + Date.now().toString()).toString("hex");
  res.json({ message: "Simulazione scrittura blockchain completata", txHash });
});

app.listen(port, () => console.log(`Server avviato su http://localhost:${port}`));