
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const axios = require("axios");

const app = express();
const port = 3000;
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));

// 🔹 GET tutte le forest units di un account tramite API esterna
app.post("/api/get-forest-units-by-account", async (req, res) => {
  const { account, authToken } = req.body;
  if (!account || !authToken) return res.status(400).json({ error: "account e authToken richiesti" });
  // Puoi personalizzare l'URL se serve passare l'account come parametro
  const API_URL = "https://digimedfor.topview.it/api/get-forest-units/";
  try {
    const response = await axios.get(API_URL, { headers: { Authorization: authToken } });
    const forestUnits = response.data.forestUnits;
    // Mostra tutte le forest units disponibili (come nello script)
    console.log("\n🌲 Forest Units disponibili:\n");
    Object.entries(forestUnits).forEach(([key, val], index) => {
      console.log(`${index + 1}) ${val.name || "(senza nome)"} — key: ${key}`);
    });
    res.json({ forestUnits });
  } catch (e) {
    res.status(500).json({ error: "Errore chiamata API esterna", details: e.message });
  }
});

// --- ENDPOINTS SOLO DATI DA API ---
// Calcola Merkle root da batch ricevuto
app.post("/api/merkle-root", (req, res) => {
  const { batch } = req.body;
  if (!batch || !Array.isArray(batch)) return res.status(400).json({ error: "Batch richiesto" });
  try {
    const leaves = batch.map(hashUnified);
    const merkleTree = new MerkleTree(leaves, keccak256, { sortPairs: true });
    const root = merkleTree.getHexRoot();
    res.json({ root });
  } catch (e) {
    res.status(500).json({ error: "Errore generazione Merkle root", details: e.message });
  }
});

// Calcola la proof per una leaf del batch ricevuto
app.post("/api/merkle-proof", (req, res) => {
  const { batch, sampleIndex } = req.body;
  if (!batch || !Array.isArray(batch)) return res.status(400).json({ error: "Batch richiesto" });
  if (typeof sampleIndex !== "number" || sampleIndex < 0 || sampleIndex >= batch.length) return res.status(400).json({ error: "sampleIndex non valido" });
  try {
    const leaves = batch.map(hashUnified);
    const merkleTree = new MerkleTree(leaves, keccak256, { sortPairs: true });
    const leaf = leaves[sampleIndex];
    const proof = merkleTree.getHexProof(leaf);
    res.json({ leaf: `0x${leaf.toString("hex")}`, proof, root: merkleTree.getHexRoot() });
  } catch (e) {
    res.status(500).json({ error: "Errore generazione proof", details: e.message });
  }
});

// Verifica una proof con root e leaf ricevuti
app.post("/api/merkle-verify", (req, res) => {
  const { leaf, proof, root } = req.body;
  if (!leaf || !proof || !root) return res.status(400).json({ error: "leaf, proof e root richiesti" });
  try {
    const merkleTree = new MerkleTree([], keccak256, { sortPairs: true });
    const leafBuf = Buffer.isBuffer(leaf) ? leaf : Buffer.from(leaf.replace(/^0x/, ""), "hex");
    const isValid = merkleTree.verify(proof, leafBuf, root);
    res.json({ isValid });
  } catch (e) {
    res.status(500).json({ error: "Errore verifica proof", details: e.message });
  }
});

// ...existing code...

// Non usiamo più dati finti: tutti gli endpoint lavorano solo su dati ricevuti via API

// 🔹 GET tutte le forest units (ora solo tramite POST, riceve i dati)
app.post("/api/get-forest-units", (req, res) => {
  const { forestUnits } = req.body;
  if (!forestUnits) return res.status(400).json({ error: "forestUnits richiesto" });
  res.json({ forestUnits });
});

// 🔹 GET dettagli di una forest unit (ora solo tramite POST, riceve i dati)
app.post("/api/get-forest-unit", (req, res) => {
  const { forestUnits, forestUnitKey } = req.body;
  if (!forestUnits || !forestUnitKey) return res.status(400).json({ error: "forestUnits e forestUnitKey richiesti" });
  if (!forestUnits[forestUnitKey]) return res.status(404).json({ error: "Forest Unit non trovata" });
  res.json(forestUnits[forestUnitKey]);
});

const { MerkleTree } = require("merkletreejs");
const keccak256 = require("keccak256");
function hashUnified(obj) {
  return keccak256(
    `${obj.type}|${obj.epc}|${obj.firstReading}|${obj.treeType}|${obj.extra1}|${obj.extra2}`
  );
}

