/**
 * server.registerRicardianForest.js
 * FLOW completo identico allo script:
 * 1) TopView login
 * 2) get-forest-units, seleziona latest
 * 3) build unified batch + merkle
 * 4) build ricardian base + hash + EIP-712 + PDF
 * 5) upload ricardian json to IPFS (ipfs://CID/ricardian-forest.json) + pin (se daemon supporta pin)
 * 6) estimate gas + EUR
 * 7) registerRicardianForest on-chain
 * 8) verify ipfs hash == ricardianHash
 * 9) verify merkle proofs
 */

require("dotenv").config({ path: "./environment_variables.env" });

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");

const axios = require("axios");
const https = require("https");

const { MerkleTree } = require("merkletreejs");
const keccak256 = require("keccak256");
const ethers = require("ethers");

const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");

const { create } = require("ipfs-http-client");

// --------------------
// CONFIG
// --------------------
const PORT = Number(process.env.PORT || 3000);

// TopView endpoints (come tuo script)
const TOPVIEW_TOKEN_URL = process.env.TOPVIEW_TOKEN_URL || "https://digimedfor.topview.it/api/get-token/";
const TOPVIEW_FOREST_UNITS_URL = process.env.TOPVIEW_FOREST_UNITS_URL || "https://digimedfor.topview.it/api/get-forest-units/";
const TOPVIEW_USERNAME = process.env.TOPVIEW_USERNAME || "operator";
const TOPVIEW_PASSWORD = process.env.TOPVIEW_PASSWORD || "1234567!";
const TOPVIEW_HTTPS_INSECURE = (process.env.TOPVIEW_HTTPS_INSECURE || "true") === "true";

// EVM / Contract
const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
const PRIVATE_KEY =
  process.env.PRIVATE_KEY ||
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

// IPFS daemon locale (come nel tuo progetto)
const IPFS_URL = process.env.IPFS_URL || "http://127.0.0.1:5004/api/v0";

// --------------------
// APP
// --------------------
const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "50mb" }));

// --------------------
// IPFS CLIENT
// --------------------
const ipfs = create({ url: IPFS_URL });

// --------------------
// ETHERS SETUP
// --------------------
const provider = new ethers.JsonRpcProvider(RPC_URL);
const signer = new ethers.Wallet(PRIVATE_KEY, provider);

// deployed.json + artifact ABI
const deployed = require("./deployed.json");
const contractJson = require(path.resolve(
  __dirname,
  "../artifacts/contracts/ForestTracking.sol/ForestTracking.json"
));
const contract = new ethers.Contract(deployed.ForestTracking, contractJson.abi, signer);

// --------------------
// IN-MEMORY STORE
// --------------------
const state = {
  topview: { token: null, lastLoginAt: null },
  forestUnitsRemote: null, // raw response forestUnits
  lastImportedForestUnitKey: null,
  // local cache for batch/proofs
  batches: {
    // [forestUnitId]: { batch, leaves, merkleTree, root, batchFilePath }
  },
  ricardians: {
    // [forestUnitId]: { ricardianBase, ricardianForest, ricardianHash, jsonPath, pdfPath, ipfsUri, cid }
  }
};

// --------------------
// UTILS
// --------------------
function toKeccak256Json(obj) {
  return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(obj)));
}

function normalizeEpc(epcRaw, seed = "") {
  if (!epcRaw && !seed) return "";
  const s = String(epcRaw || "");
  if (s.toUpperCase().startsWith("E")) return s;
  const h = keccak256(s + "|" + seed).toString("hex").toUpperCase();
  return "E280" + h.slice(0, 20);
}

function hashUnified(obj) {
  return keccak256(
    `${obj.type}|${obj.epc}|${obj.firstReading}|${obj.treeType || ""}|${obj.coordinates || ""}|${obj.notes || ""}|${obj.parentTree || ""}|${obj.parentWoodLog || ""}|${obj.observations || ""}|${obj.forestUnitId || ""}|${obj.domainUUID || ""}|${obj.deleted ? 1 : 0}|${obj.lastModification || ""}`
  );
}

