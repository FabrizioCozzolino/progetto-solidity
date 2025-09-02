const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { MerkleTree } = require("merkletreejs");
const keccak256 = require("keccak256");

const API_URL = "https://digimedfor.topview.it/api/get-forest-units/";
const AUTH_TOKEN = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0b2tlbl90eXBlIjoiYWNjZXNzIiwiZXhwIjoxNzU2ODEzMDE3LCJpYXQiOjE3NTY4MDk0MTcsImp0aSI6ImZjMTc1NmY4YzE0ZjRjMTM5NTQzNDM2YjM5ZmRjZDlhIiwidXNlcl9pZCI6MTE0fQ.KNNw1GalvGUIwRUK3QWY58GNiM8s6dwQi9JSqvMMiDs";

// Funzione per hash unificato
function hashUnified(obj) {
  return keccak256(
    `${obj.type}|${obj.epc}|${obj.firstReading}|${obj.treeType}|${obj.extra1}|${obj.extra2}`
  );
}

async function main() {
  // 1️⃣ Recupera forest units dall'API
  let response;
  try {
    response = await axios.get(API_URL, { headers: { Authorization: AUTH_TOKEN } });
  } catch (e) {
    console.error("❌ Errore chiamata API:", e.message);
    process.exit(1);
  }

  const forestUnits = response.data.forestUnits;
  if (!forestUnits || Object.keys(forestUnits).length === 0) {
    console.error("❌ Nessuna forest unit trovata!");
    process.exit(1);
  }

  // Per semplicità prendiamo la prima forest unit
  const firstKey = Object.keys(forestUnits)[0];
  const unit = forestUnits[firstKey];

  const unifiedLeaves = [];
  const unifiedBatch = [];

  const treesDict = unit.trees || {};
  for (const treeId of Object.keys(treesDict)) {
    const tree = treesDict[treeId];
    const epc = tree.domainUUID || tree.domainUuid || treeId;
    const firstReading = tree.firstReadingTime ? Math.floor(new Date(tree.firstReadingTime).getTime() / 1000) : 0;
    const treeType = tree.treeType?.specie || "";
    const coord = tree.coordinates ? `${tree.coordinates.latitude},${tree.coordinates.longitude}` : "";
    const obs = tree.notes || "";

    const treeEntry = { type: "Tree", epc, firstReading, treeType, extra1: coord, extra2: obs };
    unifiedBatch.push(treeEntry);
    unifiedLeaves.push(hashUnified(treeEntry));

    if (tree.woodLogs) {
      for (const logEpc of Object.keys(tree.woodLogs)) {
        const log = tree.woodLogs[logEpc];
        const obsLog = (log.observations || []).map(o => `${o.phenomenonType?.phenomenonTypeName || ""}: ${o.quantity} ${o.unit?.unitName || ""}`).join("; ");
        const logEntry = {
          type: "WoodLog",
          epc: logEpc,
          firstReading: log.firstReadingTime ? Math.floor(new Date(log.firstReadingTime).getTime() / 1000) : 0,
          treeType,
          extra1: epc,
          extra2: obsLog
        };
        unifiedBatch.push(logEntry);
        unifiedLeaves.push(hashUnified(logEntry));

        const stList = log.sawnTimbers || {};
        for (const stEpc of Object.keys(stList)) {
          const st = stList[stEpc];
          const obsSt = (st.observations || []).map(o => `${o.phenomenonType?.phenomenonTypeName || ""}: ${o.quantity} ${o.unit?.unitName || ""}`).join("; ");
          const stEntry = {
            type: "SawnTimber",
            epc: st.epc || stEpc,
            firstReading: st.firstReadingTime ? Math.floor(new Date(st.firstReadingTime).getTime() / 1000) : 0,
            treeType,
            extra1: "",
            extra2: obsSt
          };
          unifiedBatch.push(stEntry);
          unifiedLeaves.push(hashUnified(stEntry));
        }
      }
    }
  }

  if (unifiedLeaves.length === 0) {
    console.error("❌ Forest Unit vuota: nessun albero, tronco o tavola trovato.");
    process.exit(1);
  }

  // 2️⃣ Calcola Merkle Root
  const merkleTree = new MerkleTree(unifiedLeaves, keccak256, { sortPairs: true });
  const root = merkleTree.getHexRoot();

  console.log(`✅ Merkle Root generata: ${root}`);

  // 3️⃣ Salva il batch unificato
  const outputDir = path.join(__dirname, "file-json");
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);
  fs.writeFileSync(path.join(outputDir, "forest-unified-batch.json"), JSON.stringify(unifiedBatch, null, 2));
  console.log("💾 Salvato: forest-unified-batch.json");

  // 4️⃣ Genera file Postman Environment
  const environment = {
    name: "ForestTracking",
    values: [
      { key: "API_URL", value: API_URL, type: "default" },
      { key: "AUTH_TOKEN", value: AUTH_TOKEN, type: "secret" },
      { key: "forestUnitKey", value: firstKey, type: "default" },
      { key: "merkleRoot", value: root, type: "default" },
      { key: "sampleLeaf", value: unifiedLeaves[0].toString("hex"), type: "default" },
      { key: "sampleProof", value: JSON.stringify(merkleTree.getHexProof(unifiedLeaves[0])), type: "default" }
    ],
    _postman_variable_scope: "environment",
    _postman_exported_at: new Date().toISOString(),
    _postman_exported_using: "Node.js Script"
  };

  fs.writeFileSync(path.join(outputDir, "foresttracking.postman_environment.json"), JSON.stringify(environment, null, 2));
  console.log("💾 Salvato: foresttracking.postman_environment.json");
}

main().catch(e => {
  console.error("❌ Errore:", e);
});
