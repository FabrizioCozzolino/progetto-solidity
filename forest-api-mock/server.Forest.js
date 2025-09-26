const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const axios = require("axios");
const { MerkleTree } = require("merkletreejs");
const keccak256 = require("keccak256");

const app = express();
const port = 3000;

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));

// Dati finti iniziali (puoi rimuoverli se vuoi usare solo dati da API)
let forestUnits = {
  "Vallombrosa": {
    name: "Vallombrosa",
    trees: {
      "tree1": {
        epc: "tree1",
        firstReadingTime: "2025-09-01T10:00:00Z",
        treeType: { specie: "Oak" },
        coordinates: { latitude: 43.0, longitude: 11.7 },
        notes: "Albero campione",
        woodLogs: {
          "log1": {
            epc: "log1",
            firstReadingTime: "2025-09-02T10:00:00Z",
            observations: [
              { phenomenonType: { phenomenonTypeName: "Height" }, quantity: 5, unit: { unitName: "m" } }
            ],
            sawnTimbers: {
              "st1": {
                epc: "st1",
                firstReadingTime: "2025-09-03T10:00:00Z",
                observations: [
                  { phenomenonType: { phenomenonTypeName: "Volume" }, quantity: 2, unit: { unitName: "m3" } }
                ]
              }
            }
          }
        }
      }
    }
  }
};

// Funzione hash unificata per Merkle Tree
function hashUnified(obj) {
  return keccak256(
    `${obj.type || ''}|${obj.epc || ''}|${obj.firstReading || ''}|${obj.treeType || ''}|${obj.extra1 || ''}|${obj.extra2 || ''}`
  );
}

// 🔹 Endpoint POST: tutte le forest units di un account tramite API esterna
app.post("/api/get-forest-units-by-account", async (req, res) => {
  const { account, authToken } = req.body;
  if (!account || !authToken) return res.status(400).json({ error: "account e authToken richiesti" });

  const API_URL = "https://digimedfor.topview.it/api/get-forest-units/";
  try {
    const response = await axios.get(API_URL, { headers: { Authorization: authToken } });
    const forestUnits = response.data.forestUnits;
    console.log("\n🌲 Forest Units disponibili:\n");
    Object.entries(forestUnits).forEach(([key, val], index) => {
      console.log(`${index + 1}) ${val.name || "(senza nome)"} — key: ${key}`);
    });
    res.json({ forestUnits });
  } catch (e) {
    res.status(500).json({ error: "Errore chiamata API esterna", details: e.message });
  }
});

// 🔹 Endpoint POST: calcola Merkle root da batch ricevuto
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

// 🔹 Endpoint POST: calcola Merkle proof
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

// 🔹 Endpoint POST: verifica Merkle proof
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

// 🔹 Endpoint POST: aggiungi albero
app.post("/api/add-tree", (req, res) => {
  const { forestUnits, forestUnitKey, tree } = req.body;
  if (!forestUnits || !forestUnitKey || !tree) return res.status(400).json({ error: "forestUnits, forestUnitKey e tree richiesti" });

  forestUnits[forestUnitKey].trees = forestUnits[forestUnitKey].trees || {};
  forestUnits[forestUnitKey].trees[tree.epc] = tree;
  res.json({ forestUnits });
});

// 🔹 Endpoint POST: aggiungi tronco
app.post("/api/add-woodlog", (req, res) => {
  const { forestUnits, forestUnitKey, treeEpc, woodLog } = req.body;
  if (!forestUnits || !forestUnitKey || !treeEpc || !woodLog) return res.status(400).json({ error: "forestUnits, forestUnitKey, treeEpc e woodLog richiesti" });

  const tree = forestUnits[forestUnitKey]?.trees?.[treeEpc];
  if (!tree) return res.status(404).json({ error: "Albero non trovato" });

  tree.woodLogs = tree.woodLogs || {};
  tree.woodLogs[woodLog.epc] = woodLog;
  res.json({ forestUnits });
});

// 🔹 Endpoint POST: aggiungi tavola segata
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

// 🔹 Avvio server
app.listen(port, () => {
  console.log(`Server Forest mock in ascolto su http://localhost:${port}`);
});