function normalizeObservations(obsArrayOrString) {
  if (!obsArrayOrString) return "";
  if (typeof obsArrayOrString === "string") return obsArrayOrString.trim();
  if (!Array.isArray(obsArrayOrString) || obsArrayOrString.length === 0) return "";

  return obsArrayOrString
    .map(o => {
      const name =
        o.phenomenonType?.phenomenonTypeName ||
        o.phenomenonName ||
        o.phenomenonTypeId ||
        "";
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
    const res = await axios.get(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=eur"
    );
    return res.data.ethereum.eur;
  } catch {
    console.warn("⚠️ Errore recupero ETH/EUR, uso default 3000");
    return 3000;
  }
}

// --------------------
// PDF (IDENTICO al tuo script)
// --------------------
function generateRicardianPdf(ricardian, outPath) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50, autoFirstPage: true });
    const stream = fs.createWriteStream(outPath);
    doc.pipe(stream);

    const M = doc.page.margins.left;
    const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    const COLORS = {
      text: "#111111",
      muted: "#444444",
      faint: "#777777",
      line: "#D0D0D0",
      boxFill: "#F5F5F5",
      accent: "#0B3D2E"
    };

    const safe = (v) => (v === null || v === undefined ? "" : String(v));
    const boolStr = (b) => (b === true ? "true" : b === false ? "false" : "—");

    const fmtJurisdiction = (j) => {
      if (Array.isArray(j)) return j.join(", ");
      if (j && typeof j === "object") {
        const parts = [];
        if (j.courts) parts.push(`Courts: ${j.courts}`);
        if (Array.isArray(j.regulatoryFramework) && j.regulatoryFramework.length) {
          parts.push(`Regulatory: ${j.regulatoryFramework.join(", ")}`);
        }
        return parts.join(" | ");
      }
      return "";
    };

    function bottomY() {
      return doc.page.height - doc.page.margins.bottom;
    }

    function ensureSpace(needed) {
      if (doc.y + needed > bottomY()) {
        doc.addPage();
      }
    }

    function addFooter() {
      const y = doc.page.height - doc.page.margins.bottom - 18;
      const prevY = doc.y;

      doc.save();
      doc.font("Helvetica").fontSize(8.5).fillColor(COLORS.faint);
      doc.text("Generated by RicardianForestTracking", M, y, { width: W, align: "left" });
      doc.text(safe(ricardian?.timestamps?.createdAt), M, y, { width: W, align: "right" });
      doc.restore();

      doc.y = prevY;
    }

    doc.on("pageAdded", addFooter);

    function measureBoxHeight(fn, minH = 70) {
      const pad = 12;
      const innerW = W - pad * 2;

      const origText = doc.text.bind(doc);
      const origMoveDown = doc.moveDown.bind(doc);
      const origY = doc.y;

      doc._measureMode = true;
      doc._measureAcc = 0;

      doc.text = function (...args) {
        if (!doc._measureMode) return origText(...args);

        let text = typeof args[0] === "string" || typeof args[0] === "number"
          ? String(args[0] ?? "")
          : "";

        let options =
          typeof args[1] === "object" ? args[1] :
          typeof args[3] === "object" ? args[3] : {};

        const width = options.width ?? innerW;
        const lineGap = options.lineGap ?? 0;

        doc._measureAcc += doc.heightOfString(text, { width, lineGap }) || 0;
        doc._measureAcc += 2;
        return doc;
      };

      doc.moveDown = function (lines = 1) {
        if (!doc._measureMode) return origMoveDown(lines);
        doc._measureAcc += doc.currentLineHeight() * (lines || 1);
        return doc;
      };

      let innerH = 0;
      try {
        const ret = fn({ x: M + pad, w: innerW, measure: true });
        innerH = typeof ret === "number" ? ret : doc._measureAcc;
      } finally {
        doc._measureMode = false;
        doc.text = origText;
        doc.moveDown = origMoveDown;
        doc.y = origY;
      }

      return Math.max(minH, innerH + pad * 2);
    }

    function box(fn, minH = 70) {
      const pad = 12;
      const boxH = measureBoxHeight(fn, minH);

      ensureSpace(boxH + 20);

      const x = M;
      const y = doc.y;

      doc.save();
      doc.fillColor(COLORS.boxFill).strokeColor(COLORS.line);
      doc.rect(x, y, W, boxH).fillAndStroke();
      doc.restore();

      doc.y = y + pad;
      fn({ x: x + pad, w: W - pad * 2, measure: false });
      doc.y = y + boxH + 14;
    }

    function sectionBox(title, fn, minH = 70) {
      const titleH = 22;
      const boxH = measureBoxHeight(fn, minH);
      ensureSpace(titleH + boxH + 20);

      doc.font("Helvetica-Bold").fontSize(12).fillColor(COLORS.text);
      doc.text(title, M, doc.y, { width: W });
      doc.moveDown(0.4);

      box(fn, minH);
    }

    function kv(label, value, x, w) {
      doc.font("Helvetica-Bold").fontSize(10).fillColor(COLORS.muted);
      doc.text(label, x, doc.y, { width: w });
      doc.moveDown(0.15);

      doc.font("Helvetica").fontSize(10).fillColor(COLORS.text);
      doc.text(safe(value) || "—", x, doc.y, { width: w, lineGap: 2 });
      doc.moveDown(0.45);
    }

    function mono(label, value, x, w) {
      doc.font("Helvetica-Bold").fontSize(10).fillColor(COLORS.muted);
      doc.text(label, x, doc.y, { width: w });
      doc.moveDown(0.25);

      doc.font("Courier").fontSize(9).fillColor(COLORS.text);
      doc.text(safe(value) || "—", x, doc.y, { width: w, lineGap: 2 });
      doc.moveDown(0.6);
    }

    doc.save().fillColor(COLORS.accent).rect(M, M - 22, W, 16).fill().restore();
    doc.font("Helvetica-Bold").fontSize(18).fillColor(COLORS.text);
    doc.text("Ricardian Contract – Forest Tracking", M, M + 5, { width: W, align: "center" });

    doc.moveDown(1);
    doc.font("Helvetica").fontSize(10).fillColor(COLORS.muted);
    doc.text(
      `Forest Unit: ${safe(ricardian?.scope?.forestUnitKey)}   •   Type: ${safe(ricardian?.type)}   •   Version: ${safe(ricardian?.version)}`,
      M,
      doc.y,
      { width: W }
    );

    addFooter();
    doc.moveDown(1);

    sectionBox("Legal & Jurisdiction", ({ x, w }) => {
      kv("Governing law", ricardian?.governingLaw, x, w);
      kv("Jurisdiction", fmtJurisdiction(ricardian?.jurisdiction), x, w);
      kv("Legal value", ricardian?.legal?.legalValue, x, w);
      kv("Statement", ricardian?.legal?.statement, x, w);
    }, 95);

    sectionBox("Actors & Scope", ({ x, w }) => {
      kv("Data owner", ricardian?.actors?.dataOwner, x, w);
      kv("Data producer", ricardian?.actors?.dataProducer, x, w);
      kv("Data consumer", ricardian?.actors?.dataConsumer, x, w);
      kv("Forest unit key", ricardian?.scope?.forestUnitKey, x, w);
      kv("Included data", (ricardian?.scope?.includedData || []).join(", "), x, w);
      kv("Purpose", ricardian?.purpose, x, w);
    }, 120);

    sectionBox("Human-readable Agreement", ({ x, w }) => {
      doc.font("Helvetica").fontSize(10.5).fillColor(COLORS.text);
      doc.text(ricardian?.humanReadableAgreement?.text || "—", x, doc.y, { width: w, lineGap: 3 });
      doc.moveDown(0.6);
      kv("Language", ricardian?.humanReadableAgreement?.language, x, w);
    }, 140);

    sectionBox("Rights & Duties", ({ x, w }) => {
      kv("Data owner", ricardian?.rightsAndDuties?.dataOwner, x, w);
      kv("Data producer", ricardian?.rightsAndDuties?.dataProducer, x, w);
      kv("Data consumer", ricardian?.rightsAndDuties?.dataConsumer, x, w);
    }, 95);

    sectionBox("Hash Binding", ({ x, w }) => {
      kv("Binds human-readable text", boolStr(ricardian?.hashBinding?.bindsHumanReadableText), x, w);
      kv("Binds dataset Merkle root", boolStr(ricardian?.hashBinding?.bindsDatasetMerkleRoot), x, w);
    }, 80);

    sectionBox("Technical Bindings", ({ x, w }) => {
      kv("Hash algorithm", ricardian?.technical?.hashAlgorithm, x, w);
      kv("Batch format", ricardian?.technical?.batchFormat, x, w);
      kv("Storage", ricardian?.technical?.storage, x, w);
      if (ricardian?.ipfsUri) kv("IPFS URI", ricardian.ipfsUri, x, w);
      mono("Merkle root", ricardian?.technical?.merkleRootUnified, x, w);
      mono("Ricardian hash", ricardian?.ricardianHash, x, w);
    }, 170);

    if (ricardian?.signature?.eip712) {
      sectionBox("EIP-712 Signature", ({ x, w }) => {
        const e = ricardian.signature.eip712;
        kv("Signer", e.signer, x, w);
        kv("ChainId", e.domain?.chainId, x, w);
        kv("Verifying contract", e.domain?.verifyingContract, x, w);
        mono("Signature", e.signature, x, w);
      }, 260);
    }

    doc.end();
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
}