// 🔹 POST Generate Merkle Root (logica reale)
app.post("/api/get-forest-units/generate-root", (req, res) => {
  const { forestUnitKey, batch } = req.body;
  if (!forestUnitKey || !batch) {
    return res.status(400).json({ error: "forestUnitKey e batch richiesti" });
  }
  try {
    const leaves = batch.map(hashUnified);
    const merkleTree = new MerkleTree(leaves, keccak256, { sortPairs: true });
    const root = merkleTree.getHexRoot();
    res.json({ forestUnitKey, root });
  } catch (e) {
    res.status(500).json({ error: "Errore generazione Merkle root", details: e.message });
  }
});

// 🔹 POST Verify Sample Proof (logica reale)
app.post("/api/get-forest-units/verify-proof", (req, res) => {
  const { leaf, proof, root } = req.body;
  if (!leaf || !proof || !root) {
    return res.status(400).json({ error: "leaf, proof e root richiesti" });
  }
  try {
    // Verifica la proof con la root
    // La MerkleTree di merkletreejs può verificare proof anche senza le foglie
    const merkleTree = new MerkleTree([], keccak256, { sortPairs: true });
    // Se leaf è hex string, convertila in buffer
    const leafBuf = Buffer.isBuffer(leaf) ? leaf : Buffer.from(leaf.replace(/^0x/, ""), "hex");
    const isValid = merkleTree.verify(proof, leafBuf, root);
    res.json({ leaf, proof, root, isValid });
  } catch (e) {
    res.status(500).json({ error: "Errore verifica proof", details: e.message });
  }
});

// 🔹 POST aggiungi albero (ora solo tramite POST, riceve forestUnits e tree)
app.post("/api/add-tree", (req, res) => {
  const { forestUnits, forestUnitKey, tree } = req.body;
  if (!forestUnits || !forestUnitKey || !tree) return res.status(400).json({ error: "forestUnits, forestUnitKey e tree richiesti" });
  if (!forestUnits[forestUnitKey]) return res.status(404).json({ error: "Forest Unit non trovata" });
  forestUnits[forestUnitKey].trees = forestUnits[forestUnitKey].trees || {};
  forestUnits[forestUnitKey].trees[tree.epc] = tree;
  res.json({ forestUnits });
});

// 🔹 POST aggiungi tronco (ora solo tramite POST, riceve forestUnits, treeEpc, woodLog)
app.post("/api/add-woodlog", (req, res) => {
  const { forestUnits, forestUnitKey, treeEpc, woodLog } = req.body;
  if (!forestUnits || !forestUnitKey || !treeEpc || !woodLog) return res.status(400).json({ error: "forestUnits, forestUnitKey, treeEpc e woodLog richiesti" });
  const tree = forestUnits[forestUnitKey]?.trees?.[treeEpc];
  if (!tree) return res.status(404).json({ error: "Albero non trovato" });
  tree.woodLogs = tree.woodLogs || {};
  tree.woodLogs[woodLog.epc] = woodLog;
  res.json({ forestUnits });
});

// 🔹 POST aggiungi tavola segata (ora solo tramite POST, riceve forestUnits, woodLogEpc, sawnTimber)
app.post("/api/add-sawntimber", (req, res) => {
  const { forestUnits, forestUnitKey, woodLogEpc, sawnTimber } = req.body;
  if (!forestUnits || !forestUnitKey || !woodLogEpc || !sawnTimber) return res.status(400).json({ error: "forestUnits, forestUnitKey, woodLogEpc e sawnTimber richiesti" });
  const trees = forestUnits[forestUnitKey]?.trees;
  if (!trees) return res.status(404).json({ error: "Forest Unit non trovata" });
  let found = false;
  for (const tree of Object.values(trees)) {
    if (tree.woodLogs && tree.woodLogs[woodLogEpc]) {
      tree.woodLogs[woodLogEpc].sawnTimbers = tree.woodLogs[woodLogEpc].sawnTimbers || {};
      tree.woodLogs[woodLogEpc].sawnTimbers[sawnTimber.epc] = sawnTimber;
      found = true;
      break;
    }
  }
  if (!found) return res.status(404).json({ error: "Tronco non trovato" });
  res.json({ forestUnits });
});

// Avvio server
app.listen(port, () => {
  console.log(`✅ Mock API server in esecuzione su http://localhost:${port}`);
});
