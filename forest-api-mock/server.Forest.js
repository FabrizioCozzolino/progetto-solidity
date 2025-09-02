const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");

const app = express();
const port = 3000;

app.use(cors());
app.use(bodyParser.json());

// Dati finti per test
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

// 🔹 GET tutte le forest units
app.get("/api/get-forest-units", (req, res) => {
  res.json({ forestUnits });
});

// 🔹 GET dettagli di una forest unit
app.get("/api/get-forest-units/:forestUnitKey", (req, res) => {
  const key = req.params.forestUnitKey;
  if (!forestUnits[key]) {
    return res.status(404).json({ error: "Forest Unit non trovata" });
  }
  res.json(forestUnits[key]);
});

// 🔹 POST Generate Merkle Root
app.post("/api/get-forest-units/generate-root", (req, res) => {
  const { forestUnitKey, batch } = req.body;
  if (!forestUnitKey || !batch) {
    return res.status(400).json({ error: "forestUnitKey e batch richiesti" });
  }

  // Calcolo fittizio della Merkle Root
  const root = "0x123456789abcdef";

  res.json({ forestUnitKey, root });
});

// 🔹 POST Verify Sample Proof
app.post("/api/get-forest-units/verify-proof", (req, res) => {
  const { leaf, proof, root } = req.body;
  if (!leaf || !proof || !root) {
    return res.status(400).json({ error: "leaf, proof e root richiesti" });
  }

  // Simula la verifica della proof
  const isValid = true;

  res.json({ leaf, proof, root, isValid });
});

// 🔹 POST aggiungi albero
app.post("/api/get-forest-units/add-tree", (req, res) => {
  const { forestUnitKey, tree } = req.body;
  if (!forestUnits[forestUnitKey]) {
    return res.status(404).json({ error: "Forest Unit non trovata" });
  }
  forestUnits[forestUnitKey].trees[tree.epc] = tree;
  res.json({ success: true });
});

// 🔹 POST aggiungi tronco
app.post("/api/get-forest-units/add-woodlog", (req, res) => {
  const { forestUnitKey, treeEpc, woodLog } = req.body;
  const tree = forestUnits[forestUnitKey]?.trees[treeEpc];
  if (!tree) return res.status(404).json({ error: "Albero non trovato" });

  tree.woodLogs = tree.woodLogs || {};
  tree.woodLogs[woodLog.epc] = woodLog;
  res.json({ success: true });
});

// 🔹 POST aggiungi tavola segata
app.post("/api/get-forest-units/add-sawntimber", (req, res) => {
  const { forestUnitKey, woodLogEpc, sawnTimber } = req.body;
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

  res.json({ success: true });
});

// Avvio server
app.listen(port, () => {
  console.log(`✅ Mock API server in esecuzione su http://localhost:${port}`);
});