// --------------------
// HEALTH
// --------------------
app.get("/health", (_, res) => res.json({ ok: true }));

// --------------------
// 1) TopView login
// --------------------
app.post("/api/topview/login", async (req, res) => {
  try {
    const username = req.body?.username || TOPVIEW_USERNAME;
    const password = req.body?.password || TOPVIEW_PASSWORD;

    const httpsAgent = new https.Agent({ rejectUnauthorized: !TOPVIEW_HTTPS_INSECURE });
    const r = await axios.post(TOPVIEW_TOKEN_URL, { username, password }, { httpsAgent });

    state.topview.token = r.data.access;
    state.topview.lastLoginAt = new Date().toISOString();

    res.json({ token: state.topview.token, lastLoginAt: state.topview.lastLoginAt });
  } catch (err) {
    res.status(500).json({ error: "TopView login failed", details: err.message });
  }
});

// --------------------
// 2) Import latest forest unit (come script: prendo l'ultima key)
// --------------------
app.post("/api/topview/import-latest", async (req, res) => {
  try {
    const token = state.topview.token;
    if (!token) return res.status(400).json({ error: "Token mancante: chiama /api/topview/login prima" });

    const httpsAgent = new https.Agent({ rejectUnauthorized: !TOPVIEW_HTTPS_INSECURE });
    const r = await axios.get(TOPVIEW_FOREST_UNITS_URL, {
      headers: { Authorization: `Bearer ${token}` },
      httpsAgent
    });

    const forestUnits = r.data.forestUnits || {};
    const keys = Object.keys(forestUnits);
    if (!keys.length) return res.status(404).json({ error: "Nessuna forest unit disponibile su TopView" });

    const selectedForestKey = keys[keys.length - 1];
    const unit = forestUnits[selectedForestKey];

    state.forestUnitsRemote = forestUnits;
    state.lastImportedForestUnitKey = selectedForestKey;
    // Salvo "unit" per build batch
    state._importedUnit = unit;

    res.json({
      forestUnitKey: selectedForestKey,
      name: unit?.name || selectedForestKey,
      totalKeys: keys.length
    });
  } catch (err) {
    res.status(500).json({ error: "Import latest forest unit failed", details: err.message });
  }
});

