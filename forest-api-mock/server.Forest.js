const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const https = require("https");
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
const provider = new ethers.providers.JsonRpcProvider("http://127.0.0.1:8545"); // localhost Hardhat
const signer = new ethers.Wallet("<PRIVATE_KEY>", provider); // Metti la tua private key qui

// ABI e address del contratto
const contractJson = require("./artifacts/contracts/ForestTracking.sol/ForestTracking.json");
const CONTRACT_ADDRESS = "<CONTRACT_ADDRESS>";
const contract = new ethers.Contract(CONTRACT_ADDRESS, contractJson.abi, signer);

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

// --- KEEP TUTTI GLI ALTRI app.get / app.post ---
// ... tutti i tuoi endpoint già esistenti qui rimangono invariati ...

// --- Endpoint unificato: crea ForestUnit, calcola Merkle root e scrive blockchain ---
app.post("/api/forest-units/unified", async (req, res) => {
  const { forestUnitId, accountId } = req.body;
  if (!forestUnitId || !accountId) 
    return res.status(400).json({ error: "forestUnitId e accountId richiesti" });

  try {
    // 1️⃣ Creazione Forest Unit
    if (!forestUnits[forestUnitId]) {
      forestUnits[forestUnitId] = { accountId, trees: {}, woodLogs: {}, sawnTimbers: {} };
    }

    const forestUnit = forestUnits[forestUnitId];

    // 2️⃣ Calcolo Merkle root unificata
    const batch = [];
    const leaves = [];
    const seenEpcs = new Set();

    const processObjects = (objsDict, type) => {
      for (const key of Object.keys(objsDict)) {
        const obj = objsDict[key];
        let epc;
        if (type === "Tree") epc = normalizeEpc(obj.epc || obj.domainUUID || key, "");
        else if (type === "WoodLog") epc = normalizeEpc(obj.EPC || obj.epc || obj.domainUUID || key, obj.parentTree || "");
        else epc = normalizeEpc(obj.EPC || obj.epc || obj.domainUUID || key, obj.parentWoodLog || "");

        if (seenEpcs.has(epc)) continue;
        seenEpcs.add(epc);

        const unifiedObj = {
          type,
          epc,
          firstReading: obj.firstReadingTime || "",
          treeType: obj.treeType?.specie || obj.treeType || "Unknown",
          parentTree: obj.parentTree || "",
          parentWoodLog: obj.parentWoodLog || "",
          coordinates: obj.coordinates ? `${obj.coordinates.latitude || obj.coordinates.lat || ""},${obj.coordinates.longitude || obj.coordinates.lon || ""}`.replace(/(^,|,$)/g, "") : "",
          notes: Array.isArray(obj.notes) ? obj.notes.map(n => n.description || n).join("; ") : obj.notes || "",
          observations: getObservations(obj),
          forestUnitId,
          domainUUID: epc,
          deleted: obj.deleted || false,
          lastModification: obj.lastModification || ""
        };

        batch.push(unifiedObj);
        leaves.push(hashUnified(unifiedObj));
      }
    };

    processObjects(forestUnit.trees, "Tree");
    processObjects(forestUnit.woodLogs, "WoodLog");
    processObjects(forestUnit.sawnTimbers, "SawnTimber");

    const merkleTree = new MerkleTree(leaves, keccak256, { sortPairs: true });
    const root = merkleTree.getHexRoot();

    // 3️⃣ Scrittura reale su blockchain
    const txResponse = await contract["setMerkleRootUnified(string,bytes32)"](forestUnitId, root);
    const receipt = await txResponse.wait();

    // 4️⃣ Salvataggio batch in JSON
    const outputDir = path.join(__dirname, "file-json");
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);
    fs.writeFileSync(path.join(outputDir, "forest-unified-batch.json"), JSON.stringify(batch, null, 2));

    res.json({
      message: "ForestUnit creata, Merkle root generata e scritta su blockchain",
      forestUnitId,
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