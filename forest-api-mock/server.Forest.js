const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers"); // ethers v6

const app = express();
const PORT = 3000;

app.use(cors());
app.use(bodyParser.json());

// percorso per il file deployed.json
const deployedPath = path.join(__dirname, "deployed.json");

// se non esiste, crealo vuoto
if (!fs.existsSync(deployedPath)) {
  fs.writeFileSync(deployedPath, JSON.stringify({ ForestTracking: "" }, null, 2));
}

// mock forest units: inizialmente vuote
let forestUnits = {}; 

// API: recupera forest units per account
app.post("/api/get-forest-units-by-account", (req, res) => {
  const { account, authToken } = req.body;
  if (!account || !authToken) return res.status(400).json({ error: "Manca account o authToken" });
  
  // se non ci sono forestUnits per questo account, creane una di default
  if (!forestUnits[account]) {
    forestUnits[account] = {
      [`unit-${Date.now()}`]: { trees: {} } // crea una forest unit dinamica
    };
  }

  res.json({ forestUnits: forestUnits[account] });
});

// API: aggiungi un albero
app.post("/api/add-tree", (req, res) => {
  const { forestUnits: units, forestUnitKey, tree } = req.body;
  if (!units[forestUnitKey]) return res.status(404).json({ error: "ForestUnit non trovata" });
  units[forestUnitKey].trees[tree.epc] = tree;
  res.json({ forestUnits: units });
});

// API: aggiungi un tronco
app.post("/api/add-woodlog", (req, res) => {
  const { forestUnits: units, forestUnitKey, treeEpc, woodLog } = req.body;
  const tree = units[forestUnitKey]?.trees[treeEpc];
  if (!tree) return res.status(404).json({ error: "Albero non trovato" });
  tree.woodLogs = tree.woodLogs || {};
  tree.woodLogs[woodLog.epc] = woodLog;
  res.json({ forestUnits: units });
});

// API: aggiungi una tavola segata
app.post("/api/add-sawntimber", (req, res) => {
  const { forestUnits: units, forestUnitKey, woodLogEpc, sawnTimber } = req.body;
  const tree = Object.values(units[forestUnitKey]?.trees || {}).find(t => t.woodLogs?.[woodLogEpc]);
  if (!tree) return res.status(404).json({ error: "Tronco non trovato" });
  const woodLog = tree.woodLogs[woodLogEpc];
  woodLog.sawnTimbers = woodLog.sawnTimbers || {};
  woodLog.sawnTimbers[sawnTimber.epc] = sawnTimber;
  res.json({ forestUnits: units });
});

// provider locale Hardhat (ethers v6)
const provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");

// avvia server
app.listen(PORT, () => {
  console.log(`🌳 Forest API mock server in ascolto su http://localhost:${PORT}`);
});