// --------------------
// 3) Build unified batch + merkle root (identico allo script)
// --------------------
app.post("/api/forest-units/buildUnifiedBatch", async (req, res) => {
  const forestUnitId = req.body?.forestUnitId;
  if (!forestUnitId) return res.status(400).json({ error: "forestUnitId richiesto" });

  try {
    const unit = state._importedUnit;
    if (!unit) return res.status(400).json({ error: "Nessuna forest unit importata: chiama /api/topview/import-latest prima" });

    const leaves = [];
    const batchWithProof = [];
    const seenEpcs = new Set();

    const formatDate = d => (d ? new Date(d).toISOString() : "");

    function addToBatch(obj) {
      const leafHash = hashUnified(obj);
      leaves.push(leafHash);
      batchWithProof.push({ ...obj });
      seenEpcs.add(obj.epc);
    }

    for (const treeId of Object.keys(unit.trees || {})) {
      const t = unit.trees[treeId];
      const treeEpc = t.EPC || t.epc || t.domainUUID || treeId;

      const treeObj = {
        type: "Tree",
        epc: treeEpc,
        firstReading: formatDate(t.firstReadingTime),
        treeType: t.treeType?.specie || t.treeTypeId || t.specie || "Unknown",
        coordinates: t.coordinates
          ? `${t.coordinates.latitude || t.coordinates.lat || ""},${t.coordinates.longitude || t.coordinates.lon || ""}`.replace(/(^,|,$)/g, "")
          : "",
        notes: Array.isArray(t.notes) ? t.notes.map(n => n.description || n).join("; ") : t.notes || "",
        observations: getObservations(t),
        forestUnitId,
        domainUUID: t.domainUUID || t.domainUuid,
        deleted: t.deleted || false,
        lastModification: t.lastModification || t.lastModfication || ""
      };
      addToBatch(treeObj);

      for (const logKey of Object.keys(t.woodLogs || {})) {
        let log = t.woodLogs[logKey];
        if (typeof log === "string") log = (unit.woodLogs && unit.woodLogs[log]) || {};
        const logEpc = normalizeEpc(log.EPC || log.epc || log.domainUUID, treeEpc);
        if (seenEpcs.has(logEpc)) continue;

        const logObj = {
          type: "WoodLog",
          epc: logEpc,
          firstReading: formatDate(log.firstReadingTime),
          treeType: t.treeType?.specie || t.treeTypeId || "Unknown",
          logSectionNumber: log.logSectionNumber || 1,
          parentTree: treeEpc,
          coordinates: log.coordinates
            ? `${log.coordinates.latitude || log.coordinates.lat || ""},${log.coordinates.longitude || log.coordinates.lon || ""}`.replace(/(^,|,$)/g, "")
            : "",
          notes: Array.isArray(log.notes) ? log.notes.map(n => n.description || n).join("; ") : log.notes || "",
          observations: getObservations(log),
          forestUnitId,
          domainUUID: log.domainUUID || log.domainUuid,
          deleted: log.deleted || false,
          lastModification: log.lastModification || log.lastModfication || ""
        };
        addToBatch(logObj);

        for (const stKey of Object.keys(log.sawnTimbers || {})) {
          let st = log.sawnTimbers[stKey];
          if (typeof st === "string") st = (unit.sawnTimbers && unit.sawnTimbers[st]) || { EPC: st };

          const stEpc = normalizeEpc(st.EPC || st.epc || st.domainUUID || stKey, logEpc);
          if (seenEpcs.has(stEpc)) continue;

          const stObj = {
            type: "SawnTimber",
            epc: stEpc,
            firstReading: formatDate(st.firstReadingTime),
            treeType: t.treeType?.specie || t.treeTypeId || "Unknown",
            parentTreeEpc: treeEpc,
            parentWoodLog: logEpc,
            coordinates: st?.coordinates
              ? `${st.coordinates.latitude || st.coordinates.lat || ""},${st.coordinates.longitude || st.coordinates.lon || ""}`.replace(/(^,|,$)/g, "")
              : "",
            notes: Array.isArray(st?.notes) ? st.notes.map(n => n.description || n).join("; ") : st?.notes || "",
            observations: getObservations(st),
            forestUnitId,
            domainUUID: st?.domainUUID || st?.domainUuid,
            deleted: st?.deleted || false,
            lastModification: st?.lastModification || st?.lastModfication || ""
          };
          addToBatch(stObj);
        }
      }
    }

    const merkleTree = new MerkleTree(leaves, keccak256, { sortPairs: true });
    const root = merkleTree.getHexRoot(); // uguale allo script
    const outputDir = path.join(__dirname, "file-json");
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);
    const batchFile = path.join(outputDir, "forest-unified-batch.json");
    fs.writeFileSync(batchFile, JSON.stringify(batchWithProof, null, 2));

    state.batches[forestUnitId] = { batch: batchWithProof, leaves, merkleTree, root, batchFilePath: batchFile };

    res.json({
      forestUnitId,
      merkleRoot: root,
      batchFile,
      batchSize: batchWithProof.length
    });
  } catch (err) {
    res.status(500).json({ error: "Build unified batch failed", details: err.message });
  }
});

