const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { MerkleTree } = require("merkletreejs");
const keccak256 = require("keccak256");
const ethers = require("ethers");
const fs = require("fs");
const path = require("path");
const { create } = require("ipfs-http-client");

const ipfs = create({ url: "http://127.0.0.1:5002" });


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

// --- Funzione helper: scarica JSON da IPFS con fallback gateway/protocollo
async function fetchFromIPFS(ipfsHash) {
  const gateways = [
    "ipfs.io",
    "cloudflare-ipfs.com",
    "dweb.link",
    "gateway.pinata.cloud",
    "infura-ipfs.io"
  ];

  let lastError = null;
  for (const gateway of gateways) {
    for (const protocol of ["https", "http"]) {
      const url = `${protocol}://${gateway}/ipfs/${ipfsHash}`;
      try {
        console.log(`⬇️  Tentativo download da IPFS: ${url}`);
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP error ${response.status}`);
        const data = await response.json();
        return data; // ritorna al primo download riuscito
      } catch (err) {
        console.warn(`⚠️ Fallito da ${url}: ${err.message}`);
        lastError = err;
      }
    }
  }
  throw new Error(`Impossibile scaricare il file da IPFS con nessun gateway: ${lastError?.message}`);
}

// --- ENDPOINTS ---
// 0️⃣ POST: aggiungi un'intera forest unit (con alberi, tronchi e tavole)
app.post("/api/forest-units/addForestUnit", (req, res) => {
  try {
    let data = req.body;

    // Se arriva un singolo oggetto, trasformalo in array
    if (!Array.isArray(data)) {
      data = [data];
    }

    if (data.length === 0) {
      return res.status(400).json({ error: "Il body deve contenere almeno una forest unit valida" });
    }

    const addedUnits = [];

    for (const unit of data) {
      const { forestUnitId, accountId, trees = {}, woodLogs = {}, sawnTimbers = {} } = unit;

      if (!forestUnitId || !accountId) {
        console.warn("⚠️ Forest unit ignorata: manca forestUnitId o accountId");
        continue;
      }

      // Se non esiste ancora, inizializza la forest unit
      if (!forestUnits[forestUnitId]) {
        forestUnits[forestUnitId] = { accountId, trees: {}, woodLogs: {}, sawnTimbers: {} };
      }

      const current = forestUnits[forestUnitId];
      current.accountId = accountId;

      // Funzione per agganciare sawnTimbers a tronchi
      const attachSawnTimbers = (log, stList) => {
        for (const [stId, st] of Object.entries(stList)) {
          current.sawnTimbers[stId] = st;
          if (!log.sawnTimbers) log.sawnTimbers = {};
          log.sawnTimbers[stId] = st;
        }
      };

      // Aggiungi alberi e i loro woodLogs e sawnTimbers
      for (const [treeId, tree] of Object.entries(trees)) {
        current.trees[treeId] = tree;

        if (tree.woodLogs) {
          for (const [logId, log] of Object.entries(tree.woodLogs)) {
            current.woodLogs[logId] = log;
            if (!current.trees[treeId].woodLogs) current.trees[treeId].woodLogs = {};
            current.trees[treeId].woodLogs[logId] = log;

            if (log.sawnTimbers) attachSawnTimbers(log, log.sawnTimbers);
          }
        }
      }

      // Aggiungi woodLogs di primo livello
      for (const [logId, log] of Object.entries(woodLogs)) {
        current.woodLogs[logId] = log;

        // Aggancia a parentTree se presente
        if (log.parentTree && current.trees[log.parentTree]) {
          if (!current.trees[log.parentTree].woodLogs) current.trees[log.parentTree].woodLogs = {};
          current.trees[log.parentTree].woodLogs[logId] = log;
        }

        if (log.sawnTimbers) attachSawnTimbers(log, log.sawnTimbers);
      }

      // Aggiungi sawnTimbers di primo livello
      for (const [stId, st] of Object.entries(sawnTimbers)) {
        current.sawnTimbers[stId] = st;

        // Aggancia al parentWoodLog se presente
        if (st.parentWoodLog && current.woodLogs[st.parentWoodLog]) {
          if (!current.woodLogs[st.parentWoodLog].sawnTimbers) current.woodLogs[st.parentWoodLog].sawnTimbers = {};
          current.woodLogs[st.parentWoodLog].sawnTimbers[stId] = st;
        }
      }

      addedUnits.push(forestUnitId);
    }

    res.json({
      message: "✅ Forest unit aggiunte correttamente",
      addedUnits,
      total: addedUnits.length
    });
  } catch (err) {
    console.error("❌ Errore durante addForestUnit:", err);
    res.status(500).json({ error: "Errore durante addForestUnit", details: err.message });
  }
});

// 1️⃣ GET: ottieni forest units per account
app.get("/api/forest-units/:account", (req, res) => {
  const accountId = req.params.account;
  const units = Object.keys(forestUnits)
    .filter(key => forestUnits[key].accountId === accountId)
    .map(key => ({ forestUnitId: key, ...forestUnits[key] }));
  res.json(units);
});

app.get("/api/forest-units/full/:forestUnitId", (req, res) => {
  const { forestUnitId } = req.params;
  const unit = forestUnits[forestUnitId];
  if (!unit) return res.status(404).json({ error: "ForestUnit non trovata" });
  res.json(unit);
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

// POST: unifica forest unit, upload su IPFS e registra on-chain
app.post("/api/forest-units/unified", async (req, res) => {
  const { forestUnitId, accountId } = req.body;

  if (!forestUnitId || !accountId) {
    return res.status(400).json({ error: "forestUnitId e accountId richiesti" });
  }

  try {
    // --- Creazione/aggiornamento forest unit in memoria
    if (!forestUnits[forestUnitId]) {
      forestUnits[forestUnitId] = { accountId, trees: {}, woodLogs: {}, sawnTimbers: {} };
    } else {
      forestUnits[forestUnitId].accountId = accountId;
    }

    const unit = forestUnits[forestUnitId];
    const batch = [];
    const leaves = [];
    const seenEpcs = new Set();

    const processObservations = obj => getObservations(obj);

    // --- Batch completo (Trees + WoodLogs + SawnTimbers)
    for (const treeId of Object.keys(unit.trees)) {
      const t = unit.trees[treeId];
      const treeEpc = t.domainUUID || t.domainUuid || t.epc || treeId;

      const treeObj = {
        type: "Tree",
        epc: treeEpc,
        firstReading: t.firstReadingTime ? Math.floor(new Date(t.firstReadingTime).getTime() / 1000) : 0,
        treeType: t.treeType?.specie || t.treeTypeId || t.specie || "Unknown",
        coordinates: t.coordinates ? `${t.coordinates.latitude || t.coordinates.lat || ""},${t.coordinates.longitude || t.coordinates.lon || ""}`.replace(/(^,|,$)/g, "") : "",
        notes: Array.isArray(t.notes) ? t.notes.map(n => n.description || n).join("; ") : t.notes || "",
        observations: processObservations(t),
        forestUnitId,
        domainUUID: treeEpc,
        deleted: t.deleted || false,
        lastModification: t.lastModification || t.lastModfication || ""
      };

      batch.push(treeObj);
      leaves.push(hashUnified(treeObj));
      seenEpcs.add(treeEpc);

      // WoodLogs
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
          forestUnitId,
          domainUUID: log.domainUUID || log.domainUuid || logEpc,
          deleted: log.deleted || false,
          lastModification: log.lastModification || log.lastModfication || ""
        };

        batch.push(logObj);
        leaves.push(hashUnified(logObj));

        // SawnTimbers
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
            forestUnitId,
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
      return res.status(400).json({ error: "Impossibile generare Merkle root: nessun elemento valido" });
    }

    // --- Generazione Merkle root unificata
    const merkleTree = new MerkleTree(leaves, keccak256, { sortPairs: true });
    const root = "0x" + merkleTree.getRoot().toString("hex");

    // --- Salvataggio JSON locale
    const outputDir = path.join(__dirname, "file-json");
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);
    const filePath = path.join(outputDir, `${forestUnitId}-unified-batch.json`);
    fs.writeFileSync(filePath, JSON.stringify(batch, null, 2));

    // --- Upload su IPFS
    const ipfsResult = await ipfs.add(fs.readFileSync(filePath));
    const ipfsHash = ipfsResult.path;

    console.log(`✅ File caricato su IPFS: ${ipfsHash}`);

    // --- Registrazione su blockchain
    const tx = await contract.registerForestData(forestUnitId, root, ipfsHash);
    const receipt = await tx.wait();

    res.json({
      message: "ForestUnit registrata correttamente su blockchain",
      forestUnitId,
      merkleRoot: root,
      ipfsHash,
      txHash: receipt.transactionHash,
      batchSize: batch.length
    });

  } catch (err) {
    console.error("❌ Errore durante unificazione forestUnit:", err);
    res.status(500).json({ error: "Errore durante unificazione forestUnit", details: err.message });
  }
});

// 6️⃣ POST: verifica integrità batch da IPFS e on-chain (versione robusta migliorata)
app.post("/api/forest-units/verify", async (req, res) => {
  try {
    const { forestUnitId, ipfsHash: providedIpfsHash } = req.body;
    if (!forestUnitId) {
      return res.status(400).json({ error: "Parametro 'forestUnitId' richiesto" });
    }

    // --- Recupera dati on-chain
    let merkleRootOnChain = null;
    let ipfsHashOnChain = null;
    try {
      const result = await contract.getForestData(forestUnitId);
      if (result && result[0] && result[0] !== ethers.ZeroHash) {
        merkleRootOnChain = result[0];
        ipfsHashOnChain = result[1];
      } else {
        console.warn(`⚠️ Nessun dato on-chain trovato per ${forestUnitId}`);
      }
    } catch (err) {
      console.warn(`⚠️ Errore recupero dati on-chain: ${err.message}`);
    }

    const finalIpfsHash = providedIpfsHash || ipfsHashOnChain;
    let batch = null;

    // --- 1️⃣ Tentativo download da IPFS
    if (finalIpfsHash) {
      const gateways = [
        `https://ipfs.io/ipfs/${finalIpfsHash}`,
        `https://cloudflare-ipfs.com/ipfs/${finalIpfsHash}`,
        `https://dweb.link/ipfs/${finalIpfsHash}`,
        `https://gateway.pinata.cloud/ipfs/${finalIpfsHash}`
      ];

      for (const url of gateways) {
        try {
          console.log(`⬇️  Tentativo download da IPFS: ${url}`);
          const response = await fetch(url);
          if (response.ok) {
            batch = await response.json();

            // 🔽 Salva il batch in locale per uso futuro
            const localDir = path.join(__dirname, "batches");
            if (!fs.existsSync(localDir)) fs.mkdirSync(localDir);
            const localFile = path.join(localDir, `${forestUnitId}.json`);
            fs.writeFileSync(localFile, JSON.stringify(batch, null, 2));
            console.log(`💾 Batch salvato localmente in ${localFile}`);

            break; // download riuscito, esci dal ciclo
          } else {
            console.warn(`⚠️ Fallito da ${url}: HTTP ${response.status}`);
          }
        } catch (err) {
          console.warn(`⚠️ Fallito da ${url}: ${err.message}`);
        }
      }
    }

    // --- 2️⃣ Se IPFS fallisce, prova lettura locale
    if (!batch) {
      const possiblePaths = [
        path.join(__dirname, "batches", `${forestUnitId}.json`),
        path.join(__dirname, "file-json", `${forestUnitId}-unified-batch.json`)
      ];

      let foundPath = null;
      for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
          foundPath = p;
          break;
        }
      }

      if (foundPath) {
        console.log(`📂 Lettura batch locale da: ${foundPath}`);
        const data = fs.readFileSync(foundPath, "utf-8");
        batch = JSON.parse(data);
      } else {
        return res.status(404).json({
          error: `Impossibile recuperare il batch da IPFS o localmente: file non trovato (${forestUnitId}.json)`
        });
      }
    }

    if (!Array.isArray(batch) || batch.length === 0) {
      return res.status(400).json({ error: "Batch vuoto o non valido" });
    }

    // --- 3️⃣ Ricostruisci gli hash locali
    const leaves = batch.map(item => hashUnified(item));
    const merkleTree = new MerkleTree(leaves, keccak256, { sortPairs: true });
    const recalculatedRoot = "0x" + merkleTree.getRoot().toString("hex");

    // --- 4️⃣ Confronto con root on-chain
    let verified = null;
    let message = "⚠️ ForestUnit non ancora registrata on-chain, impossibile verificare root.";
    if (merkleRootOnChain) {
      verified = recalculatedRoot.toLowerCase() === merkleRootOnChain.toLowerCase();
      message = verified
        ? "✅ Merkle Root verificata con successo: i dati sono integri."
        : "⚠️ Discrepanza tra Merkle Root IPFS/local e quella on-chain!";
    }

    res.json({
      forestUnitId,
      ipfsHash: finalIpfsHash,
      recalculatedRoot,
      merkleRootOnChain,
      verified,
      message
    });

  } catch (err) {
    console.error("❌ Errore verifica Merkle Root:", err);
    res.status(500).json({
      error: "Errore durante la verifica Merkle Root",
      details: err.message
    });
  }
});