// --------------------
// 4) Build + sign Ricardian (JSON+PDF) (identico allo script)
// --------------------
app.post("/api/ricardian/buildAndSign", async (req, res) => {
  const forestUnitId = req.body?.forestUnitId;
  const merkleRoot = req.body?.merkleRoot;
  const useIPFS = !!req.body?.useIPFS;

  if (!forestUnitId || !merkleRoot) return res.status(400).json({ error: "forestUnitId e merkleRoot richiesti" });

  try {
    const network = await provider.getNetwork();
    const chainId = Number(network.chainId);
    const verifyingContract = deployed.ForestTracking;

    const ricardianBase = {
      version: "1.0",
      type: "RicardianForestTracking",
      jurisdiction: { courts: "Foro competente italiano", regulatoryFramework: ["IT", "EU"] },
      governingLaw: "Diritto della Repubblica Italiana e normativa dell'Unione Europea applicabile",
      actors: { dataOwner: "TopView Srl", dataProducer: "Operatore drone", dataConsumer: "Cliente finale" },
      purpose: "Tracciabilità e prova di integrità dei dati forestali",
      scope: { forestUnitKey: forestUnitId, includedData: ["trees", "wood_logs", "sawn_timbers"] },
      humanReadableAgreement: {
        language: "it",
        text: `
Il presente accordo disciplina la raccolta, la registrazione, la conservazione
e la verifica dell’integrità dei dati forestali relativi all’unità forestale
"${forestUnitId}".

Le parti riconoscono che il dataset è memorizzato off-chain e che l’hash
crittografico registrato su blockchain costituisce prova di esistenza,
immutabilità e integrità dei dati alla data di registrazione.

Il presente documento è strutturato come contratto ricardiano, essendo
interpretabile sia da esseri umani sia da sistemi automatici.
`.trim()
      },
      rightsAndDuties: {
        dataOwner: "Detiene la titolarità dei dati e autorizza la loro registrazione e verifica",
        dataProducer: "Garantisce la correttezza della raccolta e l'origine dei dati",
        dataConsumer: "Può verificare l’integrità dei dati ma non modificarli"
      },
      technical: {
        merkleRootUnified: merkleRoot,
        batchFormat: "JSON",
        storage: useIPFS ? "IPFS" : "LOCAL_FILE",
        hashAlgorithm: "keccak256"
      },
      legal: {
        legalValue: "Valore probatorio ai sensi della normativa vigente",
        statement: "L'hash registrato on-chain costituisce prova di esistenza e integrità del dataset alla data di registrazione."
      },
      hashBinding: { bindsHumanReadableText: true, bindsDatasetMerkleRoot: true },
      canonicalization: { format: "UTF-8", ordering: "lexicographic", whitespace: "normalized" },
      timestamps: { createdAt: new Date().toISOString() }
    };

    const ricardianHash = toKeccak256Json(ricardianBase);

    const domain = { name: "RicardianForestTracking", version: "1", chainId, verifyingContract };
    const types = {
      RicardianForest: [
        { name: "forestUnitKey", type: "string" },
        { name: "ricardianHash", type: "bytes32" },
        { name: "merkleRoot", type: "bytes32" },
        { name: "createdAt", type: "string" }
      ]
    };
    const message = {
      forestUnitKey: forestUnitId,
      ricardianHash,
      merkleRoot,
      createdAt: ricardianBase.timestamps.createdAt
    };

    const eip712Signature = await signer.signTypedData(domain, types, message);
    const recovered = ethers.verifyTypedData(domain, types, message, eip712Signature);
    if (recovered.toLowerCase() !== signer.address.toLowerCase()) {
      return res.status(500).json({ error: "Firma EIP-712 non valida (recovered != signer)" });
    }

    const ricardianForest = {
      ...ricardianBase,
      ricardianHash,
      signature: { eip712: { signer: signer.address, domain, types, message, signature: eip712Signature } }
    };

    const ricardianJson = path.join(__dirname, "ricardian-forest.json");
    fs.writeFileSync(ricardianJson, JSON.stringify(ricardianForest, null, 2));

    const ricardianPdf = path.join(__dirname, "ricardian-forest.pdf");
    await generateRicardianPdf(ricardianForest, ricardianPdf);

    state.ricardians[forestUnitId] = {
      ricardianBase,
      ricardianForest,
      ricardianHash,
      jsonPath: ricardianJson,
      pdfPath: ricardianPdf,
      ipfsUri: null,
      cid: null
    };

    res.json({
      forestUnitId,
      ricardianHash,
      files: { ricardianJson, ricardianPdf }
    });
  } catch (err) {
    res.status(500).json({ error: "Build/sign Ricardian failed", details: err.message });
  }
});