// 7️⃣ Verifica automatica periodica di integrità delle forest unit
async function verifyBatchIntegrity(forestUnitId) {
  try {
    console.log(`🔍 Avvio controllo integrità per ${forestUnitId}...`);

    // --- Recupera dati on-chain
    const result = await contract.getForestData(forestUnitId);
    const merkleRootOnChain = result[0];
    const ipfsHashOnChain = result[1];

    if (!merkleRootOnChain || merkleRootOnChain === ethers.ZeroHash) {
      console.warn(`⚠️ Nessuna root registrata on-chain per ${forestUnitId}`);
      return { forestUnitId, verified: false, message: "ForestUnit non registrata on-chain" };
    }

    // --- Recupera batch (locale o IPFS)
    const localPaths = [
      path.join(__dirname, "batches", `${forestUnitId}.json`),
      path.join(__dirname, "file-json", `${forestUnitId}-unified-batch.json`)
    ];

    let batch = null;
    for (const p of localPaths) {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, "utf-8");
        batch = JSON.parse(raw);
        console.log(`📂 Batch locale trovato: ${p}`);
        break;
      }
    }

    if (!batch) {
      console.log(`⬇️ Nessun batch locale trovato, tentativo download da IPFS (${ipfsHashOnChain})...`);
      batch = await fetchFromIPFS(ipfsHashOnChain);
      const dir = path.join(__dirname, "batches");
      if (!fs.existsSync(dir)) fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, `${forestUnitId}.json`), JSON.stringify(batch, null, 2));
      console.log("💾 Batch scaricato e salvato localmente.");
    }

    // --- Ricostruisci Merkle Root locale
    const leaves = batch.map(item => hashUnified(item));
    const merkleTree = new MerkleTree(leaves, keccak256, { sortPairs: true });
    const localRoot = "0x" + merkleTree.getRoot().toString("hex");

    // --- Confronto
    const verified = localRoot.toLowerCase() === merkleRootOnChain.toLowerCase();

    const resultObj = {
      forestUnitId,
      ipfsHash: ipfsHashOnChain,
      localRoot,
      merkleRootOnChain,
      verified,
      message: verified
        ? "✅ Dati integri: Merkle Root locale e on-chain coincidono."
        : "⚠️ Discrepanza rilevata! Merkle Root differente da quella on-chain."
    };

    console.log(resultObj.message);
    return resultObj;

  } catch (err) {
    console.error(`❌ Errore nella verifica di ${forestUnitId}:`, err.message);
    return { forestUnitId, verified: false, message: "Errore durante verifica: " + err.message };
  }
}

// API per controllo integrità (manuale)
app.get("/api/check-integrity/:forestUnitId", async (req, res) => {
  const { forestUnitId } = req.params;
  const result = await verifyBatchIntegrity(forestUnitId);
  res.json(result);
});

// ⏱️ Verifica automatica ogni 10 minuti per tutte le forest unit note
setInterval(async () => {
  console.log("⏱️ Avvio controllo automatico integrità di tutte le forest unit note...");
  const allUnits = Object.keys(forestUnits);
  if (allUnits.length === 0) {
    console.log("ℹ️ Nessuna forest unit presente in memoria, skip.");
    return;
  }

  for (const fid of allUnits) {
    const result = await verifyBatchIntegrity(fid);
    if (!result.verified) {
      console.log(`🚨 ALERT: Dati alterati o non coerenti per ${fid}!`);
    }
  }
}, 10 * 60 * 1000); // ogni 10 minuti


app.listen(port, () => console.log(`Server avviato su http://localhost:${port}`));