// --------------------
// 5) Upload Ricardian JSON to IPFS (ipfs://CID/ricardian-forest.json)
// --------------------
app.post("/api/ipfs/uploadRicardian", async (req, res) => {
  try {
    // se non lo passi, usa default
    let ricardianJsonPath = req.body?.ricardianJsonPath || path.join(__dirname, "ricardian-forest.json");

    // normalizza path (accetta anche "C:\foo\bar" se ti arriva già parseato)
    if (typeof ricardianJsonPath === "string") {
      ricardianJsonPath = ricardianJsonPath.trim();
    }

    if (!fs.existsSync(ricardianJsonPath)) {
      return res.status(404).json({ error: "File ricardianJsonPath non trovato", ricardianJsonPath });
    }

    const filename = path.basename(ricardianJsonPath);
    const fileContent = fs.readFileSync(ricardianJsonPath);

    const { cid } = await ipfs.add({ path: filename, content: fileContent });
    const ipfsUri = `ipfs://${cid}/${filename}`;

    try { await ipfs.pin.add(cid); } catch { /* ok */ }

    res.json({ cid: cid.toString(), ipfsUri, filename });
  } catch (err) {
    res.status(500).json({ error: "IPFS upload failed", details: err.message });
  }
});


// --------------------
// 6) Estimate gas + EUR (identico allo script)
// --------------------
app.post("/api/chain/estimateRegisterRicardianForest", async (req, res) => {
  const { forestUnitId, ricardianHash, merkleRoot, storageUri } = req.body || {};
  if (!forestUnitId || !ricardianHash || !merkleRoot || !storageUri) {
    return res.status(400).json({ error: "forestUnitId, ricardianHash, merkleRoot, storageUri richiesti" });
  }

  try {
    const gasEstimate = await provider.estimateGas({
      to: deployed.ForestTracking,
      data: contract.interface.encodeFunctionData("registerRicardianForest", [
        forestUnitId,
        ricardianHash,
        merkleRoot,
        storageUri
      ]),
      from: signer.address
    });

    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice || ethers.parseUnits("20", "gwei");
    const gasCostWei = gasEstimate * gasPrice;
    const gasCostEth = Number(ethers.formatEther(gasCostWei));
    const ethPrice = await getEthPriceInEuro();

    res.json({
      gasEstimate: gasEstimate.toString(),
      gasPriceWei: gasPrice.toString(),
      gasCostEth,
      eur: Number((gasCostEth * ethPrice).toFixed(2)),
      ethEur: ethPrice
    });
  } catch (err) {
    res.status(500).json({ error: "Estimate gas failed", details: err.message });
  }
});

// --------------------
// 7) Register on-chain
// --------------------
app.post("/api/chain/registerRicardianForest", async (req, res) => {
  const { forestUnitId, ricardianHash, merkleRoot, storageUri } = req.body || {};
  if (!forestUnitId || !ricardianHash || !merkleRoot || !storageUri) {
    return res.status(400).json({ error: "forestUnitId, ricardianHash, merkleRoot, storageUri richiesti" });
  }

  try {
    const tx = await contract.registerRicardianForest(forestUnitId, ricardianHash, merkleRoot, storageUri);
    const receipt = await tx.wait();

    res.json({
      txHash: receipt.transactionHash || tx.hash,
      blockNumber: receipt.blockNumber
    });
  } catch (err) {
    res.status(500).json({ error: "Register on-chain failed", details: err.message });
  }
});

// --------------------
// 8) Verify IPFS Ricardian JSON hash == expected
// --------------------
app.post("/api/ricardian/verifyIpfsHash", async (req, res) => {
  const { ipfsCid, expectedRicardianHash } = req.body || {};
  if (!ipfsCid || !expectedRicardianHash) {
    return res.status(400).json({ error: "ipfsCid e expectedRicardianHash richiesti" });
  }

  try {
    // 1) scarica da daemon ipfs: cat(cid)
    const chunks = [];
    for await (const chunk of ipfs.cat(ipfsCid)) chunks.push(chunk);
    const fileContent = Buffer.concat(chunks).toString("utf-8");
    const json = JSON.parse(fileContent);

    // 2) ricostruisci il "base" (quello su cui fai ricardianHash nello script)
    //    eliminando i campi che NON fanno parte del base
    const base = JSON.parse(JSON.stringify(json)); // deep clone semplice e stabile
    delete base.signature;
    delete base.ipfsUri;
    delete base.ricardianHash; // se nel file è stato scritto dentro per leggibilità

    // (opzionale) se in futuro aggiungi altri campi runtime, eliminali qui.

    // 3) hash del base
    const fetchedBaseHash = toKeccak256Json(base);

    // 4) confronto
    const ok = fetchedBaseHash.toLowerCase() === expectedRicardianHash.toLowerCase();

    res.json({
      ok,
      fetchedBaseHash,
      expectedRicardianHash
    });
  } catch (err) {
    res.status(500).json({ error: "Verify IPFS hash failed", details: err.message });
  }
});


// --------------------
// 9) Verify Merkle proofs for all leaves
// --------------------
app.post("/api/forest-units/verifyMerkleProofs", async (req, res) => {
  const { forestUnitId } = req.body || {};
  if (!forestUnitId) return res.status(400).json({ error: "forestUnitId richiesto" });

  try {
    const cached = state.batches[forestUnitId];
    if (!cached) return res.status(404).json({ error: "Batch non trovato: chiama buildUnifiedBatch prima" });

    const { leaves, merkleTree } = cached;
    let validCount = 0;
    let invalidCount = 0;

    for (let i = 0; i < leaves.length; i++) {
      const leaf = leaves[i];
      const proof = merkleTree.getProof(leaf).map(x => "0x" + x.data.toString("hex"));
      const isValid = merkleTree.verify(proof, leaf, merkleTree.getRoot());
      if (isValid) validCount++;
      else invalidCount++;
    }

    res.json({ forestUnitId, total: leaves.length, valid: validCount, invalid: invalidCount });
  } catch (err) {
    res.status(500).json({ error: "Verify proofs failed", details: err.message });
  }
});

// --------------------
// 10) VIEW / DOWNLOAD Ricardian PDF
// --------------------

// A) PDF "ultimo generato" (sempre ricardian-forest.pdf in root)
app.get("/api/ricardian/pdf", (req, res) => {
  try {
    const pdfPath = path.join(__dirname, "ricardian-forest.pdf");

    if (!fs.existsSync(pdfPath)) {
      return res.status(404).json({ error: "PDF non trovato. Genera prima con /api/ricardian/buildAndSign" });
    }

    res.setHeader("Content-Type", "application/pdf");
    // inline = apre nel browser. attachment = forza download
    res.setHeader("Content-Disposition", 'inline; filename="ricardian-forest.pdf"');

    return res.sendFile(pdfPath);
  } catch (err) {
    return res.status(500).json({ error: "Errore lettura PDF", details: err.message });
  }
});

// B) PDF per forestUnit specifica (se vuoi distinguere più pdf in futuro)
app.get("/api/ricardian/pdf/:forestUnitId", (req, res) => {
  try {
    const { forestUnitId } = req.params;

    const r = state.ricardians?.[forestUnitId];
    const pdfPath = r?.pdfPath || path.join(__dirname, "ricardian-forest.pdf");

    if (!pdfPath || !fs.existsSync(pdfPath)) {
      return res.status(404).json({
        error: "PDF non trovato per questa forestUnitId. Genera prima con /api/ricardian/buildAndSign",
        forestUnitId
      });
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="ricardian-${forestUnitId}.pdf"`);

    return res.sendFile(pdfPath);
  } catch (err) {
    return res.status(500).json({ error: "Errore lettura PDF", details: err.message });
  }
});


// --------------------
// ROUTES LIST (debug comodo)
// --------------------
app.get("/routes", (req, res) => {
  const routes = [];
  app._router.stack.forEach((m) => {
    if (m.route && m.route.path) {
      const methods = Object.keys(m.route.methods).map(x => x.toUpperCase());
      routes.push({ path: m.route.path, methods });
    }
  });
  res.json(routes);
});

app.listen(PORT, () => console.log(`Server avviato su http://localhost:${PORT}`));