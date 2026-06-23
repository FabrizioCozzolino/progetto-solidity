const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../environment_variables.env") });

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");

const axios = require("axios");
const https = require("https");

const { MerkleTree } = require("merkletreejs");
const keccak256 = require("keccak256");
const ethers = require("ethers");

const fs = require("fs");
const crypto = require("crypto");
const PDFDocument = require("pdfkit");
const QRCode = require("qrcode");
const multer = require("multer");

const { create } = require("ipfs-http-client");
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);

const { validateCades, dssHealthCheck } = require("./lib/dssClient");

const cron = require("node-cron");

cron.schedule("0 3 * * *", () => {
  const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - TEN_YEARS_MS;

  for (const dir of [RICARDIAN_DIR, CADES_DIR]) {
    const files = fs.readdirSync(dir);
    for (const f of files) {
      const fp = path.join(dir, f);
      const stat = fs.statSync(fp);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(fp);
        logger.info({ file: fp }, "Retention enforcement: file rimosso (>10 anni)");
      }
    }
  }
});

// --------------------
// CONFIG
// --------------------
const PORT = Number(process.env.PORT || 3000);

// TopView endpoints
const TOPVIEW_TOKEN_URL = process.env.TOPVIEW_TOKEN_URL || "https://digimedfor.topview.it/api/get-token/";
const TOPVIEW_FOREST_UNITS_URL = process.env.TOPVIEW_FOREST_UNITS_URL || "https://digimedfor.topview.it/api/get-forest-units/";
const TOPVIEW_USERNAME = process.env.TOPVIEW_USERNAME;
const TOPVIEW_PASSWORD = process.env.TOPVIEW_PASSWORD;
if (!TOPVIEW_USERNAME || !TOPVIEW_PASSWORD) {
  console.error("[FATAL] Credenziali TopView mancanti.");
  process.exit(1);
}
const TOPVIEW_HTTPS_INSECURE = (process.env.TOPVIEW_HTTPS_INSECURE || "false") === "true";
if (TOPVIEW_HTTPS_INSECURE) {
  console.warn("[WARN] TLS verification verso TopView DISABILITATA. Solo per dev locale.");
}

const RICARDIAN_DIR = process.env.RICARDIAN_DIR || path.join(__dirname, "storage", "ricardians");
const CADES_DIR = process.env.CADES_DIR || path.join(__dirname, "storage", "cades");
const TMP_DIR = process.env.TMP_DIR || path.join(__dirname, "storage", "tmp");

for (const dir of [RICARDIAN_DIR, CADES_DIR, TMP_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// EVM / Contract
const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) {
  console.error("[FATAL] RPC_URL non impostata. Suggerito: Sepolia o Polygon Amoy per test.");
  process.exit(1);
}
console.log("[INFO] RPC target:", RPC_URL.replace(/\/\/.*@/, "//***@"));
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error("[FATAL] PRIVATE_KEY non impostata. Server non avviato.");
  process.exit(1);
}
if (PRIVATE_KEY === "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80") {
  console.error("[FATAL] PRIVATE_KEY è la chiave Hardhat di default. Inammissibile.");
  process.exit(1);
}

// IPFS daemon locale
const IPFS_URL = process.env.IPFS_URL || "http://127.0.0.1:5004/api/v0";

// --------------------
// APP
// --------------------
const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "50mb" }));

// --------------------
// MULTER
// --------------------
const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: 50 * 1024 * 1024 }
});

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

// DEBUG CHAIN INFO
(async () => {
  const net = await provider.getNetwork();
  const addr = await signer.getAddress();
  const bal = await provider.getBalance(addr);

  console.log("[CHAIN] RPC_URL:", RPC_URL);
  console.log("[CHAIN] chainId:", net.chainId.toString());
  console.log("[CHAIN] signer:", addr);
  console.log("[CHAIN] balance:", ethers.formatEther(bal), "ETH");
  console.log("[CHAIN] contract:", deployed.ForestTracking);
})().catch(console.error);

// --------------------
// IN-MEMORY STORE
// --------------------
const state = {
  topview: { token: null, lastLoginAt: null },
  forestUnitsRemote: null,
  lastImportedForestUnitKey: null,
  batches: {},
  ricardians: {},
  cades: {},
  clientCades: {}
};

state.writes = {};

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

function toFileUri(p) {
  const abs = path.resolve(p).replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(abs)) return `file:///${abs}`;
  return `file://${abs.startsWith("/") ? "" : "/"}${abs}`;
}

function getBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  return `${proto}://${req.get("host")}`;
}

function normalizeEstimateWithEur(rawEstimate) {
  if (!rawEstimate) return rawEstimate;

  const gasCostEth =
    rawEstimate.gasCostEth != null
      ? Number(rawEstimate.gasCostEth)
      : rawEstimate.gasCostWei != null
        ? Number(rawEstimate.gasCostWei) / 1e18
        : null;

  const ethEur =
    rawEstimate.ethEur != null ? Number(rawEstimate.ethEur) : null;

  const eur =
    gasCostEth != null && ethEur != null
      ? Number((gasCostEth * ethEur).toFixed(8))
      : null;

  return {
    ...rawEstimate,
    gasCostEth,
    ethEur,
    eur,
    eurFormatted: eur != null ? eur.toFixed(8) : null
  };
}

function safeJsonClone(x) {
  return JSON.parse(JSON.stringify(x));
}

function stripRicardianToBase(ricardianJson) {
  const base = safeJsonClone(ricardianJson);
  delete base.signature;
  delete base.ipfsUri;
  delete base.ricardianHash;
  return base;
}

function sha256FileHex(filePath) {
  const data = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
}

function sha256FileBytes32(filePath) {
  return "0x" + sha256FileHex(filePath);
}

function parseSubjectField(subject, key) {
  const s = String(subject || "").trim();

  const patterns = [
    new RegExp(`(?:^|,)\\s*${key}\\s*=\\s*([^,]+)`, "i"),
    new RegExp(`(?:^|/)\\s*${key}\\s*=\\s*([^/]+)`, "i")
  ];

  for (const regex of patterns) {
    const m = s.match(regex);
    if (m) return m[1].trim();
  }

  return "";
}

function detectProviderName(issuer) {
  const s = String(issuer || "").toLowerCase();

  if (s.includes("infocamere")) return "InfoCamere";
  if (s.includes("arubapec")) return "ArubaPEC";
  if (s.includes("namirial")) return "Namirial";
  if (s.includes("intesa")) return "Intesa";
  if (s.includes("actalis")) return "Actalis";
  if (s.includes("poste")) return "Poste";
  return "";
}

async function extractCertificateInfoFromP7m(p7mPath) {
  const certOutPath = path.join(TMP_DIR, `cert-${Date.now()}.pem`);
  const firstCertPath = path.join(TMP_DIR, `first-cert-${Date.now()}.pem`);

  function extractSection(text, sectionName) {
    const lines = String(text || "").split("\n");
    const out = [];
    let capture = false;

    for (const rawLine of lines) {
      const line = rawLine.replace(/\r/g, "");

      if (!capture) {
        if (line.toLowerCase().includes(sectionName.toLowerCase() + ":")) {
          capture = true;
        }
        continue;
      }

      if (/^\s+/.test(line)) {
        const cleaned = line.trim();
        if (cleaned) out.push(cleaned);
        continue;
      }

      break;
    }

    return out.join(", ");
  }

  try {
    await execFileAsync("openssl", [
      "pkcs7",
      "-in", p7mPath,
      "-inform", "DER",
      "-print_certs",
      "-out", certOutPath
    ]);

    if (!fs.existsSync(certOutPath)) {
      throw new Error("Certificato non estratto");
    }

    const pemBundle = fs.readFileSync(certOutPath, "utf8");

    const firstCertMatch = pemBundle.match(
      /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/
    );

    if (!firstCertMatch) {
      throw new Error("Nessun certificato PEM trovato nell'output OpenSSL");
    }

    fs.writeFileSync(firstCertPath, firstCertMatch[0], "utf8");

    const { stdout } = await execFileAsync("openssl", [
      "x509",
      "-in", firstCertPath,
      "-noout",
      "-text"
    ]);

    const certText = stdout;

    const get = (regex) => {
      const m = certText.match(regex);
      return m ? m[1].trim() : "";
    };

    const subject = get(/Subject:\s*(.+)/);
    const issuer = get(/Issuer:\s*(.+)/);

    const keyUsage =
      extractSection(certText, "X509v3 Key Usage") ||
      extractSection(certText, "Key Usage");

    const extendedKeyUsage =
      extractSection(certText, "X509v3 Extended Key Usage") ||
      extractSection(certText, "Extended Key Usage");

    return {
      signerCommonName: parseSubjectField(subject, "CN"),
      signerSerialNumber: parseSubjectField(subject, "serialNumber"),
      providerName: detectProviderName(issuer),

      organization:
        parseSubjectField(subject, "O") ||
        parseSubjectField(subject, "OU") ||
        parseSubjectField(issuer, "O") ||
        parseSubjectField(issuer, "OU") ||
        "",

      organizationIdentifier:
        parseSubjectField(subject, "organizationIdentifier") ||
        parseSubjectField(issuer, "organizationIdentifier") ||
        "",

      country:
        parseSubjectField(subject, "C") ||
        parseSubjectField(issuer, "C") ||
        "",

      issuer,

      validFrom: get(/Not Before:\s*(.+)/),
      validTo: get(/Not After\s*:\s*(.+)/),

      signatureAlgorithm: get(/Signature Algorithm:\s*(.+)/),

      keyUsage,
      extendedKeyUsage,

      policy: get(/Policy:\s*([0-9\.]+)/),

      rawSubject: subject,
      rawIssuer: issuer,
      rawCertificate: certText
    };
  } catch (err) {
    return {
      error: err.stderr || err.message || "Errore estrazione certificato"
    };
  } finally {
    if (fs.existsSync(certOutPath)) {
      try { fs.unlinkSync(certOutPath); } catch {}
    }
    if (fs.existsSync(firstCertPath)) {
      try { fs.unlinkSync(firstCertPath); } catch {}
    }
  }
}

async function verifyAndExtractCadesAttachedPdf(p7mPath, extractedPdfPath) {
  // 1) Validazione DSS contro EU LOTL
  const dssResult = await validateCades(p7mPath);

  // 2) Estrazione del PDF originale (per verifica integrità)
  // OpenSSL serve ancora per estrarre il payload, ma NON per validare la firma
  const extractAttempts = [
    ["cms", "-verify", "-inform", "DER", "-binary", "-noverify", "-in", p7mPath, "-out", extractedPdfPath],
    ["smime", "-verify", "-inform", "DER", "-binary", "-noverify", "-in", p7mPath, "-out", extractedPdfPath]
  ];

  let extractOk = false;
  let extractError = null;
  for (const args of extractAttempts) {
    try {
      await execFileAsync("openssl", args);
      extractOk = true;
      break;
    } catch (err) {
      extractError = err;
    }
  }

  if (!extractOk) {
    return {
      ok: false,
      error: "Estrazione PDF dal CAdES fallita",
      extractError: extractError?.message,
      dssResult
    };
  }

  // 3) Determina validOffchain in base al risultato DSS
  const validOffchain =
    dssResult.ok &&
    dssResult.indication === "TOTAL_PASSED" &&
    ["QESig", "AdESig-QC"].includes(dssResult.signatureLevel);

  return {
    ok: true,
    extractOk: true,
    validOffchain,
    signatureLevel: dssResult.signatureLevel,
    indication: dssResult.indication,
    qcCompliance: dssResult.qcCompliance,
    qcSSCD: dssResult.qcSSCD,
    certificateChain: dssResult.certificateChain,
    revocationStatus: dssResult.revocationStatus,
    timestampPresent: dssResult.timestampPresent,
    dssReport: dssResult.rawReport
  };
}

async function uploadFileToIpfs(filePath, fileName) {
  const content = fs.readFileSync(filePath);
  const added = [];
  for await (const entry of ipfs.addAll([{ path: fileName, content }], { wrapWithDirectory: true })) {
    added.push(entry);
  }
  const dir = added.find(x => x.path === "") || added[added.length - 1];
  const cid = dir.cid.toString();
  const ipfsUri = `ipfs://${cid}/${fileName}`;
  try { await ipfs.pin.add(cid); } catch {}
  return { cid, ipfsUri };
}

// --------------------
// FLOW HELPERS
// --------------------
async function topviewEnsureLogin(username, password) {
  if (state.topview.token) return { token: state.topview.token, lastLoginAt: state.topview.lastLoginAt };

  const httpsAgent = new https.Agent({ rejectUnauthorized: !TOPVIEW_HTTPS_INSECURE });
  const r = await axios.post(TOPVIEW_TOKEN_URL, {
    username: username || TOPVIEW_USERNAME,
    password: password || TOPVIEW_PASSWORD
  }, { httpsAgent });

  state.topview.token = r.data.access;
  state.topview.lastLoginAt = new Date().toISOString();
  return { token: state.topview.token, lastLoginAt: state.topview.lastLoginAt };
}

async function topviewImportLatest() {
  const token = state.topview.token;
  if (!token) throw new Error("Token mancante (TopView login non eseguito)");

  const httpsAgent = new https.Agent({ rejectUnauthorized: !TOPVIEW_HTTPS_INSECURE });
  const r = await axios.get(TOPVIEW_FOREST_UNITS_URL, {
    headers: { Authorization: `Bearer ${token}` },
    httpsAgent
  });

  const forestUnits = r.data.forestUnits || {};
  const keys = Object.keys(forestUnits);
  if (!keys.length) throw new Error("Nessuna forest unit disponibile su TopView");

  const selectedForestKey = keys[keys.length - 3];
  const unit = forestUnits[selectedForestKey];

  state.forestUnitsRemote = forestUnits;
  state.lastImportedForestUnitKey = selectedForestKey;
  state._importedUnit = unit;

  return { forestUnitId: selectedForestKey, unit };
}

async function topviewImportForestUnitById(forestUnitId) {
  const token = state.topview.token;
  if (!token) throw new Error("Token mancante (TopView login non eseguito)");

  const httpsAgent = new https.Agent({ rejectUnauthorized: !TOPVIEW_HTTPS_INSECURE });
  const r = await axios.get(TOPVIEW_FOREST_UNITS_URL, {
    headers: { Authorization: `Bearer ${token}` },
    httpsAgent
  });

  const forestUnits = r.data.forestUnits || {};
  const unit = forestUnits[forestUnitId];

  if (!unit) {
    throw new Error(`Forest unit "${forestUnitId}" non trovata su TopView`);
  }

  state.forestUnitsRemote = forestUnits;
  state.lastImportedForestUnitKey = forestUnitId;
  state._importedUnit = unit;

  return { forestUnitId, unit };
}

async function buildUnifiedBatchInternal(forestUnitId, forestData) {

  if (!forestData)
    throw new Error("Forest unit non disponibile da TopView");

  state._importedUnit = forestData;

  const unit = forestData?.data || forestData?.forestUnit || forestData;

  if (!unit) {
    throw new Error("Forest unit non disponibile da TopView");
  }

  const leaves = [];
  const batchWithProof = [];
  const seenEpcs = new Set();

  const formatDate = (d) => (d ? new Date(d).toISOString() : "");

  function addToBatch(obj) {
    const leafHash = hashUnified(obj);
    leaves.push(leafHash);
    batchWithProof.push({ ...obj });
    if (obj?.epc) seenEpcs.add(obj.epc);
  }

  const trees = unit.trees || unit.treeList || unit.treeMap || {};
  for (const treeId of Object.keys(trees)) {
    const t = trees[treeId];
    const treeEpc = t.EPC || t.epc || t.domainUUID || treeId;

    addToBatch({
      type: "Tree",
      epc: treeEpc,
      firstReading: formatDate(t.firstReadingTime),
      treeType: t.treeType?.specie || t.treeTypeId || t.specie || "Unknown",
      coordinates: t.coordinates
        ? `${t.coordinates.latitude ?? t.coordinates.lat ?? ""},${t.coordinates.longitude ?? t.coordinates.lon ?? ""}`.replace(/(^,|,$)/g, "")
        : "",
      notes: Array.isArray(t.notes) ? t.notes.map(n => n.description || n).join("; ") : (t.notes || ""),
      observations: getObservations(t),
      forestUnitId,
      domainUUID: t.domainUUID || t.domainUuid,
      deleted: !!t.deleted,
      lastModification: t.lastModification || t.lastModfication || ""
    });
  }

  const unitWoodLogs = unit.woodLogs || unit.woodLogList || {};
  for (const logId of Object.keys(unitWoodLogs)) {
    const log = unitWoodLogs[logId] || {};
    const logEpc = normalizeEpc(log.EPC || log.epc || log.domainUUID || logId);
    if (seenEpcs.has(logEpc)) continue;

    const parentTree = log.treeID || log.treeId || log.parentTree || "";

    addToBatch({
      type: "WoodLog",
      epc: logEpc,
      firstReading: formatDate(log.firstReadingTime),
      treeType: log.treeType?.specie || log.treeTypeId || "Unknown",
      logSectionNumber: log.logSectionNumber || 1,
      parentTree,
      coordinates: log.coordinates
        ? `${log.coordinates.latitude ?? log.coordinates.lat ?? ""},${log.coordinates.longitude ?? log.coordinates.lon ?? ""}`.replace(/(^,|,$)/g, "")
        : "",
      notes: Array.isArray(log.notes) ? log.notes.map(n => n.description || n).join("; ") : (log.notes || ""),
      observations: getObservations(log),
      forestUnitId,
      domainUUID: log.domainUUID || log.domainUuid,
      deleted: !!log.deleted,
      lastModification: log.lastModification || log.lastModfication || ""
    });
  }

  const unitSawnTimbers = unit.sawnTimbers || unit.sawnTimberList || {};
  for (const stId of Object.keys(unitSawnTimbers)) {
    const st = unitSawnTimbers[stId] || {};
    const stEpc = normalizeEpc(st.EPC || st.epc || st.domainUUID || stId);
    if (seenEpcs.has(stEpc)) continue;

    addToBatch({
      type: "SawnTimber",
      epc: stEpc,
      firstReading: formatDate(st.firstReadingTime),
      treeType: st.treeType?.specie || st.treeTypeId || "Unknown",
      parentTreeEpc: st.parentTreeEpc || st.treeID || st.treeId || "",
      parentWoodLog: st.parentWoodLog || st.woodLogID || st.woodLogId || "",
      coordinates: st.coordinates
        ? `${st.coordinates.latitude ?? st.coordinates.lat ?? ""},${st.coordinates.longitude ?? st.coordinates.lon ?? ""}`.replace(/(^,|,$)/g, "")
        : "",
      notes: Array.isArray(st.notes) ? st.notes.map(n => n.description || n).join("; ") : (st.notes || ""),
      observations: getObservations(st),
      forestUnitId,
      domainUUID: st.domainUUID || st.domainUuid,
      deleted: !!st.deleted,
      lastModification: st.lastModification || st.lastModfication || ""
    });
  }

  if (leaves.length === 0) {
    throw new Error("Merkle tree vuoto: nessun Tree/WoodLog/SawnTimber trovato");
  }

  const merkleTree = new MerkleTree(leaves, keccak256, { sortPairs: true });

  const root = merkleTree.getHexRoot();

  if (!root || root === "0x") {
    throw new Error("Merkle root non valida");
  }

  const outputDir = path.join(__dirname, "file-json");
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

  const batchFile = path.join(outputDir, "forest-unified-batch.json");
  fs.writeFileSync(batchFile, JSON.stringify(batchWithProof, null, 2));

  state.batches[forestUnitId] = { batch: batchWithProof, leaves, merkleTree, root, batchFilePath: batchFile };

  return { forestUnitId, merkleRoot: root, batchFile, leavesCount: leaves.length };
}

async function buildAndSignRicardianInternal(forestUnitId, merkleRoot, storageMode = "LOCAL_FILE", subscriberData = null) {
  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);
  const verifyingContract = deployed.ForestTracking;

  // --------------------
  // Validazione subscriberData (art. 8-ter c.2 L. 12/2019)
  // --------------------
  // subscriberData può arrivare:
  //   a) dal body della richiesta REST (Soluzione A: identificazione contrattuale)
  //   b) in futuro da una sessione SPID/CIE (Soluzione B)
  // Se manca, lasciamo i campi a null e l'asserzione assertSubscriberIdentified()
  // in fondo a questa funzione bloccherà la firma.
  const VALID_ID_METHODS = ["contractual", "SPID-L2", "SPID-L3", "CIE", "EUDIWallet"];
  const _subLegalEntity = subscriberData?.legalEntity ?? null;
  const _subMethod      = subscriberData?.method      ?? (subscriberData?.legalEntity ? "contractual" : null);
  const _subIdentifier  = subscriberData?.identifier  ?? null;

  if (_subMethod && !VALID_ID_METHODS.includes(_subMethod)) {
    throw new Error(
      `subscriber.method non valido: "${_subMethod}". ` +
      `Ammessi: ${VALID_ID_METHODS.join(", ")}`
    );
  }


 const ricardianBase = {
  version: "4.1",
  type: "RicardianForestTracking",

  parties: {
    issuer: {
      role: "Fornitore della piattaforma di tracciabilità e ancoraggio on-chain; Responsabile del trattamento ex art. 28 GDPR",
      legalEntity: "TopView Srl",
      identification: {
        method: "contractual",
        identifier: "P.IVA TopView Srl"
      }
    },
    subscriber: {
      role: "Utente della piattaforma; Data Owner e Titolare del trattamento dei dati forestali",
      // Popolato da subscriberData passato dal chiamante (vedi /api/contract/write).
      // Se null, assertSubscriberIdentified() bloccherà la firma: l'art. 8-ter c.2
      // L. 12/2019 richiede identificazione informatica delle parti prima della firma.
      legalEntity: _subLegalEntity,
      identification: {
        method: _subMethod,         // "contractual" | "SPID-L2" | "SPID-L3" | "CIE" | "EUDIWallet"
        identifier: _subIdentifier  // P.IVA o CF
      }
    }
  },

  jurisdiction: {
    courts: "Foro italiano, salvo diversa pattuizione fra le parti"
  },

  governingLaw: [
    "Reg. (UE) 910/2014 (eIDAS) artt. 41 e 26-27",
    "L. 12/2019 art. 8-ter",
    "D.Lgs. 82/2005 (CAD) artt. 20-23 (effetti collegati alla controfirma CAdES qualificata)",
    "Codice Civile italiano artt. 2702 e 2712 (effetti collegati alla controfirma CAdES qualificata)",
    "Reg. (UE) 2016/679 (GDPR)"
  ],

  scope: {
    forestUnitKey: forestUnitId,
    includedData: ["trees", "wood_logs", "sawn_timbers"]
  },

  purpose: "Servizio di prova di esistenza, integrità e riferibilità temporale di dataset forestali off-chain mediante ancoraggio crittografico on-chain (Merkle root + ricardianHash). Il dataset resta off-chain; on-chain sono registrati esclusivamente hash crittografici e URI di reperimento.",

  rightsAndDuties: {
    issuer: "Assicura la disponibilità del servizio di ancoraggio e la corretta esecuzione delle operazioni di hashing, firma EIP-712 e registrazione on-chain, oltre a mettere a disposizione la procedura di verifica documentata in verificationProcedure. Sul piano della protezione dei dati personali agisce quale Responsabile del trattamento ai sensi dell'art. 28 GDPR, operando per conto e su istruzione del Sottoscrittore sulla base del Data Processing Agreement (DPA) sottoscritto separatamente fra le parti.",
    subscriber: "Detiene la titolarità dei Dati e ne autorizza la registrazione e la verifica mediante sottoscrizione del DPA trasmesso dal Fornitore. Quale Titolare del trattamento ai sensi del GDPR, risponde dell'osservanza dei principi di cui all'art. 5 e degli obblighi di cui all'art. 24 GDPR ed è tenuto a effettuare la valutazione d'impatto (DPIA) nei casi previsti dall'art. 35 GDPR, valutandone preliminarmente la ricorrenza in relazione al proprio caso d'uso.",
    dataConsumer: "Cliente finale del Sottoscrittore, auditor autorizzato o terzo verificatore: può verificare integrità e provenienza dei Dati tramite le evidenze on-chain e off-chain, senza poter modificare i Dati medesimi."
  },

  technical: {
    merkleRootUnified: merkleRoot,
    hashAlgorithm: "keccak256",
    merkleStructure: "Merkle tree (sortPairs)",
    batchFormat: "JSON",
    storage: storageMode,
    signatureFormats: {
      systemSignature: "EIP-712 (apposta dal Fornitore per attestare l'origine dell'ancoraggio dalla piattaforma; non costituisce FEA né FEQ del Sottoscrittore ex artt. 26-27 eIDAS)",
      userSignature: "CAdES-BES o superiore (DER) sul PDF ricardiano; livello effettivo determinato a runtime dalla validazione DSS contro EU LOTL"
    }
  },

  legal: {
    timeStampValidation: {
      level: "non-qualified",
      basis: "art. 41 Reg. (UE) 910/2014 in combinato disposto con art. 8-ter c.3 L. 12/2019",
      effects: "Ammissibilità come prova in giudizio. Non opera la presunzione di accuratezza temporale propria della validazione qualificata ex art. 42 eIDAS."
    },
    documentSignature: {
      systemSignature: {
        type: "type: firma elettronica semplice di sistema secondo lo standard EIP-712 e CAdES",
        purpose: "Attesta la provenienza dell'ancoraggio dalla piattaforma del Fornitore.",
        legalQualification: "Non costituisce FEA né FEQ ex artt. 26-27 eIDAS, in quanto la chiave è sotto controllo operativo del Fornitore e non del Sottoscrittore."
      },
      userCountersignature: {
        type: "CAdES (formato DER) - livello determinato a runtime",
        legalQualification: "Il livello e gli effetti giuridici sono determinati dalla validazione DSS al momento della controfirma. Effetti pieni ex artt. 20-23 CAD e art. 2702 c.c. solo se attestata FEQ con certificato qualificato di QTSP listato in EU LOTL e marca temporale qualificata.",
        validationReportRef: null
      }
    },
    statement: "L'hash registrato on-chain costituisce prova tecnica di esistenza, integrità e riferibilità temporale del dataset alla data di registrazione, opponibile a terzi nei limiti consentiti dalla normativa applicabile e dal livello di firma effettivamente apposto e verificato."
  },

  verificationProcedure: {
    onChain: "Confronto fra ricardianHash e merkleRoot registrati on-chain e quelli ricalcolati off-chain dal dataset originale.",
    merkleProofs: "Per ogni elemento del dataset, verifica della Merkle proof contro la root ancorata.",
    integrity: "SHA-256 del PDF ricardiano confrontato con pdfHash registrato on-chain.",
    cadesValidation: "Validazione della controfirma CAdES tramite Digital Signature Service (DSS) della Commissione UE o servizio equivalente: (a) chain-of-trust check contro EU LOTL; (b) revocation check via OCSP (RFC 6960) o CRL (RFC 5280); (c) verifica QCStatements (OID 0.4.0.1862.1.1 QcCompliance, 0.4.0.1862.1.4 QcSSCD); (d) verifica timestamp qualificato CAdES-T se presente.",
    referenceImplementation: "POST /api/contract/verify"
  },

  dataGovernance: {
    gdprMeasures: {
      lawfulBasis: "Documentata nel DPA fra Fornitore (Responsabile) e Sottoscrittore (Titolare)",
      dataMinimisation: "On-chain solo hash; mai payload di dati personali in chiaro",
      retentionPolicy: {
        onChainEvidence: "Perpetua per natura della rete (solo hash, non dati personali)",
        offChainEvidence: "10 anni in coerenza con art. 2946 c.c.; prorogabile per contenzioso o richiesta dell'autorità. Enforcement automatico via job di scadenza."
      },
      personalDataHandling: "La ripartizione dei ruoli privacy fra le parti è quella già delineata agli artt. 4 e 5: il Sottoscrittore è Titolare del trattamento, mentre il Fornitore agisce quale Responsabile ai sensi dell'art. 28 GDPR sulla base del DPA fra le parti",
      dataSubjectRights: "esercitabili dagli interessati, ai sensi del Capo III (artt. 12-22) GDPR, presso il Sottoscrittore quale Titolare. Le evidenze on-chain non consentono identificazione diretta degli interessati.",
      ipfsUsageStatement: "Limitato a payload privi di dati personali."
    },
    dpiaStatus: "Quale Titolare del trattamento, il Sottoscrittore è tenuto a effettuare la valutazione d'impatto (DPIA) prima del trattamento nei casi previsti dall'art. 35 GDPR, segnatamente in presenza di rischio elevato per i diritti e le libertà degli interessati, anche in ragione dell'uso di nuove tecnologie e di rilievi georeferenziati da drone; al Sottoscrittore compete la valutazione preliminare circa la ricorrenza di tali condizioni nel proprio caso d'uso."
  },

  disclaimers: {
    qualifiedTrustServiceStatus: "Il Fornitore non è Qualified Trust Service Provider ex eIDAS / eIDAS 2.0. Le evidenze prodotte non costituiscono servizio fiduciario qualificato.",
    archivalStatus: "Il Fornitore non è conservatore accreditato AgID. Per la conservazione a norma è raccomandata l'integrazione con conservatore accreditato terzo.",
    certifications: "Il Fornitore non rilascia certificazioni ISO 19115, 19157, 27001, 38200 né attestazioni di compliance INSPIRE, EBSI o EU Forest Monitoring. L'architettura è tecnicamente compatibile con tali quadri; l'eventuale certificazione resta in capo al Sottoscrittore se di interesse commerciale.",
    eudr: "Il Fornitore non genera la Due Diligence Statement EUDR né integra TRACES NT. Le evidenze geolocalizzate costituiscono supporto strumentale alla due diligence del Sottoscrittore ex Reg. (UE) 2023/1115, non compliance integrale.",
    legalAdvice: "Il presente documento descrive l'architettura tecnica e i suoi effetti giuridici tipici; non sostituisce parere legale specifico al caso concreto."
  },

  timestamps: {
    createdAt: new Date().toISOString()
  }
};

  function assertSubscriberIdentified(ricardianBase) {
    const sub = ricardianBase?.parties?.subscriber;
    if (!sub?.legalEntity) {
      throw new Error(
        "Subscriber non identificato: art. 8-ter c.2 L. 12/2019 richiede " +
        "identificazione informatica delle parti prima della firma. " +
        "Inviare nel body della richiesta: " +
        "subscriber: { legalEntity, identifier, method }."
      );
    }
    if (!sub?.identification?.method) {
      throw new Error(
        "Subscriber identification.method mancante: specificare metodo di identificazione " +
        "(\"contractual\" | \"SPID-L2\" | \"SPID-L3\" | \"CIE\" | \"EUDIWallet\")."
      );
    }
    if (!sub?.identification?.identifier) {
      throw new Error(
        "Subscriber identification.identifier mancante: " +
        "specificare P.IVA (persona giuridica) o codice fiscale (persona fisica)."
      );
    }
  }

  // poi, prima di toKeccak256Json:
  assertSubscriberIdentified(ricardianBase);

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
  const message = { forestUnitKey: forestUnitId, ricardianHash, merkleRoot, createdAt: ricardianBase.timestamps.createdAt };

  const eip712Signature = await signer.signTypedData(domain, types, message);
  const recovered = ethers.verifyTypedData(domain, types, message, eip712Signature);
  const signerAddress = (await signer.getAddress()).toLowerCase();
  if (recovered.toLowerCase() !== signerAddress) throw new Error("Firma EIP-712 non valida (recovered != signer)");

  const ricardianForest = {
    ...ricardianBase,
    ricardianHash,
    signature: { eip712: { signer: signerAddress, domain, types, message, signature: eip712Signature } }
  };

  const safeName = String(forestUnitId).replace(/[^a-zA-Z0-9_-]/g, "_");
  const ricardianJson = path.join(RICARDIAN_DIR, `ricardian-${safeName}.json`);
  fs.writeFileSync(ricardianJson, JSON.stringify(ricardianForest, null, 2));

  const ricardianPdf = path.join(RICARDIAN_DIR, `ricardian-${safeName}.pdf`);
  await generateRicardianPdf(ricardianForest, ricardianPdf);
  const pdfHash = sha256FileBytes32(ricardianPdf);

  state.ricardians[forestUnitId] = {
  ricardianBase,
  ricardianForest,
  ricardianHash,
  jsonPath: ricardianJson,
  pdfPath: ricardianPdf,
  pdfHash,
  ipfsUri: null,
  cid: null,
  storageUri: null,
  pdfUri: null
};

  return { forestUnitId, ricardianHash, jsonPath: ricardianJson, pdfPath: ricardianPdf, ricardianForest };
}

async function persistRicardianLocalInternal(forestUnitId, baseUrl) {
  const r = state.ricardians?.[forestUnitId];
  if (!r?.ricardianForest) throw new Error("Ricardian non trovato (buildAndSign non eseguito)");

  const safeName = String(forestUnitId).replace(/[^a-zA-Z0-9_-]/g, "_");
  const outPath = path.join(RICARDIAN_DIR, `ricardian-${safeName}.json`);
  fs.writeFileSync(outPath, JSON.stringify(r.ricardianForest, null, 2));

  r.jsonPath = outPath;
  r.storageUri = `${baseUrl}/api/ricardian/json/${encodeURIComponent(forestUnitId)}`;
  r.pdfUri = `${baseUrl}/api/ricardian/pdf/${encodeURIComponent(forestUnitId)}/view`;

  return {
    storageUri: r.storageUri,
    pdfUri: r.pdfUri,
    jsonPath: outPath
  };
}

async function uploadRicardianToIpfsInternal(forestUnitId) {
  const r = state.ricardians?.[forestUnitId];
  if (!r?.ricardianForest) throw new Error("Ricardian non trovato (buildAndSign non eseguito)");

  const fileName = "ricardian-forest.json";
  const content = Buffer.from(JSON.stringify(r.ricardianForest, null, 2), "utf-8");

  const added = [];
  for await (const entry of ipfs.addAll([{ path: fileName, content }], { wrapWithDirectory: true })) {
    added.push(entry);
  }

  const dir = added.find(x => x.path === "") || added[added.length - 1];
  const cid = dir.cid.toString();
  const ipfsUri = `ipfs://${cid}/${fileName}`;

  try { await ipfs.pin.add(cid); } catch {}

  r.cid = cid;
  r.ipfsUri = ipfsUri;
  r.storageUri = ipfsUri;
  r.ricardianForest.ipfsUri = ipfsUri;

  return { cid, ipfsUri, storageUri: ipfsUri };
}

async function estimateRegisterInternal({ forestUnitId, ricardianHash, merkleRoot, storageUri }) {
  const contractAddress = deployed.ForestTracking;
  const from = await signer.getAddress();

  const data = contract.interface.encodeFunctionData("registerRicardianForest", [
    forestUnitId,
    ricardianHash,
    merkleRoot,
    storageUri
  ]);

  const gasEstimate = await provider.estimateGas({ to: contractAddress, data, from });
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? ethers.parseUnits("20", "gwei");

  const gasCostWei = gasEstimate * gasPrice;
  const gasCostEth = Number(ethers.formatEther(gasCostWei));
  const ethPrice = await getEthPriceInEuro();

  return {
    to: contractAddress,
    from,
    gasEstimate: gasEstimate.toString(),
    gasPriceWei: gasPrice.toString(),
    gasCostWei: gasCostWei.toString(),
    gasCostEth,
    ethEur: ethPrice,
    eur: Number((gasCostEth * ethPrice).toFixed(2))
  };
}

async function estimateSetPdfUriInternal({ forestUnitId, pdfUri }) {
  const contractAddress = deployed.ForestTracking;
  const from = await signer.getAddress();

  const data = contract.interface.encodeFunctionData("setRicardianPdfUri", [
    forestUnitId,
    pdfUri
  ]);

  const gasEstimate = await provider.estimateGas({ to: contractAddress, data, from });
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? ethers.parseUnits("20", "gwei");

  const gasCostWei = gasEstimate * gasPrice;
  const gasCostEth = Number(ethers.formatEther(gasCostWei));
  const ethPrice = await getEthPriceInEuro();

  return {
    to: contractAddress,
    from,
    gasEstimate: gasEstimate.toString(),
    gasPriceWei: gasPrice.toString(),
    gasCostWei: gasCostWei.toString(),
    gasCostEth,
    ethEur: ethPrice,
    eur: Number((gasCostEth * ethPrice).toFixed(2))
  };
}

async function estimateRegisterCountersignatureInternal({
  forestUnitId,
  pdfHash,
  cadesHash,
  cadesUri,
  signerCommonName,
  signerSerialNumber,
  signedAt,
  validOffchain
}) {
  const contractAddress = deployed.ForestTracking;
  const from = await signer.getAddress();

  const data = contract.interface.encodeFunctionData("registerUserCountersignature", [
    forestUnitId,
    pdfHash,
    cadesHash,
    cadesUri,
    signerCommonName,
    signerSerialNumber,
    signedAt,
    validOffchain
  ]);

  const gasEstimate = await provider.estimateGas({ to: contractAddress, data, from });
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? ethers.parseUnits("20", "gwei");

  const gasCostWei = gasEstimate * gasPrice;
  const gasCostEth = Number(ethers.formatEther(gasCostWei));
  const ethPrice = await getEthPriceInEuro();

  return {
    to: contractAddress,
    from,
    gasEstimate: gasEstimate.toString(),
    gasPriceWei: gasPrice.toString(),
    gasCostWei: gasCostWei.toString(),
    gasCostEth,
    ethEur: ethPrice,
    eur: Number((gasCostEth * ethPrice).toFixed(2))
  };
}

async function registerOnChainInternal({ forestUnitId, ricardianHash, merkleRoot, storageUri }) {
  const runner = await contract.runner;
  const signerAddress = await runner.getAddress();
  const balance = await runner.provider.getBalance(signerAddress);

  const gas = await contract.registerRicardianForest.estimateGas(forestUnitId, ricardianHash, merkleRoot, storageUri);
  const feeData = await runner.provider.getFeeData();
  const price = feeData.maxFeePerGas ?? feeData.gasPrice;
  const estimatedCost = gas * price;

  if (balance < estimatedCost) {
    const e = new Error("Insufficient funds");
    e.meta = { signerAddress, balanceWei: balance.toString(), estimatedCostWei: estimatedCost.toString() };
    throw e;
  }

  const tx = await contract.registerRicardianForest(forestUnitId, ricardianHash, merkleRoot, storageUri);
  const receipt = await tx.wait();

  return {
    txHash: receipt.transactionHash || tx.hash,
    blockNumber: receipt.blockNumber,
    signerAddress
  };
}

async function setPdfUriOnChainInternal({ forestUnitId, pdfUri }) {
  const runner = await contract.runner;
  const signerAddress = await runner.getAddress();
  const balance = await runner.provider.getBalance(signerAddress);

  // Diagnostica: calcola il calldata esplicito e verifica gli argomenti
  console.log("[SETPDFURI] forestUnitId:", JSON.stringify(forestUnitId), "pdfUri:", JSON.stringify(pdfUri));
  if (forestUnitId == null || pdfUri == null) {
    throw new Error(`[SETPDFURI] argomenti mancanti: forestUnitId=${forestUnitId} pdfUri=${pdfUri}`);
  }
  const callData = contract.interface.encodeFunctionData("setRicardianPdfUri", [forestUnitId, pdfUri]);
  console.log("[SETPDFURI] calldata:", callData.slice(0, 20), "len:", callData.length);

  // Simula la chiamata per ottenere il revert reason esatto del require
  try {
    await contract.setRicardianPdfUri.staticCall(forestUnitId, pdfUri);
  } catch (simErr) {
    console.error("[SETPDFURI] staticCall revert:", simErr.reason || simErr.shortMessage || simErr.message);
    const e = new Error("setRicardianPdfUri reverted (sim): " + (simErr.reason || simErr.shortMessage || simErr.message));
    e.meta = { forestUnitId, pdfUri, contractAddress: deployed.ForestTracking };
    throw e;
  }

  const gas = await contract.setRicardianPdfUri.estimateGas(forestUnitId, pdfUri);
  const feeData = await runner.provider.getFeeData();
  const price = feeData.maxFeePerGas ?? feeData.gasPrice;
  const estimatedCost = gas * price;

  if (balance < estimatedCost) {
    const e = new Error("Insufficient funds");
    e.meta = {
      signerAddress,
      balanceWei: balance.toString(),
      estimatedCostWei: estimatedCost.toString()
    };
    throw e;
  }

  // Invio con calldata esplicito per evitare tx con data vuoto
  const tx = await runner.sendTransaction({
    to: deployed.ForestTracking,
    data: callData,
    gasLimit: (gas * 12n) / 10n
  });
  const receipt = await tx.wait();

  return {
    txHash: receipt.transactionHash || tx.hash,
    blockNumber: receipt.blockNumber,
    signerAddress
  };
}

async function registerCountersignatureOnChainInternal({
  forestUnitId,
  pdfHash,
  cadesHash,
  cadesUri,
  signerCommonName,
  signerSerialNumber,
  signedAt,
  validOffchain
}) {
  const runner = await contract.runner;
  const signerAddress = await runner.getAddress();
  const balance = await runner.provider.getBalance(signerAddress);

  const gas = await contract.registerUserCountersignature.estimateGas(
    forestUnitId,
    pdfHash,
    cadesHash,
    cadesUri,
    signerCommonName,
    signerSerialNumber,
    signedAt,
    validOffchain
  );

  const feeData = await runner.provider.getFeeData();
  const price = feeData.maxFeePerGas ?? feeData.gasPrice;
  const estimatedCost = gas * price;

  if (balance < estimatedCost) {
    const e = new Error("Insufficient funds");
    e.meta = {
      signerAddress,
      balanceWei: balance.toString(),
      estimatedCostWei: estimatedCost.toString()
    };
    throw e;
  }

  const tx = await contract.registerUserCountersignature(
    forestUnitId,
    pdfHash,
    cadesHash,
    cadesUri,
    signerCommonName,
    signerSerialNumber,
    signedAt,
    validOffchain
  );

  const receipt = await tx.wait();

  return {
    txHash: receipt.transactionHash || tx.hash,
    blockNumber: receipt.blockNumber,
    signerAddress
  };
}

// ----------------------------------------------------------------
// CLIENT COUNTERSIGNATURE (firma annidata .p7m.p7m)
// ----------------------------------------------------------------

// Estrae il payload firmato da un container CAdES/PKCS7 (DER) senza
// validare la firma (-noverify): serve solo a "sbucciare" un livello.
async function unwrapCadesPayload(inputP7mPath, outPath) {
  const attempts = [
    ["cms", "-verify", "-inform", "DER", "-binary", "-noverify", "-in", inputP7mPath, "-out", outPath],
    ["smime", "-verify", "-inform", "DER", "-binary", "-noverify", "-in", inputP7mPath, "-out", outPath]
  ];
  let lastErr = null;
  for (const args of attempts) {
    try {
      await execFileAsync("openssl", args);
      if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
        return { ok: true };
      }
    } catch (err) {
      lastErr = err;
    }
  }
  return { ok: false, error: lastErr?.message || "Unwrap CAdES fallito" };
}

// Verifica un .p7m.p7m: sbuccia il livello esterno (firma cliente) -> ottiene
// il .p7m del firmatario, poi sbuccia di nuovo -> ottiene il PDF. Valida via
// DSS la firma esterna e controlla che il PDF finale combaci con la baseline.
async function verifyAndExtractClientCountersignature(
  clientP7mPath,
  innerP7mOutPath,
  extractedPdfOutPath
) {
  // 1) Validazione DSS della firma esterna (del cliente)
  const dssResult = await validateCades(clientP7mPath);

  // 2) Livello 1: sbuccia firma cliente -> .p7m del firmatario
  const lvl1 = await unwrapCadesPayload(clientP7mPath, innerP7mOutPath);
  if (!lvl1.ok) {
    return { ok: false, error: "Estrazione p7m interno fallita", details: lvl1.error, dssResult };
  }

  // 3) Livello 2: sbuccia firma firmatario -> PDF
  const lvl2 = await unwrapCadesPayload(innerP7mOutPath, extractedPdfOutPath);
  if (!lvl2.ok) {
    return { ok: false, error: "Estrazione PDF dal p7m interno fallita", details: lvl2.error, dssResult };
  }

  const validOffchain =
    dssResult.ok &&
    dssResult.indication === "TOTAL_PASSED" &&
    ["QESig", "AdESig-QC"].includes(dssResult.signatureLevel);

  return {
    ok: true,
    validOffchain,
    signatureLevel: dssResult.signatureLevel,
    indication: dssResult.indication,
    subIndication: dssResult.subIndication,
    signatureFormat: dssResult.signatureFormat,
    qcCompliance: dssResult.qcCompliance,
    qcSSCD: dssResult.qcSSCD,
    hasTimestamp: dssResult.hasTimestamp,
    rawReport: dssResult.rawReport
  };
}

async function estimateRegisterClientCountersignatureInternal({
  forestUnitId,
  innerCadesHash,
  clientCadesHash,
  clientCadesUri,
  signerCommonName,
  signerSerialNumber,
  signedAt,
  validOffchain
}) {
  const contractAddress = deployed.ForestTracking;
  const from = await signer.getAddress();

  const data = contract.interface.encodeFunctionData("registerClientCountersignature", [
    forestUnitId,
    innerCadesHash,
    clientCadesHash,
    clientCadesUri,
    signerCommonName,
    signerSerialNumber,
    signedAt,
    validOffchain
  ]);

  const gasEstimate = await provider.estimateGas({ to: contractAddress, data, from });
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? ethers.parseUnits("20", "gwei");

  const gasCostWei = gasEstimate * gasPrice;
  const gasCostEth = Number(ethers.formatEther(gasCostWei));
  const ethPrice = await getEthPriceInEuro();

  return {
    to: contractAddress,
    from,
    gasEstimate: gasEstimate.toString(),
    gasPriceWei: gasPrice.toString(),
    gasCostWei: gasCostWei.toString(),
    gasCostEth,
    ethEur: ethPrice,
    eur: Number((gasCostEth * ethPrice).toFixed(2))
  };
}

async function registerClientCountersignatureOnChainInternal({
  forestUnitId,
  innerCadesHash,
  clientCadesHash,
  clientCadesUri,
  signerCommonName,
  signerSerialNumber,
  signedAt,
  validOffchain
}) {
  const runner = await contract.runner;
  const signerAddress = await runner.getAddress();
  const balance = await runner.provider.getBalance(signerAddress);

  const gas = await contract.registerClientCountersignature.estimateGas(
    forestUnitId,
    innerCadesHash,
    clientCadesHash,
    clientCadesUri,
    signerCommonName,
    signerSerialNumber,
    signedAt,
    validOffchain
  );

  const feeData = await runner.provider.getFeeData();
  const price = feeData.maxFeePerGas ?? feeData.gasPrice;
  const estimatedCost = gas * price;

  if (balance < estimatedCost) {
    const e = new Error("Insufficient funds");
    e.meta = {
      signerAddress,
      balanceWei: balance.toString(),
      estimatedCostWei: estimatedCost.toString()
    };
    throw e;
  }

  const tx = await contract.registerClientCountersignature(
    forestUnitId,
    innerCadesHash,
    clientCadesHash,
    clientCadesUri,
    signerCommonName,
    signerSerialNumber,
    signedAt,
    validOffchain
  );

  const receipt = await tx.wait();

  return {
    txHash: receipt.transactionHash || tx.hash,
    blockNumber: receipt.blockNumber,
    signerAddress
  };
}

async function verifyIpfsHashInternal(forestUnitId, expectedRicardianHash) {
  const r = state.ricardians?.[forestUnitId];
  if (!r?.ipfsUri || !r?.cid) {
    return { skipped: true, reason: "ipfsUri/cid non presenti" };
  }

  const fileName = "ricardian-forest.json";
  const chunks = [];
  for await (const chunk of ipfs.cat(`${r.cid}/${fileName}`)) chunks.push(chunk);
  const content = Buffer.concat(chunks).toString("utf-8");

  const json = JSON.parse(content);
  const base = stripRicardianToBase(json);
  const fetchedHash = toKeccak256Json(base);

  return {
    skipped: false,
    ok: fetchedHash.toLowerCase() === expectedRicardianHash.toLowerCase(),
    fetchedHash,
    expectedRicardianHash,
    ipfsUri: r.ipfsUri
  };
}

async function verifyMerkleProofsInternal(forestUnitId) {
  const cached = state.batches[forestUnitId];
  if (!cached) throw new Error("Batch non trovato in cache");

  const { leaves, merkleTree } = cached;

  const onchainRic = await contract.forestRicardians(forestUnitId);
  const onchainRoot = onchainRic.merkleRoot;

  const localRoot = merkleTree.getHexRoot();
  const rootMatches = localRoot.toLowerCase() === onchainRoot.toLowerCase();

  let valid = 0;
  let invalid = 0;

  for (let i = 0; i < leaves.length; i++) {
    const leaf = leaves[i];
    const proof = merkleTree.getProof(leaf).map(x => "0x" + x.data.toString("hex"));
    const leafHex = "0x" + leaf.toString("hex");

    const isValid = await contract.verifyUnifiedProofWithRoot(leafHex, proof, onchainRoot);
    if (isValid) valid++;
    else invalid++;
  }

  return { total: leaves.length, valid, invalid, onchainRoot, localRoot, rootMatches };
}

// --------------------
// PDF
// --------------------
function generateRicardianPdf(ricardian, outPath) {
  return new Promise((resolve, reject) => {
    (async () => {
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
      accent: "#0B3D2E",
      accentSoft: "#E8F0EC",
      link: "#0B57D0",
      warn: "#A14D00",
      warnFill: "#FFF4E5"
    };

    const safe = (v) => (v === null || v === undefined ? "" : String(v));
    const truncate = (v, n) => {
      const s = safe(v);
      return s.length > n ? s.slice(0, n - 1) + "..." : s;
    };
    const fmtDate = (iso) => {
      if (!iso) return "-";
      try {
        const d = new Date(iso);
        const date = d.toLocaleDateString("it-IT", { day: "2-digit", month: "long", year: "numeric" });
        const time = d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
        return `${date} - ${time} UTC`;
      } catch (_) {
        return iso;
      }
    };

    function bottomY() {
      // Riservo 30pt sopra il margine inferiore per il footer di pagina.
      return doc.page.height - doc.page.margins.bottom - 30;
    }

    function ensureSpace(needed) {
      if (doc.y + needed > bottomY()) doc.addPage();
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

    // ------------------------------------------------------------------
    // Dati ricorrenti (interpolati nel testo delle clausole)
    // ------------------------------------------------------------------
    const issuer = ricardian?.parties?.issuer || {};
    const subscriber = ricardian?.parties?.subscriber || {};
    const issuerName = safe(issuer.legalEntity) || "[FORNITORE]";
    const issuerIdent = safe(issuer.identification?.identifier) || "-";
    const subName = safe(subscriber.legalEntity) || "[SOTTOSCRITTORE NON IDENTIFICATO]";
    const subIdent = safe(subscriber.identification?.identifier) || "-";
    const subMethod = safe(subscriber.identification?.method) || "-";
    const forestUnit = safe(ricardian?.scope?.forestUnitKey) || "-";
    const includedData = Array.isArray(ricardian?.scope?.includedData)
      ? ricardian.scope.includedData.join(", ")
      : "-";

    const eip = ricardian?.signature?.eip712 || {};
    const domain = eip.domain || {};
    const chainId = Number(domain.chainId);
    const NETWORK_NAMES = {
      1: "Ethereum mainnet",
      11155111: "Ethereum Sepolia (testnet)",
      137: "Polygon mainnet",
      80002: "Polygon Amoy (testnet)",
      42161: "Arbitrum One"
    };
    const EXPLORER_BASES = {
      1: "https://etherscan.io/",
      11155111: "https://sepolia.etherscan.io/",
      137: "https://polygonscan.com/",
      80002: "https://amoy.polygonscan.com/",
      42161: "https://arbiscan.io/"
    };
    const networkName = NETWORK_NAMES[chainId] || `rete EVM (chainId ${domain.chainId || "-"})`;
    const explorerBase = EXPLORER_BASES[chainId] || "https://sepolia.etherscan.io/";
    const verifyingContract = safe(domain.verifyingContract);

    // QR code per la verifica on-chain (pagina dell'explorer, es. Sepolia).
    const verifyUrl = verifyingContract
      ? `${explorerBase}address/${verifyingContract}`
      : explorerBase;
    let verifyQrDataUrl = null;
    try {
      verifyQrDataUrl = await QRCode.toDataURL(verifyUrl, {
        margin: 1,
        width: 240,
        errorCorrectionLevel: "M",
        color: { dark: COLORS.accent, light: "#FFFFFF" }
      });
    } catch (_e) {
      verifyQrDataUrl = null; // in caso di errore, il PDF prosegue senza QR
    }

    const t = ricardian?.technical || {};
    const tsv = ricardian?.legal?.timeStampValidation || {};
    const sysSig = ricardian?.legal?.documentSignature?.systemSignature || {};
    const userSig = ricardian?.legal?.documentSignature?.userCountersignature || {};
    const gdpr = ricardian?.dataGovernance?.gdprMeasures || {};
    const retention = gdpr.retentionPolicy || {};
    const disc = ricardian?.disclaimers || {};
    const rd = ricardian?.rightsAndDuties || {};
    const vp = ricardian?.verificationProcedure || {};

    // ------------------------------------------------------------------
    // Primitive tipografiche — corpo "articolato" in linguaggio naturale
    // ------------------------------------------------------------------
    function articleTitle(num, title) {
      ensureSpace(46);
      doc.moveDown(0.4);
      doc.font("Helvetica-Bold").fontSize(7.5).fillColor(COLORS.accent);
      doc.text(`ARTICOLO ${num}`, M, doc.y, { width: W, characterSpacing: 1 });
      doc.moveDown(0.12);
      doc.font("Helvetica-Bold").fontSize(13.5).fillColor(COLORS.text);
      doc.text(title, M, doc.y, { width: W });
      doc.moveDown(0.5);
    }

    function annexTitle(kicker, title) {
      ensureSpace(46);
      doc.font("Helvetica-Bold").fontSize(7.5).fillColor(COLORS.accent);
      doc.text(kicker.toUpperCase(), M, doc.y, { width: W, characterSpacing: 1 });
      doc.moveDown(0.15);
      doc.font("Helvetica-Bold").fontSize(14).fillColor(COLORS.text);
      doc.text(title, M, doc.y, { width: W });
      doc.moveDown(0.55);
    }

    function bodyPara(text) {
      doc.font("Helvetica").fontSize(10).fillColor(COLORS.text);
      const h = doc.heightOfString(text, { width: W, lineGap: 3 });
      ensureSpace(h + 6);
      doc.text(text, M, doc.y, { width: W, lineGap: 3, align: "justify" });
      doc.moveDown(0.45);
    }

    /**
     * Clausola numerata (es. "3.2") con rientro sospeso, stile articolato.
     */
    function clause(num, text) {
      const numW = 34;
      const txtX = M + numW;
      const txtW = W - numW;
      doc.font("Helvetica").fontSize(10);
      const h = doc.heightOfString(text, { width: txtW, lineGap: 3 });
      ensureSpace(h + 8);
      const y = doc.y;
      doc.font("Helvetica-Bold").fontSize(10).fillColor(COLORS.accent);
      doc.text(num, M, y, { width: numW - 6 });
      doc.font("Helvetica").fontSize(10).fillColor(COLORS.text);
      doc.text(text, txtX, y, { width: txtW, lineGap: 3, align: "justify" });
      doc.y = y + h;
      doc.moveDown(0.5);
    }

    /**
     * Voce di definizione: «Termine»: testo della definizione.
     */
    function definition(term, text) {
      const full = `\u201C${term}\u201D: ${text}`;
      doc.font("Helvetica").fontSize(10);
      const h = doc.heightOfString(full, { width: W - 14, lineGap: 2.5 });
      ensureSpace(h + 6);
      const y = doc.y;
      doc.font("Helvetica-Bold").fontSize(10).fillColor(COLORS.text);
      doc.text(`\u201C${term}\u201D`, M + 14, y, {
        width: W - 14, lineGap: 2.5, continued: true
      });
      doc.font("Helvetica").fillColor(COLORS.text);
      doc.text(`: ${text}`, { width: W - 14, lineGap: 2.5, align: "justify" });
      doc.moveDown(0.35);
    }

    function captionPara(text) {
      doc.font("Helvetica-Oblique").fontSize(9).fillColor(COLORS.faint);
      const h = doc.heightOfString(text, { width: W, lineGap: 2 });
      ensureSpace(h + 6);
      doc.text(text, M, doc.y, { width: W, lineGap: 2 });
      doc.moveDown(0.45);
    }

    function subTitle(text) {
      ensureSpace(20);
      doc.font("Helvetica-Bold").fontSize(10.5).fillColor(COLORS.accent);
      doc.text(text, M, doc.y, { width: W });
      doc.moveDown(0.3);
    }

    /**
     * Tabella label/value sobria. Usata SOLO negli Allegati Tecnici:
     * il corpo del contratto resta in linguaggio naturale.
     */
    function kvTable(rows, opts = {}) {
      const labelW = opts.labelW || 160;
      const mono = opts.mono || new Set();
      const valueGap = 6;

      const drawRow = (label, value, isMono, isLast) => {
        const valueW = W - labelW - valueGap;

        doc.font("Helvetica-Bold").fontSize(9).fillColor(COLORS.text);
        const labelH = doc.heightOfString(label, { width: labelW, lineGap: 2 });

        if (isMono) {
          doc.font("Courier").fontSize(8).fillColor(COLORS.text);
        } else {
          doc.font("Helvetica").fontSize(9.5).fillColor(COLORS.text);
        }
        const valueH = doc.heightOfString(value || "-", { width: valueW, lineGap: 2 });

        const rowH = Math.max(labelH, valueH) + 10;
        ensureSpace(rowH + 4);
        const y = doc.y;

        doc.font("Helvetica-Bold").fontSize(9).fillColor(COLORS.text);
        doc.text(label, M, y + 4, { width: labelW, lineGap: 2 });

        if (isMono) {
          doc.font("Courier").fontSize(8).fillColor(COLORS.text);
        } else {
          doc.font("Helvetica").fontSize(9.5).fillColor(COLORS.text);
        }
        doc.text(value || "-", M + labelW + valueGap, y + 4, { width: valueW, lineGap: 2 });

        doc.y = y + rowH;

        if (!isLast) {
          doc.save();
          doc.strokeColor(COLORS.line).lineWidth(0.3);
          doc.moveTo(M, doc.y).lineTo(M + W, doc.y).stroke();
          doc.restore();
        }
      };

      rows.forEach((r, i) => {
        drawRow(r[0], r[1], mono.has(i), i === rows.length - 1);
      });
      doc.moveDown(0.6);
    }

    /**
     * Tabella a 2 colonne per la mappatura clausola contrattuale -> funzione/evento
     * on-chain (Allegato Tecnico B). Ogni riga: [Articolo, Funzione on-chain].
     */
    function mappingTable(rows) {
      const cols = [W * 0.28, W * 0.72];
      const xs = [M, M + cols[0]];
      const pad = 6;

      const headers = ["Articolo", "Funzione on-chain"];
      const headerH = 22;
      ensureSpace(headerH + 30);
      let y = doc.y;
      doc.save();
      doc.fillColor(COLORS.accentSoft).rect(M, y, W, headerH).fill();
      doc.restore();
      doc.font("Helvetica-Bold").fontSize(8.5).fillColor(COLORS.accent);
      headers.forEach((h, i) => {
        doc.text(h, xs[i] + pad, y + 7, { width: cols[i] - pad * 2 });
      });
      doc.y = y + headerH;

      rows.forEach((r, idx) => {
        doc.font("Helvetica-Bold").fontSize(9);
        const h0 = doc.heightOfString(r[0], { width: cols[0] - pad * 2, lineGap: 1.5 });
        doc.font("Courier").fontSize(8);
        const h1 = doc.heightOfString(r[1], { width: cols[1] - pad * 2, lineGap: 1.5 });
        const rowH = Math.max(h0, h1) + 12;
        ensureSpace(rowH + 4);
        const ry = doc.y;

        doc.font("Helvetica-Bold").fontSize(9).fillColor(COLORS.accent);
        doc.text(r[0], xs[0] + pad, ry + 6, { width: cols[0] - pad * 2, lineGap: 1.5 });
        doc.font("Courier").fontSize(8).fillColor(COLORS.text);
        doc.text(r[1], xs[1] + pad, ry + 6, { width: cols[1] - pad * 2, lineGap: 1.5 });

        doc.y = ry + rowH;
        if (idx !== rows.length - 1) {
          doc.save();
          doc.strokeColor(COLORS.line).lineWidth(0.3);
          doc.moveTo(M, doc.y).lineTo(M + W, doc.y).stroke();
          doc.restore();
        }
      });
      doc.moveDown(0.6);
    }

    // ==================================================================
    // FRONTESPIZIO
    // ==================================================================
    function renderFrontPage() {
      doc.save().fillColor(COLORS.accent).rect(0, 0, doc.page.width, 60).fill().restore();
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#FFFFFF");
      doc.text("CONTRATTO RICARDIANO - EVIDENZE ON-CHAIN", M, 24, {
        width: W, align: "center", characterSpacing: 1.5
      });

      doc.y = 105;
      doc.font("Helvetica-Bold").fontSize(24).fillColor(COLORS.text);
      doc.text("Contratto Ricardiano", M, doc.y, { width: W, align: "center" });
      doc.moveDown(0.2);
      doc.font("Helvetica").fontSize(13).fillColor(COLORS.muted);
      doc.text("per Servizi di Trascrizione Dati su Blockchain", M, doc.y, { width: W, align: "center" });
      doc.moveDown(0.15);
      doc.font("Helvetica").fontSize(12).fillColor(COLORS.muted);
      doc.text("Tracciabilità di dataset forestali", M, doc.y, { width: W, align: "center" });
      doc.moveDown(0.4);
      doc.font("Helvetica-Oblique").fontSize(10.5).fillColor(COLORS.faint);
      doc.text(
        "Testo legale in linguaggio naturale con Allegati Tecnici di collegamento agli smart contract",
        M, doc.y, { width: W, align: "center" }
      );

      doc.moveDown(1.2);
      const sepY = doc.y;
      doc.save().strokeColor(COLORS.accent).lineWidth(1.5);
      doc.moveTo(M + W * 0.35, sepY).lineTo(M + W * 0.65, sepY).stroke();
      doc.restore();
      doc.y = sepY + 18;

      // Forest Unit
      const fuY = doc.y;
      const fuH = 70;
      doc.save();
      doc.fillColor(COLORS.accentSoft).strokeColor(COLORS.accent).lineWidth(1);
      doc.rect(M, fuY, W, fuH).fillAndStroke();
      doc.restore();
      doc.font("Helvetica").fontSize(9).fillColor(COLORS.muted);
      doc.text("FOREST UNIT", M, fuY + 12, { width: W, align: "center", characterSpacing: 2 });
      doc.font("Helvetica-Bold").fontSize(20).fillColor(COLORS.accent);
      doc.text(forestUnit, M, fuY + 28, { width: W, align: "center" });
      doc.font("Helvetica").fontSize(9).fillColor(COLORS.faint);
      doc.text(
        `Type: ${safe(ricardian?.type)} - Version: ${safe(ricardian?.version)}`,
        M, fuY + 53, { width: W, align: "center" }
      );
      doc.y = fuY + fuH + 16;

      // Parti
      const partiesY = doc.y;
      const colW = (W - 12) / 2;
      const partiesH = 100;

      doc.save();
      doc.fillColor(COLORS.boxFill).strokeColor(COLORS.line);
      doc.rect(M, partiesY, colW, partiesH).fillAndStroke();
      doc.restore();
      doc.font("Helvetica-Bold").fontSize(8.5).fillColor(COLORS.accent);
      doc.text("FORNITORE (ISSUER)", M + 10, partiesY + 10, { width: colW - 20, characterSpacing: 1 });
      doc.font("Helvetica-Bold").fontSize(11).fillColor(COLORS.text);
      doc.text(issuerName, M + 10, partiesY + 26, { width: colW - 20 });
      doc.font("Helvetica").fontSize(8.5).fillColor(COLORS.muted);
      doc.text(truncate(issuer.role, 90), M + 10, partiesY + 44, { width: colW - 20, lineGap: 1 });
      if (issuer.identification?.method) {
        doc.font("Helvetica-Bold").fontSize(8).fillColor(COLORS.faint);
        doc.text(`ID: ${issuer.identification.method} - ${issuerIdent}`,
          M + 10, partiesY + partiesH - 18, { width: colW - 20 });
      }

      const colSubX = M + colW + 12;
      const subOk = !!subscriber.legalEntity;
      doc.save();
      doc.fillColor(subOk ? COLORS.boxFill : COLORS.warnFill)
        .strokeColor(subOk ? COLORS.line : COLORS.warn);
      doc.rect(colSubX, partiesY, colW, partiesH).fillAndStroke();
      doc.restore();
      doc.font("Helvetica-Bold").fontSize(8.5).fillColor(subOk ? COLORS.accent : COLORS.warn);
      doc.text("SOTTOSCRITTORE (SUBSCRIBER)", colSubX + 10, partiesY + 10, { width: colW - 20, characterSpacing: 1 });
      doc.font("Helvetica-Bold").fontSize(11).fillColor(subOk ? COLORS.text : COLORS.warn);
      doc.text(subOk ? subName : "Identificazione mancante", colSubX + 10, partiesY + 26, { width: colW - 20 });
      doc.font("Helvetica").fontSize(8.5).fillColor(COLORS.muted);
      doc.text(truncate(subscriber.role, 90), colSubX + 10, partiesY + 44, { width: colW - 20, lineGap: 1 });
      if (subscriber.identification?.method) {
        doc.font("Helvetica-Bold").fontSize(8).fillColor(COLORS.faint);
        doc.text(`ID: ${subMethod} - ${subIdent}`,
          colSubX + 10, partiesY + partiesH - 18, { width: colW - 20 });
      }

      doc.y = partiesY + partiesH + 16;

      // Identificatori tecnici (sintesi; dettagli negli Allegati)
      const techY = doc.y;
      const techH = 110;
      doc.save();
      doc.fillColor(COLORS.boxFill).strokeColor(COLORS.line);
      doc.rect(M, techY, W, techH).fillAndStroke();
      doc.restore();
      doc.font("Helvetica-Bold").fontSize(8.5).fillColor(COLORS.accent);
      doc.text("IDENTIFICATORI TECNICI (DETTAGLI: ALLEGATI TECNICI A E B)", M + 10, techY + 10, { width: W - 20, characterSpacing: 1 });

      let ty = techY + 28;
      doc.font("Helvetica-Bold").fontSize(8).fillColor(COLORS.muted);
      doc.text("Ricardian hash", M + 10, ty, { width: W - 20 });
      doc.font("Courier").fontSize(8.5).fillColor(COLORS.text);
      doc.text(safe(ricardian?.ricardianHash) || "-", M + 10, ty + 11, { width: W - 20 });

      ty += 28;
      doc.font("Helvetica-Bold").fontSize(8).fillColor(COLORS.muted);
      doc.text("Merkle root", M + 10, ty, { width: W - 20 });
      doc.font("Courier").fontSize(8.5).fillColor(COLORS.text);
      doc.text(safe(t.merkleRootUnified) || "-", M + 10, ty + 11, { width: W - 20 });

      ty += 28;
      doc.font("Helvetica-Bold").fontSize(8).fillColor(COLORS.muted);
      doc.text(`Network: ${networkName}`, M + 10, ty, { width: (W - 20) / 2 });
      if (verifyingContract) {
        doc.font("Courier").fontSize(8).fillColor(COLORS.text);
        doc.text(`Contract: ${verifyingContract}`, M + 10 + (W - 20) / 2, ty, { width: (W - 20) / 2 });
      }
      doc.y = techY + techH + 16;

      // Callout validazione temporale
      const badgeY = doc.y;
      const badgeH = 50;
      doc.save();
      doc.fillColor(COLORS.accent).strokeColor(COLORS.accent);
      doc.rect(M, badgeY, W, badgeH).fillAndStroke();
      doc.restore();
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#FFFFFF");
      doc.text("VALIDAZIONE TEMPORALE NON QUALIFICATA",
        M, badgeY + 10, { width: W, align: "center", characterSpacing: 1.5 });
      doc.font("Helvetica").fontSize(9).fillColor("#FFFFFF");
      doc.text("ai sensi dell'art. 41 Reg. (UE) 910/2014, in combinato disposto con art. 8-ter c.3 L. 12/2019",
        M, badgeY + 26, { width: W, align: "center" });
doc.y = badgeY + badgeH + 12;

      // QR code di verifica on-chain (scansionabile per aprire l'explorer, es. Sepolia)
      if (verifyQrDataUrl) {
        const qrSize = 76;
        const qrX = (doc.page.width - qrSize) / 2;
        const qrY = doc.y;
        try {
          doc.image(verifyQrDataUrl, qrX, qrY, { width: qrSize, height: qrSize });
        } catch (_e) { /* se l'immagine non è valida, si prosegue senza */ }
        doc.font("Helvetica").fontSize(8).fillColor(COLORS.muted);
        doc.text("Inquadra il QR per verificare l'ancoraggio on-chain",
          M, qrY + qrSize + 5, { width: W, align: "center" });
        doc.font("Courier").fontSize(7).fillColor(COLORS.link);
        doc.text(truncate(verifyUrl, 78), M, qrY + qrSize + 16, { width: W, align: "center" });
        doc.y = qrY + qrSize + 26;
      }

      doc.font("Helvetica").fontSize(8.5).fillColor(COLORS.faint);
      doc.text("Data di creazione", M, doc.y, { width: W, align: "center" });
      doc.font("Helvetica-Bold").fontSize(10.5).fillColor(COLORS.muted);
      doc.text(fmtDate(ricardian?.timestamps?.createdAt), M, doc.y + 2, { width: W, align: "center" });

      addFooter();
      doc.addPage();
    }

    renderFrontPage();

    // ==================================================================
    // PREMESSE (RECITALS)
    // ==================================================================
    annexTitle("Premesse", "Premesse");
    bodyPara(
      `Il presente contratto è concluso tra ${issuerName} (${issuerIdent}), di seguito il ` +
      `\u201CFornitore\u201D o \u201CIssuer\u201D, e ${subName} (${subIdent}), identificato con ` +
      `metodo \u201C${subMethod}\u201D, di seguito il \u201CSottoscrittore\u201D.`
    );
    clause("(A)",
      "Il Fornitore mette a disposizione una piattaforma web che consente la trascrizione " +
      "automatizzata su blockchain di evidenze crittografiche relative a dati conferiti dal " +
      "Sottoscrittore, mediante l'esecuzione di smart contract su rete EVM pubblica."
    );
    clause("(B)",
      `Il Sottoscrittore intende avvalersi del servizio per la tracciabilità, la prova di ` +
      `integrità e l'auditabilità del dataset forestale relativo alla Forest Unit ` +
      `\u201C${forestUnit}\u201D, comprensivo delle categorie di dati: ${includedData}.`
    );
    clause("(C)",
      "Le parti intendono disciplinare i propri rapporti mediante il presente contratto " +
      "ricardiano, ossia un testo leggibile da esseri umani il cui hash crittografico è " +
      "incorporato per riferimento negli smart contract eseguiti sulla blockchain indicata " +
      "nell'Allegato Tecnico B, così da vincolare in modo verificabile il testo legale al " +
      "codice che ne automatizza l'esecuzione."
    );
    clause("(D)",
      `Le operazioni on-chain sono eseguite su ${networkName}; gli hash del presente ` +
      "contratto e del dataset sono incorporati nello smart contract identificato " +
      "nell'Allegato Tecnico B. Il dataset resta off-chain: on-chain sono registrati " +
      "esclusivamente hash crittografici e URI di reperimento, mai dati personali in chiaro " +
      "né payload sostanziale."
    );
    bodyPara(
      "Le premesse e gli Allegati Tecnici A e B formano parte integrante e sostanziale del " +
      "presente contratto."
    );

    // ==================================================================
    // ART. 1 — DEFINIZIONI
    // ==================================================================
    articleTitle(1, "Definizioni");
    bodyPara("Ai fini del presente contratto, i termini che seguono hanno il significato di seguito indicato:");
    definition("Blockchain",
      `registro distribuito avente caratteristiche di immutabilità e trasparenza; nel caso di ` +
      `specie, la rete ${networkName}, come specificato nell'Allegato Tecnico B.`
    );
    definition("Smart Contract",
      "codice informatico eseguito su Blockchain che automatizza, in tutto o in parte, " +
      "l'esecuzione delle obbligazioni previste nel presente contratto; le specifiche " +
      "funzionali sono riportate nell'Allegato Tecnico B."
    );
    definition("Contratto Ricardiano",
      `il presente documento, versione ${safe(ricardian?.version) || "-"}, il cui hash ` +
      "crittografico (Ricardian hash) è riportato nell'Allegato Tecnico A ed è richiamato " +
      "dallo Smart Contract di cui all'Allegato Tecnico B."
    );
    definition("Dati o Dataset Forestale",
      `l'insieme delle informazioni conferite dal Sottoscrittore relative alla Forest Unit ` +
      `\u201C${forestUnit}\u201D (categorie: ${includedData}), i cui hash sono registrati su ` +
      "Blockchain secondo le specifiche dell'Allegato Tecnico A."
    );
    definition("Merkle Root",
      "il vertice dell'albero di Merkle costruito sul Dataset Forestale, che consente la " +
      "verifica di appartenenza di ogni singolo elemento mediante Merkle proof."
    );
    definition("Firma di Sistema (EIP-712)",
      "la firma elettronica apposta dal Fornitore sui dati di ancoraggio secondo lo standard " +
      "EIP-712, che attesta la provenienza dell'ancoraggio dalla piattaforma del Fornitore."
    );
    definition("Controfirma CAdES",
      "l'eventuale firma elettronica in formato CAdES (CMS Advanced Electronic Signatures, in " +
      "formato DER) apposta dal Sottoscrittore sul presente documento, il cui livello (semplice, " +
      "avanzata o qualificata) è determinato a runtime mediante validazione DSS contro la EU LOTL " +
      "(European Union List of Trusted Lists, l'elenco ufficiale dei prestatori di servizi fiduciari " +
      "qualificati pubblicato dalla Commissione europea)."
    );
    definition("Servizio",
      "l'insieme delle funzionalità offerte dalla piattaforma web del Fornitore per la " +
      "predisposizione, validazione e trascrizione su Blockchain delle evidenze relative ai Dati."
    );

    // ==================================================================
    // ART. 2 — OGGETTO
    // ==================================================================
    articleTitle(2, "Oggetto del contratto");
    clause("2.1",
      "Con il presente contratto il Fornitore si obbliga a mettere a disposizione del " +
      "Sottoscrittore il Servizio di predisposizione, validazione e trascrizione su " +
      "Blockchain delle evidenze crittografiche relative ai Dati conferiti dal " +
      "Sottoscrittore, mediante l'esecuzione dello Smart Contract descritto nell'Allegato " +
      "Tecnico B. Il Sottoscrittore si obbliga a utilizzare il Servizio nel rispetto delle " +
      "condizioni qui previste."
    );
    clause("2.2", safe(ricardian?.purpose));
    clause("2.3",
      "In particolare, per ciascuna registrazione il Servizio provvede: alla costruzione di " +
      "un albero di Merkle sul dataset off-chain; alla firma EIP-712 dell'ancoraggio da " +
      "parte del Fornitore; alla registrazione on-chain del Ricardian hash e della Merkle root " +
      "su rete EVM pubblica; nonché, ove richiesta, alla raccolta della Controfirma CAdES " +
      "del presente documento da parte del Sottoscrittore."
    );
    clause("2.4",
      "Il Dataset Forestale resta in ogni caso off-chain. On-chain sono registrati " +
      "esclusivamente hash crittografici e URI di reperimento, mai dati personali in chiaro " +
      "né payload sostanziale."
    );

    // ==================================================================
    // ART. 3 — FUNZIONAMENTO SMART CONTRACT E GOVERNANCE TECNICA
    // ==================================================================
    articleTitle(3, "Funzionamento degli Smart Contract e governanza tecnica");
    clause("3.1",
      "Lo Smart Contract esegue automaticamente le operazioni di ricezione e verifica degli " +
      "hash dei Dati, validazione dei parametri (firma di sistema, identificativo della " +
      "Forest Unit, riferimento temporale), scrittura on-chain dell'ancoraggio ed emissione " +
      "di un identificativo univoco di registrazione (transaction hash e block number). La " +
      "corrispondenza fra le funzioni del codice e le clausole del presente contratto è " +
      "riportata nella tabella di mappatura dell'Allegato Tecnico B."
    );
    clause("3.2",
      "In caso di conflitto tra il presente testo contrattuale e il comportamento effettivo " +
      "dello Smart Contract, le parti convengono che prevarrà il presente testo e che " +
      "eventuali malfunzionamenti del codice saranno gestiti come inadempimento o errore " +
      "tecnico, secondo i rimedi previsti dal presente contratto e dalla legge applicabile."
    );
    clause("3.3",
      "Qualsiasi modifica della logica dello Smart Contract dovrà essere associata a una " +
      "nuova versione del presente Contratto Ricardiano, con nuovo hash registrato on-chain " +
      "e nuova accettazione espressa del Sottoscrittore tramite la piattaforma. Le versioni " +
      "precedenti restano verificabili mediante gli ancoraggi già registrati, per loro " +
      "natura immutabili."
    );

    // ==================================================================
    // ART. 4 — OBBLIGHI DEL FORNITORE
    // ==================================================================
    articleTitle(4, "Obblighi del Fornitore");
    clause("4.1", safe(rd.issuer));
    clause("4.2",
      "Il Fornitore garantisce che lo Smart Contract utilizzato è quello descritto e " +
      "versionato nell'Allegato Tecnico B e cura la corretta trascrizione on-chain delle " +
      "evidenze, salvo cause di forza maggiore o malfunzionamenti della rete Blockchain non " +
      "imputabili al Fornitore medesimo."
    );
    clause("4.3",
      "Il Fornitore informa il Sottoscrittore delle limitazioni tecniche intrinseche della " +
      "tecnologia impiegata, fra cui l'immutabilità e l'irreversibilità delle registrazioni " +
      "on-chain, nonché delle relative implicazioni di compliance, ivi incluse le " +
      "limitazioni rispetto all'esercizio del diritto alla cancellazione per i contenuti " +
      "registrati on-chain (che, per le ragioni di cui all'art. 2.4, non includono dati " +
      "personali in chiaro)."
    );

    // ==================================================================
    // ART. 5 — OBBLIGHI DEL SOTTOSCRITTORE E RUOLI OPERATIVI
    // ==================================================================
    articleTitle(5, "Obblighi del Sottoscrittore e ruoli operativi");
    clause("5.1", safe(rd.subscriber));
    clause("5.2",
      "Il Sottoscrittore si impegna a conferire Dati veritieri, leciti e non in violazione " +
      "di diritti di terzi, a non utilizzare il Servizio per finalità illecite e a mantenere " +
      "riservate le proprie credenziali di accesso alla piattaforma nonché le eventuali " +
      "chiavi private utilizzate per la sottoscrizione delle operazioni."
    );
    clause("5.3",
      "I ruoli operativi di data producer, ossia l'operatore forestale che opera tramite " +
      "app mobile e l'operatore drone che esegue rilievi aerei georeferenziati, sono definiti " +
      "sotto l'autorità e la responsabilità del Sottoscrittore, il quale garantisce la " +
      "correttezza della raccolta sul campo e la coerenza del processo di generazione dei Dati."
    );
    clause("5.4",
      `Il ruolo di data consumer è ricoperto dal ${safe(rd.dataConsumer).charAt(0).toLowerCase()}${safe(rd.dataConsumer).slice(1)}`
    );

    // ==================================================================
    // ART. 6 — FIRME E VALIDAZIONE TEMPORALE
    // ==================================================================
    articleTitle(6, "Firme elettroniche e validazione temporale");
    clause("6.1",
      `Sull'ancoraggio il Fornitore appone la propria ${safe(sysSig.type).charAt(0).toLowerCase()}${safe(sysSig.type).slice(1)}, ` +
      `generata dall'indirizzo indicato nell'Allegato Tecnico B. ` +
      `${safe(sysSig.purpose)} ${safe(sysSig.legalQualification)}`
    );
    clause("6.2",
      `Oltre alla firma di sistema, il Sottoscrittore ha facoltà di apporre sul presente ` +
      `documento una propria controfirma elettronica in formato ${safe(userSig.type)}, così da ` +
      "ricondurre l'ancoraggio alla propria volontà negoziale. Il livello effettivo di tale " +
      "controfirma non è predeterminato, ma viene accertato di volta in volta al momento della " +
      "verifica, attraverso la validazione DSS condotta contro la EU LOTL. " +
      `${safe(userSig.legalQualification)}`
    );
    clause("6.3",
      `Quanto alla collocazione temporale delle registrazioni, le parti danno atto che essa ` +
      `gode di una validazione di livello \u201C${safe(tsv.level)}\u201D, fondata su ` +
      `${safe(tsv.basis)}. ${safe(tsv.effects)}`
    );

    // ==================================================================
    // ART. 7 — PROCEDURA DI VERIFICA E VALORE PROBATORIO
    // ==================================================================
    articleTitle(7, "Procedura di verifica e valore probatorio");
    clause("7.1",
      `Chiunque vi abbia interesse può verificare le evidenze mediante l'endpoint di ` +
      `riferimento ${safe(vp.referenceImplementation)}, secondo la procedura di cui ai ` +
      "commi seguenti."
    );
    clause("7.2", `Verifica on-chain. ${safe(vp.onChain)}`);
    clause("7.3", `Verifica delle Merkle proof. ${safe(vp.merkleProofs)}`);
    clause("7.4", `Verifica di integrità del documento. ${safe(vp.integrity)}`);
    clause("7.5", `Validazione della Controfirma CAdES, ove presente. ${safe(vp.cadesValidation)}`);
    clause("7.6",
      "Le parti convengono che la registrazione dell'ancoraggio mediante la funzione " +
      "registerRicardianForest dello Smart Contract, comprovata dal relativo transaction " +
      "hash, costituisce prova dell'avvenuta trascrizione ai fini dell'adempimento " +
      "dell'obbligazione del Fornitore di cui all'art. 4.2. La registrazione così effettuata " +
      "si considera definitiva e immodificabile, fatti salvi i rimedi previsti nel presente " +
      "contratto in caso di malfunzionamento o abuso."
    );
    clause("7.7",
      "A completamento della procedura, il Fornitore mette a disposizione un evidence pack " +
      "esportabile che raccoglie l'insieme degli elementi probatori: il ricardianHash, la " +
      "merkleRoot, lo snapshot del dataset, il timestamp DLT, la firma di sistema EIP-712 e i " +
      "riferimenti on-chain (txHash e blockNumber); ove presenti, vi sono inclusi anche la " +
      "controfirma CAdES e il relativo report di validazione DSS."
    );

    // ==================================================================
    // ART. 8 — TRATTAMENTO DEI DATI PERSONALI
    // ==================================================================
    articleTitle(8, "Trattamento dei dati personali e sicurezza");
    clause("8.1",
      `${safe(gdpr.personalDataHandling)}. La base giuridica del trattamento è ` +
      `${safe(gdpr.lawfulBasis).charAt(0).toLowerCase()}${safe(gdpr.lawfulBasis).slice(1)}, ` +
      "documento al quale si rinvia per la disciplina di dettaglio dei reciproci obblighi in " +
      "materia di protezione dei dati personali."
    );
    clause("8.2",
      `In attuazione del principio di minimizzazione, ${safe(gdpr.dataMinimisation).charAt(0).toLowerCase()}${safe(gdpr.dataMinimisation).slice(1)}. ` +
      "Il contenuto sostanziale dei Dati è conservato off-chain secondo misure tecniche e " +
      `organizzative adeguate ai sensi dell'art. 32 GDPR. L'eventuale utilizzo di storage distribuito IPFS è ` +
      `${safe(gdpr.ipfsUsageStatement).charAt(0).toLowerCase()}${safe(gdpr.ipfsUsageStatement).slice(1)}`
    );
    clause("8.3",
      `I diritti degli interessati sono ${safe(gdpr.dataSubjectRights).charAt(0).toLowerCase()}${safe(gdpr.dataSubjectRights).slice(1)}`
    );
    clause("8.4", safe(ricardian?.dataGovernance?.dpiaStatus));

    // ==================================================================
    // ART. 9 — RESPONSABILITÀ, LIMITAZIONI ED ESCLUSIONI
    // ==================================================================
    articleTitle(9, "Responsabilità, limitazioni ed esclusioni espresse");
    // Numerazione dinamica: la clausola EUDR è opzionale e non lascia buchi se omessa.
    let n9 = 0;
    const c9 = (text) => clause(`9.${++n9}`, text);
    c9(
      "Il Fornitore non risponde dell'indisponibilità o dei malfunzionamenti della rete " +
      "Blockchain, di hard fork, attacchi alla rete o mutamenti delle relative policy, né " +
      "dell'uso improprio del Servizio da parte del Sottoscrittore, salvo il caso di dolo o " +
      "colpa grave. Il Sottoscrittore manleva il Fornitore dai danni derivanti " +
      "dall'illiceità dei Dati trascritti o dalla violazione di diritti di terzi."
    );
    c9(safe(disc.qualifiedTrustServiceStatus));
    c9(safe(disc.archivalStatus));
    c9(safe(disc.certifications));
    // Clausola EUDR opzionale: inclusa solo se valorizzata in disclaimers.eudr.
    if (safe(disc.eudr)) c9(safe(disc.eudr));
    c9(safe(disc.legalAdvice));

    // ==================================================================
    // ART. 10 — DURATA E CONSERVAZIONE DELLE EVIDENZE
    // ==================================================================
    articleTitle(10, "Durata e conservazione delle evidenze");
    clause("10.1",
      "Le registrazioni on-chain effettuate durante la vigenza del rapporto restano in ogni " +
      `caso immutabili e a disposizione delle parti: la relativa conservazione è ` +
      `${safe(retention.onChainEvidence).charAt(0).toLowerCase()}${safe(retention.onChainEvidence).slice(1)}.`
    );
    clause("10.2",
      `Le evidenze off-chain (documento ricardiano, controfirme e report di validazione) ` +
      `sono conservate per ${safe(retention.offChainEvidence).charAt(0).toLowerCase()}${safe(retention.offChainEvidence).slice(1)}`
    );

    // ==================================================================
    // ART. 11 — LEGGE APPLICABILE E FORO
    // ==================================================================
    articleTitle(11, "Legge applicabile e foro competente");
    const glList = Array.isArray(ricardian?.governingLaw) ? ricardian.governingLaw.join("; ") : safe(ricardian?.governingLaw);
    clause("11.1",
      `Il presente contratto è regolato dal diritto della Repubblica Italiana e dalla ` +
      `normativa dell'Unione Europea applicabile, con particolare riferimento a: ${glList}.`
    );
    clause("11.2", `Per ogni controversia è competente il ${safe(ricardian?.jurisdiction?.courts).charAt(0).toLowerCase()}${safe(ricardian?.jurisdiction?.courts).slice(1)}.`);

    // ==================================================================
    // ART. 12 — DICHIARAZIONE FINALE
    // ==================================================================
    articleTitle(12, "Dichiarazione finale");
    clause("12.1", safe(ricardian?.legal?.statement));
    clause("12.2",
      "Il Ricardian hash riportato nell'Allegato Tecnico A vincola crittograficamente sia il " +
      "testo human-readable del presente documento sia la Merkle root del Dataset Forestale, " +
      "realizzando il collegamento ricardiano fra testo legale e codice."
    );

    // ==================================================================
    // ALLEGATO TECNICO A — PARAMETRI E HASH
    // ==================================================================
    doc.addPage();
    annexTitle("Allegato Tecnico A", "Parametri crittografici e hash");
    bodyPara(
      "Il presente Allegato riporta i parametri tecnici e gli hash che identificano in modo " +
      "univoco il Contratto Ricardiano e il Dataset Forestale, ai sensi degli artt. 1 e 12."
    );
    kvTable([
      ["Ricardian hash", safe(ricardian?.ricardianHash)],
      ["Merkle root", safe(t.merkleRootUnified)],
      ["Algoritmo di hashing", safe(t.hashAlgorithm)],
      ["Struttura dati", safe(t.merkleStructure) || "Merkle tree (sortPairs)"],
      ["Formato batch", safe(t.batchFormat)],
      ["Storage JSON ricardiano", safe(t.storage)],
      ["Data di creazione", safe(ricardian?.timestamps?.createdAt)]
    ], { mono: new Set([0, 1]) });

    // ==================================================================
    // ALLEGATO TECNICO B — SPECIFICHE DEGLI SMART CONTRACT
    // ==================================================================
    annexTitle("Allegato Tecnico B", "Specifiche degli Smart Contract");
    subTitle("B.1 Identificazione on-chain");
    kvTable([
      ["Network", `${networkName} (chainId ${domain.chainId || "-"})`],
      ["Indirizzo Smart Contract", verifyingContract || "-"],
      ["Block explorer", verifyingContract ? `${explorerBase}address/${verifyingContract}` : explorerBase],
      ["Dominio EIP-712", `${safe(domain.name)} v${safe(domain.version)}`],
      ["Signer (Fornitore)", safe(eip.signer)],
      ["Firma EIP-712", safe(eip.signature)]
    ], { mono: new Set([1, 4, 5]) });

    subTitle("B.2 Mappatura fra clausole contrattuali e funzioni on-chain");
    bodyPara(
      "La mappatura che segue ha funzione meramente ricognitiva del collegamento fra le clausole " +
      "del presente contratto e le funzioni eseguite on-chain. In caso di divergenza fra il " +
      "comportamento del codice e il testo contrattuale prevale quest'ultimo, ai sensi dell'art. 3.2."
    );
    mappingTable([
      ["Artt. 2.3, 4.2, 7.6", "registerRicardianForest(forestUnitId, ricardianHash, merkleRoot, storageUri)"],
      ["Artt. 7.4, 12.2", "setRicardianPdfUri(forestUnitId, pdfUri)"],
      ["Art. 6.2", "registerUserCountersignature(...)"],
      ["Artt. 7.2, 7.3", "verifyUnifiedProofWithRoot(leaf, proof, root)"]
    ]);

    doc.end();
    stream.on("finish", resolve);
    stream.on("error", reject);
    })().catch(reject);
  });
}

async function topviewGetForestUnit(forestUnitId) {
  const token = state.topview?.token;

  if (!token) {
    const err = new Error("Token mancante (TopView login non eseguito)");
    err.meta = { step: "getForestUnit" };
    throw err;
  }

  const url = `https://digimedfor.topview.it/api/get-forest-unit/${forestUnitId}/`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/json",
      "Content-Type": "application/json"
    }
  });

  const rawText = await res.text();
  const contentType = res.headers.get("content-type") || "";

  let data = null;
  if (contentType.includes("application/json")) {
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      const err = new Error("TopView ha risposto con content-type JSON ma body non parsabile");
      err.meta = {
        url,
        status: res.status,
        contentType,
        bodyPreview: rawText.slice(0, 500)
      };
      throw err;
    }
  } else {
    const err = new Error("TopView non ha restituito JSON");
    err.meta = {
      url,
      status: res.status,
      contentType,
      bodyPreview: rawText.slice(0, 500)
    };
    throw err;
  }

  if (!res.ok) {
    const err = new Error("TopView get-forest-unit failed");
    err.meta = {
      url,
      status: res.status,
      data
    };
    throw err;
  }

  return data;
}

function ensurePdfBaselineIntegrity(forestUnitId) {
  const r = state.ricardians?.[forestUnitId];

  if (!r) {
    throw new Error("Ricardian non trovato in state");
  }

  if (!r.pdfPath || !fs.existsSync(r.pdfPath)) {
    throw new Error("PDF originale non trovato su disco");
  }

  if (!r.pdfHash) {
    throw new Error("pdfHash di baseline non presente");
  }

  const currentLocalPdfHash = sha256FileBytes32(r.pdfPath);

  if (currentLocalPdfHash.toLowerCase() !== String(r.pdfHash).toLowerCase()) {
    const e = new Error("Il PDF locale non coincide con la baseline registrata");
    e.meta = {
      expectedPdfHash: r.pdfHash,
      currentLocalPdfHash,
      pdfPath: r.pdfPath
    };
    throw e;
  }

  return {
    pdfPath: r.pdfPath,
    registeredPdfHash: r.pdfHash,
    currentLocalPdfHash
  };
}

async function verifyCadesSignatureTrust(p7mPath, caFilePath) {
  try {
    if (!fs.existsSync(caFilePath)) {
      return {
        ok: false,
        trusted: false,
        error: `CA file non trovato: ${caFilePath}`
      };
    }

    const { stderr } = await execFileAsync("openssl", [
      "cms",
      "-verify",
      "-inform", "DER",
      "-binary",
      "-in", p7mPath,
      "-CAfile", caFilePath,
      "-out", process.platform === "win32" ? "NUL" : "/dev/null"
    ]);

    return {
      ok: true,
      trusted: true,
      details: stderr || ""
    };
  } catch (err) {
    return {
      ok: false,
      trusted: false,
      error: err.message
    };
  }
}

async function verifyCadesSignatureTrustWithGosign(p7mPath) {
  try {
    const { stdout, stderr } = await execFileAsync("gosign", [
      "verify",
      p7mPath
    ]);

    return {
      ok: true,
      trusted: true,
      provider: "gosign",
      details: [stdout, stderr].filter(Boolean).join("\n").trim()
    };
  } catch (err) {
    return {
      ok: false,
      trusted: false,
      provider: "gosign",
      error: err.stderr || err.stdout || err.message
    };
  }
}

async function verifyCadesSignatureTrustHybrid(p7mPath, caFilePath) {
  const opensslResult = await verifyCadesSignatureTrust(p7mPath, caFilePath);

  if (opensslResult.trusted === true) {
    return {
      ...opensslResult,
      provider: "openssl"
    };
  }

  const gosignResult = await verifyCadesSignatureTrustWithGosign(p7mPath);

  if (gosignResult.trusted === true) {
    return {
      ok: true,
      trusted: true,
      provider: "gosign",
      details: [
        "OpenSSL failed, fallback Gosign succeeded.",
        opensslResult.error ? `OpenSSL error: ${opensslResult.error}` : "",
        gosignResult.details || ""
      ].filter(Boolean).join("\n")
    };
  }

  return {
    ok: false,
    trusted: false,
    provider: "openssl+gosign",
    error: [
      opensslResult.error ? `OpenSSL: ${opensslResult.error}` : "",
      gosignResult.error ? `Gosign: ${gosignResult.error}` : ""
    ].filter(Boolean).join("\n\n")
  };
}

// --------------------
// HEALTH
// --------------------
app.get("/health", (_, res) => res.json({ ok: true }));

// JSON Ricardian
app.get("/api/ricardian/json/:forestUnitId", (req, res) => {
  const forestUnitId = req.params.forestUnitId;
  const safeName = String(forestUnitId).replace(/[^a-zA-Z0-9_-]/g, "_");

  const filePath = path.join(RICARDIAN_DIR, `ricardian-${safeName}.json`);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "Ricardian JSON non trovato" });
  }

  res.sendFile(filePath);
});

app.get("/api/ricardian/pdf/:forestUnitId/view", (req, res) => {
  const forestUnitId = req.params.forestUnitId;
  const safeName = String(forestUnitId).replace(/[^a-zA-Z0-9_-]/g, "_");
  const filePath = path.join(RICARDIAN_DIR, `ricardian-${safeName}.pdf`);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "PDF non trovato" });
  }

  res.sendFile(filePath);
});

app.get("/api/ricardian/pdf/:forestUnitId/download", (req, res) => {
  const forestUnitId = req.params.forestUnitId;
  const safeName = String(forestUnitId).replace(/[^a-zA-Z0-9_-]/g, "_");
  const filePath = path.join(RICARDIAN_DIR, `ricardian-${safeName}.pdf`);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "PDF non trovato" });
  }

  res.download(filePath);
});

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
// 2) Import latest forest unit
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

    const selectedForestKey = keys[keys.length - 2];
    const unit = forestUnits[selectedForestKey];

    state.forestUnitsRemote = forestUnits;
    state.lastImportedForestUnitKey = selectedForestKey;
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
// 3) Build unified batch + merkle root
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

    const formatDate = (d) => (d ? new Date(d).toISOString() : "");

    function addToBatch(obj) {
      const leafHash = hashUnified(obj);
      leaves.push(leafHash);
      batchWithProof.push({ ...obj });
      if (obj?.epc) seenEpcs.add(obj.epc);
    }

    const trees = unit.trees || {};
    for (const treeId of Object.keys(trees)) {
      const t = trees[treeId];
      const treeEpc = t.EPC || t.epc || t.domainUUID || treeId;

      const treeObj = {
        type: "Tree",
        epc: treeEpc,
        firstReading: formatDate(t.firstReadingTime),
        treeType: t.treeType?.specie || t.treeTypeId || t.specie || "Unknown",
        coordinates: t.coordinates
          ? `${t.coordinates.latitude ?? t.coordinates.lat ?? ""},${t.coordinates.longitude ?? t.coordinates.lon ?? ""}`.replace(/(^,|,$)/g, "")
          : "",
        notes: Array.isArray(t.notes) ? t.notes.map(n => n.description || n).join("; ") : (t.notes || ""),
        observations: getObservations(t),
        forestUnitId,
        domainUUID: t.domainUUID || t.domainUuid,
        deleted: !!t.deleted,
        lastModification: t.lastModification || t.lastModfication || ""
      };

      addToBatch(treeObj);
    }

    const unitWoodLogs = unit.woodLogs || {};
    for (const logId of Object.keys(unitWoodLogs)) {
      const log = unitWoodLogs[logId] || {};
      const logEpc = normalizeEpc(log.EPC || log.epc || log.domainUUID || logId);

      if (seenEpcs.has(logEpc)) continue;

      const parentTree = log.treeID || log.treeId || log.parentTree || "";

      const logObj = {
        type: "WoodLog",
        epc: logEpc,
        firstReading: formatDate(log.firstReadingTime),
        treeType: log.treeType?.specie || log.treeTypeId || "Unknown",
        logSectionNumber: log.logSectionNumber || 1,
        parentTree: parentTree,
        coordinates: log.coordinates
          ? `${log.coordinates.latitude ?? log.coordinates.lat ?? ""},${log.coordinates.longitude ?? log.coordinates.lon ?? ""}`.replace(/(^,|,$)/g, "")
          : "",
        notes: Array.isArray(log.notes) ? log.notes.map(n => n.description || n).join("; ") : (log.notes || ""),
        observations: getObservations(log),
        forestUnitId,
        domainUUID: log.domainUUID || log.domainUuid,
        deleted: !!log.deleted,
        lastModification: log.lastModification || log.lastModfication || ""
      };

      addToBatch(logObj);
    }

    const unitSawnTimbers = unit.sawnTimbers || {};
    for (const stId of Object.keys(unitSawnTimbers)) {
      const st = unitSawnTimbers[stId] || {};
      const stEpc = normalizeEpc(st.EPC || st.epc || st.domainUUID || stId);

      if (seenEpcs.has(stEpc)) continue;

      const stObj = {
        type: "SawnTimber",
        epc: stEpc,
        firstReading: formatDate(st.firstReadingTime),
        treeType: st.treeType?.specie || st.treeTypeId || "Unknown",
        parentTreeEpc: st.parentTreeEpc || st.treeID || st.treeId || "",
        parentWoodLog: st.parentWoodLog || st.woodLogID || st.woodLogId || "",
        coordinates: st.coordinates
          ? `${st.coordinates.latitude ?? st.coordinates.lat ?? ""},${st.coordinates.longitude ?? st.coordinates.lon ?? ""}`.replace(/(^,|,$)/g, "")
          : "",
        notes: Array.isArray(st.notes) ? st.notes.map(n => n.description || n).join("; ") : (st.notes || ""),
        observations: getObservations(st),
        forestUnitId,
        domainUUID: st.domainUUID || st.domainUuid,
        deleted: !!st.deleted,
        lastModification: st.lastModification || st.lastModfication || ""
      };

      addToBatch(stObj);
    }

    const merkleTree = new MerkleTree(leaves, keccak256, { sortPairs: true });
    const root = merkleTree.getHexRoot();

    const outputDir = path.join(__dirname, "file-json");
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

    const batchFile = path.join(outputDir, "forest-unified-batch.json");
    fs.writeFileSync(batchFile, JSON.stringify(batchWithProof, null, 2));

    state.batches[forestUnitId] = { batch: batchWithProof, leaves, merkleTree, root, batchFilePath: batchFile };

    const counts = {
      trees: Object.keys(unit.trees || {}).length,
      woodLogs: Object.keys(unit.woodLogs || {}).length,
      sawnTimbers: Object.keys(unit.sawnTimbers || {}).length,
      batchSize: batchWithProof.length
    };

    res.json({
      forestUnitId,
      merkleRoot: root,
      batchFile,
      ...counts
    });
  } catch (err) {
    res.status(500).json({ error: "Build unified batch failed", details: err.message });
  }
});

// --------------------
// 4) Build + sign Ricardian (JSON+PDF)
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
  version: "2.0",
  type: "RicardianForestTracking",

  jurisdiction: {
    courts: "Foro competente italiano",
    regulatoryFramework: ["IT", "EU"]
  },

  governingLaw: "Diritto della Repubblica Italiana e normativa dell'Unione Europea applicabile",

  actors: {
    dataOwner: "TopView Srl",
    dataProducer: "Operatore drone",
    dataConsumer: "Cliente finale"
  },

  purpose: "Tracciabilità, prova di integrità e auditabilità dei dati forestali",

  scope: {
    forestUnitKey: forestUnitId,
    includedData: ["trees", "wood_logs", "sawn_timbers"]
  },

  humanReadableAgreement: {
    language: "it",
    text: `
Il presente accordo disciplina la raccolta, la registrazione, la conservazione
e la verifica dell’integrità dei dati forestali relativi all’unità forestale
"${forestUnitId}".

Le parti riconoscono che il dataset è memorizzato off-chain e che l’hash
crittografico registrato su blockchain costituisce prova di esistenza,
integrità, riferibilità temporale e auditabilità del dataset alla data di registrazione.

Il presente documento è strutturato come contratto ricardiano, essendo
interpretabile sia da esseri umani sia da sistemi automatici, e integra
elementi di governance dei dati, interoperabilità e verificabilità tecnica.
`.trim()
  },

  rightsAndDuties: {
    dataOwner: "Detiene la titolarità dei dati e autorizza la loro registrazione, conservazione e verifica",
    dataProducer: "Garantisce la correttezza della raccolta, la provenienza dei dati e la coerenza del processo di generazione",
    dataConsumer: "Può verificare l’integrità e la provenienza dei dati ma non modificarli"
  },

  technical: {
    merkleRootUnified: merkleRoot,
    batchFormat: "JSON",
    storage: storageMode, // oppure useIPFS ? "IPFS" : "LOCAL_FILE" nella route
    hashAlgorithm: "keccak256"
  },

  legal: {
    legalValue: "Valore probatorio ai sensi della normativa vigente e come evidenza tecnica di integrità",
    statement: "L'hash registrato on-chain costituisce prova di esistenza e integrità del dataset alla data di registrazione."
  },

  hashBinding: {
    bindsHumanReadableText: true,
    bindsDatasetMerkleRoot: true
  },

  canonicalization: {
    format: "UTF-8",
    ordering: "lexicographic",
    whitespace: "normalized"
  },

  dataGovernance: {
    gdprCompliance: true,
    dataMinimisation: true,
    accessControl: "Role-based access control",
    retentionPolicy: "Conservazione delle evidenze tecniche e documentali secondo obblighi legali e finalità di audit",
    personalDataHandling: "I dati personali, se presenti, sono minimizzati e trattati con misure di accesso controllato"
  },

  dataLineage: {
    source: "TopView API, rilievi di campo e dati associati all'unità forestale",
    processing: "Normalizzazione dei dati, costruzione batch unificato, Merkle tree generation, hashing Ricardiano e firma EIP-712",
    output: "Ricardian JSON, Ricardian PDF, Merkle root e registrazione on-chain",
    versioning: true
  },

  interoperability: {
    standard: "INSPIRE-aligned interoperability",
    metadata: "ISO 19115 compliant metadata profile",
    formats: ["JSON", "GeoJSON", "GPKG"]
  },

  evidencePack: {
    exportable: true,
    auditReady: true,
    includes: [
      "Merkle root",
      "Ricardian hash",
      "Dataset snapshot",
      "Timestamps",
      "Geolocation references",
      "EIP-712 signature",
      "On-chain reference"
    ]
  },

  standards: [
    "ISO 19115",
    "ISO 19157",
    "ISO/IEC 27001",
    "ISO 38200"
  ],

  regulatoryReferences: [
    "eIDAS Regulation",
    "GDPR",
    "INSPIRE Directive",
    "EUDR",
    "EU Forest Monitoring framework"
  ],

  ebsiCompliance: {
    anchoring: "Blockchain anchoring on Ethereum-compatible infrastructure",
    verifiableCredentials: false,
    trustFramework: "eIDAS / EBSI-aligned trust model",
    issuer: "TopView Srl",
    verifier: "Authorized auditor or third-party verifier"
  },

  timestamps: {
    createdAt: new Date().toISOString()
  }
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
    const signerAddress = (await signer.getAddress()).toLowerCase();

    if (recovered.toLowerCase() !== signerAddress) {
      return res.status(500).json({
        error: "Firma EIP-712 non valida (recovered != signer)",
        recovered,
        signerAddress
      });
    }

    const ricardianForest = {
      ...ricardianBase,
      ricardianHash,
      signature: {
        eip712: {
          signer: signerAddress,
          domain,
          types,
          message,
          signature: eip712Signature
        }
      }
    };

    const safeName = String(forestUnitId).replace(/[^a-zA-Z0-9_-]/g, "_");
    const ricardianJson = path.join(RICARDIAN_DIR, `ricardian-${safeName}.json`);
    fs.writeFileSync(ricardianJson, JSON.stringify(ricardianForest, null, 2));

    const ricardianPdf = path.join(RICARDIAN_DIR, `ricardian-${safeName}.pdf`);
    await generateRicardianPdf(ricardianForest, ricardianPdf);
    const pdfHash = sha256FileBytes32(ricardianPdf);

    state.ricardians[forestUnitId] = {
  ricardianBase,
  ricardianForest,
  ricardianHash,
  jsonPath: ricardianJson,
  pdfPath: ricardianPdf,
  pdfHash,
  ipfsUri: null,
  cid: null
};

    res.json({
      forestUnitId,
      ricardianHash,
      files: {
        ricardianJsonPath: ricardianJson,
        ricardianPdfPath: ricardianPdf
      }
    });
  } catch (err) {
    res.status(500).json({ error: "Build/sign Ricardian failed", details: err.message });
  }
});

// --------------------
// 5) Persist Ricardian JSON locally
// --------------------
app.post("/api/storage/persistRicardian", async (req, res) => {
  try {
    const forestUnitId = req.body?.forestUnitId;
    if (!forestUnitId) return res.status(400).json({ error: "forestUnitId richiesto" });

    const r = state.ricardians?.[forestUnitId];
    if (!r?.ricardianForest) {
      return res.status(404).json({ error: "Ricardian non trovato: chiama /api/ricardian/buildAndSign prima" });
    }

    const safeName = String(forestUnitId).replace(/[^a-zA-Z0-9_-]/g, "_");
    const outPath = path.join(RICARDIAN_DIR, `ricardian-${safeName}.json`);

    fs.writeFileSync(outPath, JSON.stringify(r.ricardianForest, null, 2));

    r.jsonPath = outPath;
    function buildServerUri(req, path) {
      const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
      return `${proto}://${req.get("host")}${path}`;
    }

    r.storageUri = `/api/ricardian/json/${forestUnitId}`;

    return res.json({
      forestUnitId,
      ricardianJsonPath: outPath,
      storageUri: r.storageUri
    });
  } catch (err) {
    return res.status(500).json({ error: "Persist Ricardian failed", details: err.message });
  }
});

// --------------------
// 6) Estimate gas + EUR
// --------------------
app.post("/api/chain/estimateRegisterRicardianForest", async (req, res) => {
  const { forestUnitId, ricardianHash, merkleRoot, storageUri } = req.body || {};
  if (!forestUnitId || !ricardianHash || !merkleRoot || !storageUri) {
    return res.status(400).json({ error: "forestUnitId, ricardianHash, merkleRoot, storageUri richiesti" });
  }

  try {
    const contractAddress = deployed.ForestTracking;
    const from = await signer.getAddress();

    const data = contract.interface.encodeFunctionData("registerRicardianForest", [
      forestUnitId,
      ricardianHash,
      merkleRoot,
      storageUri || "file://ricardian-forest.json"
    ]);

    const gasEstimate = await provider.estimateGas({
      to: contractAddress,
      data,
      from
    });

    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice ?? ethers.parseUnits("20", "gwei");

    const gasCostWei = gasEstimate * gasPrice;
    const gasCostEth = Number(ethers.formatEther(gasCostWei));
    const ethPrice = await getEthPriceInEuro();

    return res.json({
      to: contractAddress,
      from,
      gasEstimate: gasEstimate.toString(),
      gasPriceWei: gasPrice.toString(),
      gasCostWei: gasCostWei.toString(),
      gasCostEth,
      ethEur: ethPrice,
      eur: Number((gasCostEth * ethPrice).toFixed(2))
    });
  } catch (err) {
    return res.status(500).json({
      error: "Estimate gas failed",
      details: err.message,
      short: err.shortMessage,
      code: err.code
    });
  }
});

// --------------------
// 6.5) Estimate user countersignature
// --------------------
app.post("/api/chain/estimateRegisterUserCountersignature", async (req, res) => {
  try {
    const forestUnitId = req.body?.forestUnitId;
    if (!forestUnitId) return res.status(400).json({ error: "forestUnitId richiesto" });

    const c = state.cades?.[forestUnitId];
    if (!c) {
      return res.status(404).json({
        error: "Controfirma CAdES non trovata. Carica prima il .p7m con /api/ricardian/cades/upload"
      });
    }

    const rawEstimate = await estimateRegisterCountersignatureInternal({
      forestUnitId,
      pdfHash: c.pdfHash,
      cadesHash: c.cadesHash,
      cadesUri: c.cadesUri,
      signerCommonName: c.signerCommonName,
      signerSerialNumber: c.signerSerialNumber,
      signedAt: c.signedAt,
      validOffchain: c.validOffchain
    });

    return res.json(normalizeEstimateWithEur(rawEstimate));
  } catch (err) {
    return res.status(500).json({
      error: "Estimate countersignature gas failed",
      details: err.message
    });
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
    const signer = await contract.runner;
    const signerAddress = await signer.getAddress();
    const balance = await signer.provider.getBalance(signerAddress);

    const gas = await contract.registerRicardianForest.estimateGas(
      forestUnitId, ricardianHash, merkleRoot, storageUri
    );
    const feeData = await signer.provider.getFeeData();

    const price = feeData.maxFeePerGas ?? feeData.gasPrice;
    const estimatedCost = gas * price;

    if (balance < estimatedCost) {
      return res.status(400).json({
        error: "Insufficient funds",
        signerAddress,
        balanceWei: balance.toString(),
        estimatedCostWei: estimatedCost.toString(),
        note: "Ricarica ETH su questa rete (es. Sepolia) oppure usa un signer con fondi."
      });
    }

    const tx = await contract.registerRicardianForest(forestUnitId, ricardianHash, merkleRoot, storageUri);
    const receipt = await tx.wait();

    res.json({
      txHash: receipt.transactionHash || tx.hash,
      blockNumber: receipt.blockNumber,
      signerAddress
    });
  } catch (err) {
    res.status(500).json({
      error: "Register on-chain failed",
      details: err.message,
      short: err.shortMessage,
      code: err.code
    });
  }
});

// --------------------
// 7.5) Register countersignature on-chain
// --------------------
app.post("/api/chain/registerUserCountersignature", async (req, res) => {
  try {
    const forestUnitId = req.body?.forestUnitId;
    if (!forestUnitId) return res.status(400).json({ error: "forestUnitId richiesto" });

    const c = state.cades?.[forestUnitId];
    if (!c) {
      return res.status(404).json({
        error: "Controfirma CAdES non trovata. Carica prima il .p7m con /api/ricardian/cades/upload"
      });
    }

    if (c.validOffchain !== true) {
      return res.status(400).json({
        error: "Registrazione controfirma rifiutata: contenuto .p7m non coerente con il PDF registrato"
      });
    }

    if (c.trustedSignature !== true) {
      return res.status(400).json({
        error: "Registrazione controfirma rifiutata: firma non trusted"
      });
    }

    const onchain = await registerCountersignatureOnChainInternal({
      forestUnitId,
      pdfHash: c.pdfHash,
      cadesHash: c.cadesHash,
      cadesUri: c.cadesUri,
      signerCommonName: c.signerCommonName,
      signerSerialNumber: c.signerSerialNumber,
      signedAt: c.signedAt,
      validOffchain: c.validOffchain
    });

    state.writes[forestUnitId] = {
      ...(state.writes[forestUnitId] || {}),
      cadesHash: c.cadesHash,
      cadesUri: c.cadesUri,
      pdfHash: c.pdfHash,
      countersignatureTxHash: onchain.txHash,
      countersignatureBlockNumber: onchain.blockNumber
    };

    return res.json({
      ok: true,
      forestUnitId,
      countersignature: {
        pdfHash: c.pdfHash,
        cadesHash: c.cadesHash,
        cadesUri: c.cadesUri,
        signerCommonName: c.signerCommonName,
        signerSerialNumber: c.signerSerialNumber,
        signedAt: c.signedAt,
        validOffchain: c.validOffchain
      },
      onchain
    });
  } catch (err) {
    return res.status(500).json({
      error: "Register user countersignature failed",
      details: err.message,
      meta: err.meta
    });
  }
});

// --------------------
// 8) Verify LOCAL Ricardian JSON hash == expected
// --------------------
app.post("/api/ricardian/verifyLocalHashByForestUnit", async (req, res) => {
  const { forestUnitId, expectedRicardianHash } = req.body || {};
  if (!forestUnitId || !expectedRicardianHash) {
    return res.status(400).json({ error: "forestUnitId e expectedRicardianHash richiesti" });
  }

  try {
    const r = state.ricardians?.[forestUnitId];
    const ricardianJsonPath = r?.jsonPath;

    if (!ricardianJsonPath || !fs.existsSync(ricardianJsonPath)) {
      return res.status(404).json({ error: "File non trovato", forestUnitId, ricardianJsonPath });
    }

    const fileContent = fs.readFileSync(ricardianJsonPath, "utf-8");
    const json = JSON.parse(fileContent);

    const base = JSON.parse(JSON.stringify(json));
    delete base.signature;
    delete base.ipfsUri;
    delete base.ricardianHash;

    const fetchedBaseHash = toKeccak256Json(base);
    const ok = fetchedBaseHash.toLowerCase() === expectedRicardianHash.toLowerCase();

    return res.json({ ok, fetchedBaseHash, expectedRicardianHash, forestUnitId, ricardianJsonPath });
  } catch (err) {
    return res.status(500).json({ error: "Verify LOCAL hash failed", details: err.message });
  }
});

// --------------------
// 9) Verify Merkle proofs
// --------------------
app.post("/api/forest-units/verifyMerkleProofs", async (req, res) => {
  const { forestUnitId } = req.body || {};
  if (!forestUnitId) return res.status(400).json({ error: "forestUnitId richiesto" });

  try {
    const cached = state.batches[forestUnitId];
    if (!cached) {
      return res.status(404).json({ error: "Batch non trovato: chiama buildUnifiedBatch prima" });
    }

    const { leaves, merkleTree } = cached;

    const onchainRic = await contract.forestRicardians(forestUnitId);
    const onchainRoot = onchainRic.merkleRoot;

    const localRoot = merkleTree.getHexRoot();
    const rootMatches = localRoot.toLowerCase() === onchainRoot.toLowerCase();

    let validCount = 0;
    let invalidCount = 0;

    for (let i = 0; i < leaves.length; i++) {
      const leaf = leaves[i];
      const proof = merkleTree.getProof(leaf).map(x => "0x" + x.data.toString("hex"));
      const leafHex = "0x" + leaf.toString("hex");

      const isValid = await contract.verifyUnifiedProofWithRoot(leafHex, proof, onchainRoot);

      if (isValid) validCount++;
      else invalidCount++;
    }

    return res.json({
      forestUnitId,
      total: leaves.length,
      valid: validCount,
      invalid: invalidCount,
      onchainRoot,
      localRoot,
      rootMatches,
      note: "Verifica eseguita via eth_call su verifyUnifiedProofWithRoot usando la root letta dal contratto (forestRicardians[forestUnitId].merkleRoot)."
    });
  } catch (err) {
    return res.status(500).json({ error: "Verify proofs failed", details: err.message });
  }
});

// --------------------
// 10) VIEW / DOWNLOAD Ricardian PDF
// --------------------
function getPdfPathByForestUnitId(forestUnitId) {
  const r = state.ricardians?.[forestUnitId];
  if (!r?.pdfPath) return null;

  const pdfPath = path.resolve(r.pdfPath);
  if (!fs.existsSync(pdfPath)) return null;

  return pdfPath;
}

app.get("/api/ricardian/pdf/:forestUnitId/view", (req, res) => {
  try {
    const { forestUnitId } = req.params;
    const pdfPath = getPdfPathByForestUnitId(forestUnitId);

    if (!pdfPath) {
      return res.status(404).json({
        error: "PDF non trovato per questa forestUnitId. Genera prima con /api/ricardian/buildAndSign",
        forestUnitId
      });
    }

    return res.sendFile(pdfPath, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="ricardian-${forestUnitId}.pdf"`
      }
    });
  } catch (err) {
    return res.status(500).json({ error: "Errore lettura PDF", details: err.message });
  }
});

app.get("/api/ricardian/pdf/:forestUnitId/download", (req, res) => {
  try {
    const { forestUnitId } = req.params;
    const pdfPath = getPdfPathByForestUnitId(forestUnitId);

    if (!pdfPath) {
      return res.status(404).json({
        error: "PDF non trovato per questa forestUnitId. Genera prima con /api/ricardian/buildAndSign",
        forestUnitId
      });
    }

    return res.download(pdfPath, `ricardian-${forestUnitId}.pdf`);
  } catch (err) {
    return res.status(500).json({ error: "Errore download PDF", details: err.message });
  }
});

// --------------------
// 10.5) UPLOAD CAdES .p7m
// form-data:
// - forestUnitId
// - file => .p7m
// - useIPFS => true/false (optional)
// --------------------
app.post("/api/ricardian/cades/upload", upload.single("file"), async (req, res) => {
  let uploadedTempPath = req.file?.path || null;

  try {
    const forestUnitId = req.body?.forestUnitId;
    const useIPFS = String(req.body?.useIPFS || "false").toLowerCase() === "true";

    if (!forestUnitId) {
      if (uploadedTempPath && fs.existsSync(uploadedTempPath)) fs.unlinkSync(uploadedTempPath);
      return res.status(400).json({ error: "forestUnitId richiesto" });
    }

    if (!req.file) {
      return res.status(400).json({ error: "File .p7m richiesto nel campo form-data 'file'" });
    }

    const baseline = ensurePdfBaselineIntegrity(forestUnitId);
    const originalPdfPath = baseline.pdfPath;
    const registeredPdfHash = baseline.registeredPdfHash;

    const safeName = String(forestUnitId).replace(/[^a-zA-Z0-9_-]/g, "_");
    const finalP7mPath = path.join(CADES_DIR, `ricardian-${safeName}.pdf.p7m`);
    const extractedPdfPath = path.join(CADES_DIR, `ricardian-${safeName}.extracted-from-p7m.pdf`);

    console.log("[CADES] pre-rename uploadedTempPath:", uploadedTempPath);
    console.log("[CADES] pre-rename finalP7mPath:", finalP7mPath);
    console.log("[CADES] pre-rename CADES_DIR:", CADES_DIR);
    console.log("[CADES] pre-rename TMP_DIR:", TMP_DIR);

    try {
      fs.copyFileSync(uploadedTempPath, finalP7mPath);
      try { fs.unlinkSync(uploadedTempPath); } catch {}
    } catch (e) {
      console.error("[CADES] copy FAILED:", e.code, e.message, "src=", uploadedTempPath, "srcExists=", fs.existsSync(uploadedTempPath), "dstDir=", CADES_DIR, "dstDirExists=", fs.existsSync(CADES_DIR));
      throw e;
    }
    uploadedTempPath = null;

    const probe = (label) => {
      const exists = fs.existsSync(finalP7mPath);
      const size = exists ? fs.statSync(finalP7mPath).size : -1;
      console.log(`[CADES PROBE ${label}] exists=${exists} size=${size} path=${finalP7mPath}`);
      if (!exists) {
        try {
          console.log(`[CADES PROBE ${label}] CADES_DIR contents:`, fs.readdirSync(CADES_DIR));
        } catch (e) {
          console.log(`[CADES PROBE ${label}] cannot read CADES_DIR: ${e.message}`);
        }
      }
    };

    probe("post-rename");

    const verifyResult = await verifyAndExtractCadesAttachedPdf(finalP7mPath, extractedPdfPath);
    probe("post-verifyAndExtract");

    if (!verifyResult.ok) {
      try { if (fs.existsSync(finalP7mPath)) fs.unlinkSync(finalP7mPath); } catch {}
      try { if (fs.existsSync(extractedPdfPath)) fs.unlinkSync(extractedPdfPath); } catch {}

      return res.status(400).json({
        ok: false,
        error: "Verifica CAdES fallita",
        details: verifyResult.error
      });
    }

    if (!fs.existsSync(extractedPdfPath)) {
      try { if (fs.existsSync(finalP7mPath)) fs.unlinkSync(finalP7mPath); } catch {}

      return res.status(400).json({
        ok: false,
        error: "OpenSSL non ha estratto il PDF dal .p7m"
      });
    }

    const currentLocalPdfHash = sha256FileBytes32(originalPdfPath);
    probe("post-sha-originalPdf");

    const extractedPdfHash = sha256FileBytes32(extractedPdfPath);
    probe("post-sha-extractedPdf");

    const cadesHash = sha256FileBytes32(finalP7mPath);
    probe("post-sha-cades");

    const localPdfStillMatchesBaseline =
      currentLocalPdfHash.toLowerCase() === String(registeredPdfHash).toLowerCase();

    if (!localPdfStillMatchesBaseline) {
      try { if (fs.existsSync(finalP7mPath)) fs.unlinkSync(finalP7mPath); } catch {}
      try { if (fs.existsSync(extractedPdfPath)) fs.unlinkSync(extractedPdfPath); } catch {}

      return res.status(409).json({
        ok: false,
        error: "Il PDF locale è stato alterato rispetto alla baseline registrata",
        forestUnitId,
        hashes: {
          registeredPdfHash,
          currentLocalPdfHash,
          extractedPdfHash,
          cadesHash
        }
      });
    }

    const validOffchain =
      extractedPdfHash.toLowerCase() === String(registeredPdfHash).toLowerCase();

    if (!validOffchain) {
      try { if (fs.existsSync(finalP7mPath)) fs.unlinkSync(finalP7mPath); } catch {}
      try { if (fs.existsSync(extractedPdfPath)) fs.unlinkSync(extractedPdfPath); } catch {}

      return res.status(400).json({
        ok: false,
        error: "Il PDF estratto dal .p7m non coincide con il PDF registrato",
        forestUnitId,
        hashes: {
          registeredPdfHash,
          currentLocalPdfHash,
          extractedPdfHash,
          cadesHash
        }
      });
    }

    const certInfo = await extractCertificateInfoFromP7m(finalP7mPath);

    const caFilePath =
    process.env.CADES_CA_FILE ||
    path.resolve(__dirname, "../certs/trusted-ca.pem");

    const trustResult = await verifyCadesSignatureTrustHybrid(finalP7mPath, caFilePath);

    // ----------------------------------------------------------------
    // VALIDAZIONE DSS (EU LOTL) — sostituisce/integra il check OpenSSL
    // ----------------------------------------------------------------
    let dssResult = null;
    let dssReportPath = null;

    try {
      dssResult = await validateCades(finalP7mPath);

      if (dssResult.ok) {
        // Persisti il report DSS come evidenza (Blocco 5.4)
        const reportFileName = `validation-${safeName}-${Date.now()}.json`;
        dssReportPath = path.join(CADES_DIR, reportFileName);
        fs.writeFileSync(dssReportPath, JSON.stringify(dssResult.rawReport, null, 2));
        console.log(`[DSS] Validation report salvato: ${reportFileName}`);
        console.log(`[DSS] Indication: ${dssResult.indication}, Level: ${dssResult.signatureLevel}`);
      } else {
        console.warn(`[DSS] Validazione fallita: ${dssResult.error}`);
      }
    } catch (e) {
      console.warn(`[DSS] Eccezione nella validazione: ${e.message}`);
      dssResult = { ok: false, error: e.message };
    }

    let cadesUri = toFileUri(finalP7mPath);
    let ipfs = null;

    if (useIPFS) {
      ipfs = await uploadFileToIpfs(finalP7mPath, `ricardian-${safeName}.pdf.p7m`);
      cadesUri = ipfs.ipfsUri;
    }

    const signedAt = Math.floor(Date.now() / 1000);

    state.cades[forestUnitId] = {
      forestUnitId,
      pdfPath: originalPdfPath,
      p7mPath: finalP7mPath,
      extractedPdfPath,
      pdfHash: registeredPdfHash,
      localPdfHash: currentLocalPdfHash,
      extractedPdfHash,
      cadesHash,
      cadesUri,
      signerCommonName: certInfo.signerCommonName || "",
      signerSerialNumber: certInfo.signerSerialNumber || "",
      signerSubject: certInfo.rawSubject || "",
      signerOrganization: certInfo.organization || "",
      signerCountry: certInfo.country || "",
      issuer: certInfo.issuer || "",
      validFrom: certInfo.validFrom || "",
      validTo: certInfo.validTo || "",
      signatureAlgorithm: certInfo.signatureAlgorithm || "",
      keyUsage: certInfo.keyUsage || "",
      extendedKeyUsage: certInfo.extendedKeyUsage || "",
      policy: certInfo.policy || "",
      signedAt,
      validOffchain,
      ipfsUri: ipfs?.ipfsUri || null,
      cid: ipfs?.cid || null,
      uploadedAt: new Date().toISOString(),
      trustedSignature: trustResult.trusted,
      trustDetails: trustResult.ok ? trustResult.details : trustResult.error,
      caFilePath,
      trustProvider: trustResult.provider || null,
      // DSS — validazione EU LOTL
      dssOk: dssResult?.ok || false,
      dssIndication: dssResult?.indication || null,           // TOTAL_PASSED | TOTAL_FAILED | INDETERMINATE
      dssSubIndication: dssResult?.subIndication || null,
      dssSignatureLevel: dssResult?.signatureLevel || null,   // QESig | AdESig-QC | AdESig | NA
      dssSignatureFormat: dssResult?.signatureFormat || null, // CAdES-BASELINE-B/T/LT/LTA
      dssIsQualified: dssResult?.isQualified || false,
      dssIsAdvancedWithQc: dssResult?.isAdvancedWithQc || false,
      dssQcCompliance: dssResult?.qcCompliance || false,
      dssQcSSCD: dssResult?.qcSSCD || false,
      dssHasTimestamp: dssResult?.hasTimestamp || false,
      dssReportPath: dssReportPath,
      dssReportFileName: dssReportPath ? path.basename(dssReportPath) : null,
    };

    // ----------------------------------------------------------------
    // Aggiorna il ricardiano runtime con il livello di firma DSS (Blocco 5.5)
    // Soddisfa il campo legal.documentSignature.userCountersignature.legalQualification
    // del Ricardian v3.0
    // ----------------------------------------------------------------
    const r = state.ricardians?.[forestUnitId];
    if (r?.ricardianForest?.legal?.documentSignature?.userCountersignature) {
      const userSig = r.ricardianForest.legal.documentSignature.userCountersignature;

      if (dssResult?.ok) {
        userSig.legalQualification = dssResult.signatureLevel;
        userSig.validationReportRef = dssReportPath ? path.basename(dssReportPath) : null;
        userSig.validationIndication = dssResult.indication;
        userSig.signatureFormat = dssResult.signatureFormat;
        userSig.qcCompliance = dssResult.qcCompliance;
        userSig.qcSSCD = dssResult.qcSSCD;
        userSig.hasTimestamp = dssResult.hasTimestamp;
      } else {
        userSig.legalQualification = "VALIDATION_FAILED";
        userSig.validationError = dssResult?.error || "Validazione DSS non disponibile";
      }

      // Riscrivi il ricardiano JSON aggiornato (utile per audit successivi)
      try {
        const ricardianJsonPath = path.join(RICARDIAN_DIR, `ricardian-${safeName}.json`);
        fs.writeFileSync(ricardianJsonPath, JSON.stringify(r.ricardianForest, null, 2));
      } catch (e) {
        console.warn(`[DSS] Impossibile riscrivere il ricardiano JSON: ${e.message}`);
      }
    }

    return res.json({
      ok: true,
      forestUnitId,
      validOffchain,
      trustProvider: trustResult.provider || null,
      trustedSignature: trustResult.trusted,
      trustDetails: trustResult.ok ? trustResult.details : trustResult.error,
      signerExtractionError: certInfo.error || null,
      files: {
        originalPdfPath,
        p7mPath: finalP7mPath,
        extractedPdfPath
      },
      hashes: {
        registeredPdfHash,
        currentLocalPdfHash,
        extractedPdfHash,
        cadesHash
      },
      signer: {
        commonName: certInfo.signerCommonName,
        serialNumber: certInfo.signerSerialNumber,
        providerName: certInfo.providerName,
        organization: certInfo.organization,
        country: certInfo.country,
        issuer: certInfo.issuer,
        validFrom: certInfo.validFrom,
        validTo: certInfo.validTo,
        signatureAlgorithm: certInfo.signatureAlgorithm,
        keyUsage: certInfo.keyUsage,
        extendedKeyUsage: certInfo.extendedKeyUsage,
        policy: certInfo.policy,
        subject: certInfo.rawSubject
      },
      storage: {
        cadesUri,
        ipfsUri: ipfs?.ipfsUri || null,
        cid: ipfs?.cid || null
      },
      // DSS validation (Blocco 5.4 / 5.5)
      dss: dssResult?.ok ? {
        indication: dssResult.indication,
        subIndication: dssResult.subIndication,
        signatureLevel: dssResult.signatureLevel,
        signatureFormat: dssResult.signatureFormat,
        isQualified: dssResult.isQualified,
        qcCompliance: dssResult.qcCompliance,
        qcSSCD: dssResult.qcSSCD,
        hasTimestamp: dssResult.hasTimestamp,
        reportFileName: dssReportPath ? path.basename(dssReportPath) : null
      } : {
        ok: false,
        error: dssResult?.error || "DSS validation non disponibile"
      },
      note: "Il PDF estratto dal .p7m coincide con il PDF registrato in baseline."
    });
  } catch (err) {
    if (uploadedTempPath && fs.existsSync(uploadedTempPath)) {
      try { fs.unlinkSync(uploadedTempPath); } catch {}
    }

    return res.status(500).json({
      ok: false,
      error: "Upload CAdES failed",
      details: err.message,
      meta: err.meta || null
    });
  }
});

// ----------------------------------------------------------------
// UPLOAD CONTROFIRMA CLIENTE (.p7m.p7m — firma annidata sopra il p7m)
// ----------------------------------------------------------------
app.post("/api/ricardian/cades/client-upload", upload.single("file"), async (req, res) => {
  let uploadedTempPath = req.file?.path || null;

  try {
    const forestUnitId = req.body?.forestUnitId;
    const useIPFS = String(req.body?.useIPFS || "false").toLowerCase() === "true";

    if (!forestUnitId) {
      if (uploadedTempPath && fs.existsSync(uploadedTempPath)) fs.unlinkSync(uploadedTempPath);
      return res.status(400).json({ error: "forestUnitId richiesto" });
    }

    if (!req.file) {
      return res.status(400).json({ error: "File .p7m.p7m richiesto nel campo form-data 'file'" });
    }

    // Prerequisito: la firma del firmatario deve esistere off-chain (caricata
    // con /api/ricardian/cades/upload) per poter verificare l'annidamento.
    const inner = state.cades?.[forestUnitId];
    if (!inner) {
      if (uploadedTempPath && fs.existsSync(uploadedTempPath)) fs.unlinkSync(uploadedTempPath);
      return res.status(404).json({
        error: "Firma del firmatario non trovata. Carica prima il .p7m con /api/ricardian/cades/upload"
      });
    }

    const baseline = ensurePdfBaselineIntegrity(forestUnitId);
    const registeredPdfHash = baseline.registeredPdfHash;

    const safeName = String(forestUnitId).replace(/[^a-zA-Z0-9_-]/g, "_");
    const finalClientP7mPath = path.join(CADES_DIR, `ricardian-${safeName}.pdf.p7m.p7m`);
    const innerP7mPath = path.join(CADES_DIR, `ricardian-${safeName}.client-inner.pdf.p7m`);
    const extractedPdfPath = path.join(CADES_DIR, `ricardian-${safeName}.client-extracted.pdf`);

    try {
      fs.copyFileSync(uploadedTempPath, finalClientP7mPath);
      try { fs.unlinkSync(uploadedTempPath); } catch {}
    } catch (e) {
      console.error("[CADES] client copy FAILED:", e.code, e.message, "src=", uploadedTempPath, "srcExists=", fs.existsSync(uploadedTempPath), "dstDir=", CADES_DIR, "dstDirExists=", fs.existsSync(CADES_DIR));
      throw e;
    }
    uploadedTempPath = null;

    const cleanup = () => {
      for (const p of [finalClientP7mPath, innerP7mPath, extractedPdfPath]) {
        try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
      }
    };

    // Doppia estrazione + validazione DSS della firma esterna (cliente)
    const verifyResult = await verifyAndExtractClientCountersignature(
      finalClientP7mPath,
      innerP7mPath,
      extractedPdfPath
    );

    if (!verifyResult.ok) {
      cleanup();
      return res.status(400).json({
        ok: false,
        error: "Verifica controfirma cliente fallita",
        details: verifyResult.error,
        sub: verifyResult.details || null
      });
    }

    if (!fs.existsSync(extractedPdfPath)) {
      cleanup();
      return res.status(400).json({ ok: false, error: "PDF non estratto dal .p7m.p7m" });
    }

    // 1) Il p7m interno estratto deve coincidere con il p7m del firmatario gia' registrato
    const extractedInnerHash = sha256FileBytes32(innerP7mPath);
    const innerMatches =
      extractedInnerHash.toLowerCase() === String(inner.cadesHash).toLowerCase();

    if (!innerMatches) {
      cleanup();
      return res.status(409).json({
        ok: false,
        error: "Il p7m interno non coincide con la firma del firmatario registrata",
        forestUnitId,
        hashes: {
          expectedInnerCadesHash: inner.cadesHash,
          extractedInnerCadesHash: extractedInnerHash
        }
      });
    }

    // 2) Il PDF finale deve coincidere con la baseline
    const extractedPdfHash = sha256FileBytes32(extractedPdfPath);
    const pdfMatches =
      extractedPdfHash.toLowerCase() === String(registeredPdfHash).toLowerCase();

    if (!pdfMatches) {
      cleanup();
      return res.status(409).json({
        ok: false,
        error: "Il PDF annidato non coincide con la baseline registrata",
        forestUnitId,
        hashes: { registeredPdfHash, extractedPdfHash }
      });
    }

    const clientCadesHash = sha256FileBytes32(finalClientP7mPath);

    // Info certificato della firma esterna (cliente)
    const certInfo = await extractCertificateInfoFromP7m(finalClientP7mPath);

    const caFilePath =
      process.env.CADES_CA_FILE ||
      path.resolve(__dirname, "../certs/trusted-ca.pem");
    const trustResult = await verifyCadesSignatureTrustHybrid(finalClientP7mPath, caFilePath);

    // DSS report come evidenza
    let dssReportPath = null;
    if (verifyResult.rawReport) {
      try {
        const reportFileName = `validation-client-${safeName}-${Date.now()}.json`;
        dssReportPath = path.join(CADES_DIR, reportFileName);
        fs.writeFileSync(dssReportPath, JSON.stringify(verifyResult.rawReport, null, 2));
      } catch (e) {
        console.warn(`[DSS] Impossibile salvare report client: ${e.message}`);
      }
    }

    let clientCadesUri = toFileUri(finalClientP7mPath);
    let ipfs = null;
    if (useIPFS) {
      ipfs = await uploadFileToIpfs(finalClientP7mPath, `ricardian-${safeName}.pdf.p7m.p7m`);
      clientCadesUri = ipfs.ipfsUri;
    }

    const signedAt = Math.floor(Date.now() / 1000);

    state.clientCades[forestUnitId] = {
      forestUnitId,
      clientP7mPath: finalClientP7mPath,
      innerP7mPath,
      extractedPdfPath,
      innerCadesHash: inner.cadesHash,
      clientCadesHash,
      clientCadesUri,
      pdfHash: registeredPdfHash,
      extractedPdfHash,
      signerCommonName: certInfo.signerCommonName || "",
      signerSerialNumber: certInfo.signerSerialNumber || "",
      signerOrganization: certInfo.organization || "",
      signerCountry: certInfo.country || "",
      issuer: certInfo.issuer || "",
      validFrom: certInfo.validFrom || "",
      validTo: certInfo.validTo || "",
      signedAt,
      validOffchain: verifyResult.validOffchain,
      trustedSignature: trustResult.trusted,
      trustProvider: trustResult.provider || null,
      ipfsUri: ipfs?.ipfsUri || null,
      cid: ipfs?.cid || null,
      uploadedAt: new Date().toISOString(),
      dssOk: verifyResult.indication === "TOTAL_PASSED",
      dssIndication: verifyResult.indication || null,
      dssSubIndication: verifyResult.subIndication || null,
      dssSignatureLevel: verifyResult.signatureLevel || null,
      dssSignatureFormat: verifyResult.signatureFormat || null,
      dssHasTimestamp: verifyResult.hasTimestamp || false,
      dssReportPath,
      dssReportFileName: dssReportPath ? path.basename(dssReportPath) : null
    };

    return res.json({
      ok: true,
      forestUnitId,
      validOffchain: verifyResult.validOffchain,
      trustedSignature: trustResult.trusted,
      trustProvider: trustResult.provider || null,
      files: {
        clientP7mPath: finalClientP7mPath,
        innerP7mPath,
        extractedPdfPath
      },
      hashes: {
        registeredPdfHash,
        extractedPdfHash,
        innerCadesHash: inner.cadesHash,
        extractedInnerCadesHash: extractedInnerHash,
        clientCadesHash
      },
      signer: {
        commonName: certInfo.signerCommonName,
        serialNumber: certInfo.signerSerialNumber,
        organization: certInfo.organization,
        country: certInfo.country,
        issuer: certInfo.issuer,
        validFrom: certInfo.validFrom,
        validTo: certInfo.validTo
      },
      storage: {
        clientCadesUri,
        ipfsUri: ipfs?.ipfsUri || null,
        cid: ipfs?.cid || null
      },
      dss: {
        indication: verifyResult.indication,
        subIndication: verifyResult.subIndication,
        signatureLevel: verifyResult.signatureLevel,
        signatureFormat: verifyResult.signatureFormat,
        hasTimestamp: verifyResult.hasTimestamp,
        reportFileName: dssReportPath ? path.basename(dssReportPath) : null
      },
      note: "Controfirma cliente verificata: p7m interno e PDF annidato coincidono con i record registrati."
    });
  } catch (err) {
    if (uploadedTempPath && fs.existsSync(uploadedTempPath)) {
      try { fs.unlinkSync(uploadedTempPath); } catch {}
    }
    return res.status(500).json({
      ok: false,
      error: "Upload controfirma cliente failed",
      details: err.message,
      meta: err.meta || null
    });
  }
});

// --------------------
// OFFICIAL #1: WRITE CONTRACT ON-CHAIN
// --------------------
app.post("/api/contract/write", async (req, res) => {
  try {
    const useIPFS = !!req.body?.useIPFS;

    // ----------------------------------------------------------------
    // Validazione subscriber (art. 8-ter c.2 L. 12/2019)
    // ----------------------------------------------------------------
    const subscriber = req.body?.subscriber;
    if (!subscriber || typeof subscriber !== "object") {
      return res.status(400).json({
        ok: false,
        error: "subscriber mancante (art. 8-ter c.2 L. 12/2019)",
        hint: "Inviare nel body: { forestUnitId, subscriber: { legalEntity, identifier, method }, useIPFS }",
        example: {
          forestUnitId: "FU-2024-001",
          subscriber: {
            legalEntity: "Azienda Forestale Verdi SRL",
            identifier: "IT12345678901",
            method: "contractual"
          },
          useIPFS: false
        }
      });
    }
    if (!subscriber.legalEntity) {
      return res.status(400).json({
        ok: false,
        error: "subscriber.legalEntity obbligatorio (ragione sociale o nome del Sottoscrittore)"
      });
    }
    if (!subscriber.identifier) {
      return res.status(400).json({
        ok: false,
        error: "subscriber.identifier obbligatorio (P.IVA per persona giuridica, CF per persona fisica)"
      });
    }
    if (!subscriber.method) {
      // default ragionevole se non specificato
      subscriber.method = "contractual";
    }
    const VALID_METHODS = ["contractual", "SPID-L2", "SPID-L3", "CIE", "EUDIWallet"];
    if (!VALID_METHODS.includes(subscriber.method)) {
      return res.status(400).json({
        ok: false,
        error: `subscriber.method non valido: "${subscriber.method}"`,
        allowed: VALID_METHODS
      });
    }

    const login = await topviewEnsureLogin(
      process.env.TOPVIEW_USERNAME,
      process.env.TOPVIEW_PASSWORD
    );

    let forestUnitId = req.body?.forestUnitId;
    let imported;

    if (forestUnitId) {
      imported = await topviewImportForestUnitById(forestUnitId);
    } else {
      imported = await topviewImportLatest();
      forestUnitId = imported.forestUnitId;
    }

    const forestData = imported.unit;

    const batch = await buildUnifiedBatchInternal(forestUnitId, forestData);

    const ric = await buildAndSignRicardianInternal(
      forestUnitId,
      batch.merkleRoot,
      useIPFS ? "IPFS" : "LOCAL_FILE",
      subscriber
    );

    let storage;
    if (useIPFS) {
      storage = await uploadRicardianToIpfsInternal(forestUnitId);
    } else {
      const baseUrl = getBaseUrl(req);
      storage = await persistRicardianLocalInternal(forestUnitId, baseUrl);
    }

    const rawEstimate = await estimateRegisterInternal({
      forestUnitId,
      ricardianHash: ric.ricardianHash,
      merkleRoot: batch.merkleRoot,
      storageUri: storage.storageUri
    });

    const estimate = normalizeEstimateWithEur(rawEstimate);

    const onchain = await registerOnChainInternal({
      forestUnitId,
      ricardianHash: ric.ricardianHash,
      merkleRoot: batch.merkleRoot,
      storageUri: storage.storageUri
    });

    state.writes[forestUnitId] = {
      forestUnitId,
      merkleRoot: batch.merkleRoot,
      ricardianHash: ric.ricardianHash,
      ricardianUri: storage.storageUri,
      pdfHash: state.ricardians?.[forestUnitId]?.pdfHash || null,
      pdfUri: storage.pdfUri || null,
      ipfsUri: storage.ipfsUri || null,
      cid: storage.cid || null,
      txHash: onchain.txHash,
      blockNumber: onchain.blockNumber,
      createdAt: new Date().toISOString(),
      mode: "RICARDIAN_ONLY"
    };

    return res.json({
      ok: true,
      mode: "RICARDIAN_ONLY",
      forestUnitId,
      login,
      merkleRoot: batch.merkleRoot,
      ricardianHash: ric.ricardianHash,
      ricardianUri: storage.storageUri,
      pdfUri: storage.pdfUri || null,
      ipfsUri: storage.ipfsUri || null,
      cid: storage.cid || null,
      estimate,
      onchain
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "WRITE failed",
      details: err.message,
      meta: err.meta
    });
  }
});

// --------------------
// OFFICIAL #1.5: WRITE PDF ONLY ON-CHAIN
// --------------------
app.post("/api/contract/write-1.5-pdf", async (req, res) => {
  try {
    const login = await topviewEnsureLogin(
      process.env.TOPVIEW_USERNAME,
      process.env.TOPVIEW_PASSWORD
    );

    let forestUnitId = req.body?.forestUnitId;

    if (!forestUnitId) {
      const imported = await topviewImportLatest();
      forestUnitId = imported.forestUnitId;
    }

    const existingRic = state.ricardians?.[forestUnitId];
    const existingWrite = state.writes?.[forestUnitId];
    const existingBatch = state.batches?.[forestUnitId];

    if (!existingRic?.ricardianHash || !existingBatch?.root) {
      return res.status(400).json({
        ok: false,
        error: "Ricardian non disponibile. Esegui prima /api/contract/write"
      });
    }

    const onchainRic = await contract.forestRicardians(forestUnitId);

    const onchainHash =
      onchainRic.ricardianHash ||
      onchainRic.hash ||
      onchainRic[0];

    const onchainRoot =
      onchainRic.merkleRoot ||
      onchainRic.root ||
      onchainRic[1];

    const onchainRicardianUri =
      onchainRic.ricardianUri ||
      onchainRic[2] ||
      "";

    const onchainPdfUri =
      onchainRic.pdfUri ||
      onchainRic[3] ||
      "";

    // console.log("[WRITE 1.5 PDF] forestUnitId:", forestUnitId);
    // console.log("[WRITE 1.5 PDF] onchainRic:", onchainRic);

    if (!onchainHash || String(onchainHash) === ethers.ZeroHash) {
      return res.status(400).json({
        ok: false,
        error: "Ricardian NON registrato on-chain. Devi fare prima /api/contract/write",
        forestUnitId
      });
    }

    const baseUrl = getBaseUrl(req);
    const pdfViewUrl = `${baseUrl}/api/ricardian/pdf/${encodeURIComponent(forestUnitId)}/view`;
    const pdfDownloadUrl = `${baseUrl}/api/ricardian/pdf/${encodeURIComponent(forestUnitId)}/download`;

    // Se il PDF URI è già presente on-chain, evita una nuova tx che potrebbe revertare
    if (String(onchainPdfUri).trim().length > 0) {
      const sameUri = String(onchainPdfUri) === String(pdfDownloadUrl);

      if (state.ricardians?.[forestUnitId]) {
        state.ricardians[forestUnitId].pdfUri = onchainPdfUri;
      }

      state.writes[forestUnitId] = {
        ...(existingWrite || {}),
        forestUnitId,
        merkleRoot: existingBatch.root,
        ricardianHash: existingRic.ricardianHash,
        ricardianUri: existingWrite?.ricardianUri || existingRic.storageUri || onchainRicardianUri || null,
        pdfUri: onchainPdfUri,
        createdAt: new Date().toISOString(),
        mode: sameUri ? "PDF_ALREADY_REGISTERED_SAME_URI" : "PDF_ALREADY_REGISTERED_DIFFERENT_URI"
      };

      return res.json({
        ok: true,
        mode: sameUri ? "PDF_ALREADY_REGISTERED_SAME_URI" : "PDF_ALREADY_REGISTERED_DIFFERENT_URI",
        forestUnitId,
        login,
        merkleRoot: onchainRoot || existingBatch.root,
        ricardianHash: onchainHash,
        ricardianUri: onchainRicardianUri || existingWrite?.ricardianUri || existingRic.storageUri || null,
        pdfUri: onchainPdfUri,
        pdf: {
          viewUrl: pdfViewUrl,
          downloadUrl: pdfDownloadUrl
        },
        note: sameUri
          ? "Il pdfUri era già registrato on-chain con lo stesso valore, quindi non è stata inviata una nuova transazione."
          : "Esiste già un pdfUri on-chain diverso da quello richiesto, quindi non è stata inviata una nuova transazione."
      });
    }

    const rawEstimate = await estimateSetPdfUriInternal({
      forestUnitId,
      pdfUri: pdfDownloadUrl
    });

    const estimate = normalizeEstimateWithEur(rawEstimate);

    const onchain = await setPdfUriOnChainInternal({
      forestUnitId,
      pdfUri: pdfDownloadUrl
    });

    if (state.ricardians?.[forestUnitId]) {
      state.ricardians[forestUnitId].pdfUri = pdfDownloadUrl;
    }

    state.writes[forestUnitId] = {
      ...(existingWrite || {}),
      forestUnitId,
      merkleRoot: existingBatch.root,
      ricardianHash: existingRic.ricardianHash,
      ricardianUri: existingWrite?.ricardianUri || existingRic.storageUri || onchainRicardianUri || null,
      pdfUri: pdfDownloadUrl,
      txHash: onchain.txHash,
      blockNumber: onchain.blockNumber,
      createdAt: new Date().toISOString(),
      mode: "PDF_ONLY"
    };

    return res.json({
      ok: true,
      mode: "PDF_ONLY",
      forestUnitId,
      login,
      merkleRoot: existingBatch.root,
      ricardianHash: existingRic.ricardianHash,
      ricardianUri: existingWrite?.ricardianUri || existingRic.storageUri || onchainRicardianUri || null,
      pdfUri: pdfDownloadUrl,
      estimate,
      onchain,
      pdf: {
        viewUrl: pdfViewUrl,
        downloadUrl: pdfDownloadUrl
      },
      note: "On-chain è stato registrato il link HTTP del PDF nel campo pdfUri."
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "WRITE 1.5 PDF failed",
      details: err.message,
      meta: err.meta
    });
  }
});

// --------------------
// OFFICIAL #2: REGISTER USER CAdES COUNTERSIGNATURE
// body:
// {
//   "forestUnitId": "Vallombrosa"
// }
// --------------------
app.post("/api/contract/write-2-cades", async (req, res) => {
  try {
    const forestUnitId = req.body?.forestUnitId;
    if (!forestUnitId) {
      return res.status(400).json({ ok: false, error: "forestUnitId richiesto" });
    }

    const c = state.cades?.[forestUnitId];
    if (!c) {
      return res.status(404).json({
        ok: false,
        error: "Controfirma CAdES non trovata. Carica prima il .p7m con /api/ricardian/cades/upload"
      });
    }
    if (c.validOffchain !== true) {
      return res.status(400).json({
        ok: false,
        error: "Registrazione controfirma rifiutata: il contenuto del .p7m non coincide con il PDF registrato"
      });
    }

    if (c.trustedSignature !== true) {
      return res.status(400).json({
        ok: false,
        error: "Registrazione controfirma rifiutata: firma non trusted"
      });
    }

    const rawEstimate = await estimateRegisterCountersignatureInternal({
      forestUnitId,
      pdfHash: c.pdfHash,
      cadesHash: c.cadesHash,
      cadesUri: c.cadesUri,
      signerCommonName: c.signerCommonName,
      signerSerialNumber: c.signerSerialNumber,
      signedAt: c.signedAt,
      validOffchain: c.validOffchain
    });

    const estimate = normalizeEstimateWithEur(rawEstimate);

    const onchain = await registerCountersignatureOnChainInternal({
      forestUnitId,
      pdfHash: c.pdfHash,
      cadesHash: c.cadesHash,
      cadesUri: c.cadesUri,
      signerCommonName: c.signerCommonName,
      signerSerialNumber: c.signerSerialNumber,
      signedAt: c.signedAt,
      validOffchain: c.validOffchain
    });

    state.writes[forestUnitId] = {
      ...(state.writes[forestUnitId] || {}),
      pdfHash: c.pdfHash,
      cadesHash: c.cadesHash,
      cadesUri: c.cadesUri,
      signerCommonName: c.signerCommonName,
      signerSerialNumber: c.signerSerialNumber,
      signedAt: c.signedAt,
      validOffchain: c.validOffchain,
      cadesTxHash: onchain.txHash,
      cadesBlockNumber: onchain.blockNumber
    };

    return res.json({
      ok: true,
      mode: "CADES_COUNTERSIGNATURE",
      forestUnitId,
      countersignature: {
        pdfHash: c.pdfHash,
        cadesHash: c.cadesHash,
        cadesUri: c.cadesUri,
        signerCommonName: c.signerCommonName,
        signerSerialNumber: c.signerSerialNumber,
        signedAt: c.signedAt,
        validOffchain: c.validOffchain
      },
      estimate,
      onchain
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "WRITE 2 CAdES failed",
      details: err.message,
      meta: err.meta
    });
  }
});

// --------------------
// OFFICIAL #2b: WRITE CONTROFIRMA CLIENTE ON-CHAIN
// --------------------
app.post("/api/contract/write-3-client-countersign", async (req, res) => {
  try {
    const forestUnitId = req.body?.forestUnitId;
    if (!forestUnitId) {
      return res.status(400).json({ ok: false, error: "forestUnitId richiesto" });
    }

    const cc = state.clientCades?.[forestUnitId];
    if (!cc) {
      return res.status(404).json({
        ok: false,
        error: "Controfirma cliente non trovata. Carica prima il .p7m.p7m con /api/ricardian/cades/client-upload"
      });
    }

    // Prerequisito on-chain: la firma del firmatario deve essere gia' registrata
    const userCounter = await contract.getUserCountersignature(forestUnitId);
    if (!userCounter[0]) {
      return res.status(409).json({
        ok: false,
        error: "Firma del firmatario non registrata on-chain. Esegui prima /api/contract/write-2-cades"
      });
    }

    if (cc.validOffchain !== true) {
      return res.status(400).json({
        ok: false,
        error: "Registrazione rifiutata: la controfirma cliente non e' valida off-chain (DSS)"
      });
    }
    if (cc.trustedSignature !== true) {
      return res.status(400).json({
        ok: false,
        error: "Registrazione rifiutata: firma cliente non trusted"
      });
    }

    const rawEstimate = await estimateRegisterClientCountersignatureInternal({
      forestUnitId,
      innerCadesHash: cc.innerCadesHash,
      clientCadesHash: cc.clientCadesHash,
      clientCadesUri: cc.clientCadesUri,
      signerCommonName: cc.signerCommonName,
      signerSerialNumber: cc.signerSerialNumber,
      signedAt: cc.signedAt,
      validOffchain: cc.validOffchain
    });
    const estimate = normalizeEstimateWithEur(rawEstimate);

    const onchain = await registerClientCountersignatureOnChainInternal({
      forestUnitId,
      innerCadesHash: cc.innerCadesHash,
      clientCadesHash: cc.clientCadesHash,
      clientCadesUri: cc.clientCadesUri,
      signerCommonName: cc.signerCommonName,
      signerSerialNumber: cc.signerSerialNumber,
      signedAt: cc.signedAt,
      validOffchain: cc.validOffchain
    });

    state.writes[forestUnitId] = {
      ...(state.writes[forestUnitId] || {}),
      clientInnerCadesHash: cc.innerCadesHash,
      clientCadesHash: cc.clientCadesHash,
      clientCadesUri: cc.clientCadesUri,
      clientSignerCommonName: cc.signerCommonName,
      clientSignerSerialNumber: cc.signerSerialNumber,
      clientSignedAt: cc.signedAt,
      clientValidOffchain: cc.validOffchain,
      clientCadesTxHash: onchain.txHash,
      clientCadesBlockNumber: onchain.blockNumber
    };

    return res.json({
      ok: true,
      mode: "CADES_CLIENT_COUNTERSIGNATURE",
      forestUnitId,
      clientCountersignature: {
        innerCadesHash: cc.innerCadesHash,
        clientCadesHash: cc.clientCadesHash,
        clientCadesUri: cc.clientCadesUri,
        signerCommonName: cc.signerCommonName,
        signerSerialNumber: cc.signerSerialNumber,
        signedAt: cc.signedAt,
        validOffchain: cc.validOffchain
      },
      estimate,
      onchain
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "WRITE 3 CLIENT COUNTERSIGN failed",
      details: err.message,
      meta: err.meta
    });
  }
});

// --------------------
// OFFICIAL #3: VERIFY
// --------------------
app.post("/api/contract/verify", async (req, res) => {
  try {
    const forestUnitId = req.body?.forestUnitId;
    if (!forestUnitId) return res.status(400).json({ error: "forestUnitId richiesto" });

    const w = state.writes?.[forestUnitId] || {};
    const r = state.ricardians?.[forestUnitId];
    const b = state.batches?.[forestUnitId];
    const c = state.cades?.[forestUnitId];
    const cc = state.clientCades?.[forestUnitId];

    const expectedRicardianHash = w.ricardianHash || r?.ricardianHash;
    const expectedMerkleRoot = w.merkleRoot || b?.root;
    const expectedRicardianUri = w.ricardianUri || r?.storageUri || null;
    const expectedPdfUri = w.pdfUri || r?.pdfUri || null;

    const expectedPdfHash =
      w.pdfHash ||
      c?.pdfHash ||
      r?.pdfHash ||
      null;

    let localCurrentPdfHash = null;
    let pdfBaselineMatches = null;
    let pdfPathUsed = r?.pdfPath || c?.pdfPath || null;

    if (pdfPathUsed && fs.existsSync(pdfPathUsed) && expectedPdfHash) {
      localCurrentPdfHash = sha256FileBytes32(pdfPathUsed);
      pdfBaselineMatches =
        String(localCurrentPdfHash).toLowerCase() ===
        String(expectedPdfHash).toLowerCase();
    }  

    if (!expectedRicardianHash) return res.status(400).json({ error: "expectedRicardianHash non disponibile (fai prima /api/contract/write)" });
    if (!expectedMerkleRoot) return res.status(400).json({ error: "expectedMerkleRoot non disponibile (fai prima /api/contract/write)" });

    const onchainRic = await contract.forestRicardians(forestUnitId);

    const onchainHash = onchainRic.ricardianHash || onchainRic.hash || onchainRic[0];
    const onchainRoot = onchainRic.merkleRoot || onchainRic.root || onchainRic[1];
    const onchainRicardianUri = onchainRic.ricardianUri || onchainRic[2];
    const onchainPdfUri = onchainRic.pdfUri || onchainRic[3];

    const hashMatches = onchainHash && (String(onchainHash).toLowerCase() === String(expectedRicardianHash).toLowerCase());
    const rootMatches = onchainRoot && (String(onchainRoot).toLowerCase() === String(expectedMerkleRoot).toLowerCase());
    const ricardianUriMatches = expectedRicardianUri
      ? String(onchainRicardianUri || "").toLowerCase() === String(expectedRicardianUri).toLowerCase()
      : true;

    const pdfUriMatches = expectedPdfUri
      ? String(onchainPdfUri || "").toLowerCase() === String(expectedPdfUri).toLowerCase()
      : true;

    const pdfHashMatches = expectedPdfHash
      ? pdfBaselineMatches === true
      : null;  

    const existsOnChain = !!onchainRoot && String(onchainRoot) !== "0x0000000000000000000000000000000000000000000000000000000000000000";

    const isIpfsMode = !!w.ipfsUri || !!r?.ipfsUri;
    const ipfsVerify = isIpfsMode
      ? await verifyIpfsHashInternal(forestUnitId, expectedRicardianHash)
      : { skipped: true, reason: "storage non IPFS" };

    const proofs = await verifyMerkleProofsInternal(forestUnitId);

    let countersignature = { skipped: true, reason: "contorfirma CAdES non disponibile" };

    try {
      const onchainCounter = await contract.getUserCountersignature(forestUnitId);
      const onchainCounterExists = onchainCounter[0];

      if (onchainCounterExists) {
        const expectedPdfHash = c?.pdfHash || w?.pdfHash || null;
        const expectedCadesHash = c?.cadesHash || w?.cadesHash || null;
        const expectedCadesUri = c?.cadesUri || w?.cadesUri || null;

        const onchainPdfHash = onchainCounter[1];
        const onchainCadesHash = onchainCounter[2];
        const onchainCadesUri = onchainCounter[3];
        const onchainSignerCommonName = onchainCounter[4];
        const onchainSignerSerialNumber = onchainCounter[5];
        const onchainSignedAt = onchainCounter[6];
        const onchainRecordedAt = onchainCounter[7];
        const onchainValidOffchain = onchainCounter[8];

        countersignature = {
          skipped: false,
          existsOnChain: true,
          onchain: {
            pdfHash: onchainPdfHash,
            cadesHash: onchainCadesHash,
            cadesUri: onchainCadesUri,
            signerCommonName: onchainSignerCommonName,
            signerSerialNumber: onchainSignerSerialNumber,
            signedAt: onchainSignedAt.toString(),
            recordedAt: onchainRecordedAt.toString(),
            validOffchain: onchainValidOffchain
          },
          expected: {
            pdfHash: expectedPdfHash,
            cadesHash: expectedCadesHash,
            cadesUri: expectedCadesUri,
            signerCommonName: c?.signerCommonName || w?.signerCommonName || null,
            signerSerialNumber: c?.signerSerialNumber || w?.signerSerialNumber || null,
            validOffchain: c?.validOffchain ?? w?.validOffchain ?? null
          },
          matches: {
            pdfHashMatches: expectedPdfHash ? String(onchainPdfHash).toLowerCase() === String(expectedPdfHash).toLowerCase() : true,
            cadesHashMatches: expectedCadesHash ? String(onchainCadesHash).toLowerCase() === String(expectedCadesHash).toLowerCase() : true,
            cadesUriMatches: expectedCadesUri ? String(onchainCadesUri).toLowerCase() === String(expectedCadesUri).toLowerCase() : true
          }
        };
      } else {
        countersignature = {
          skipped: false,
          existsOnChain: false
        };
      }
    } catch (err) {
      countersignature = {
        skipped: false,
        error: "Errore lettura controfirma on-chain",
        details: err.message
      };
    }

    // ----------------------------------------------------------------
    // Seconda verifica: controfirma CLIENTE (.p7m.p7m) on-chain
    // ----------------------------------------------------------------
    let clientCountersignature = { skipped: true, reason: "controfirma cliente non disponibile" };

    try {
      const onchainClient = await contract.getClientCountersignature(forestUnitId);
      const onchainClientExists = onchainClient[0];

      if (onchainClientExists) {
        const expectedInnerCadesHash = cc?.innerCadesHash || w?.clientInnerCadesHash || null;
        const expectedClientCadesHash = cc?.clientCadesHash || w?.clientCadesHash || null;
        const expectedClientCadesUri = cc?.clientCadesUri || w?.clientCadesUri || null;

        const onchainInnerCadesHash = onchainClient[1];
        const onchainClientCadesHash = onchainClient[2];
        const onchainClientCadesUri = onchainClient[3];
        const onchainClientSignerCommonName = onchainClient[4];
        const onchainClientSignerSerialNumber = onchainClient[5];
        const onchainClientSignedAt = onchainClient[6];
        const onchainClientRecordedAt = onchainClient[7];
        const onchainClientValidOffchain = onchainClient[8];

        // Coerenza dell'annidamento: l'innerCadesHash della firma cliente
        // deve coincidere con il cadesHash della firma del firmatario on-chain.
        const onchainInnerMatchesUserSig =
          countersignature?.onchain?.cadesHash
            ? String(onchainInnerCadesHash).toLowerCase() ===
              String(countersignature.onchain.cadesHash).toLowerCase()
            : null;

        clientCountersignature = {
          skipped: false,
          existsOnChain: true,
          onchain: {
            innerCadesHash: onchainInnerCadesHash,
            clientCadesHash: onchainClientCadesHash,
            clientCadesUri: onchainClientCadesUri,
            signerCommonName: onchainClientSignerCommonName,
            signerSerialNumber: onchainClientSignerSerialNumber,
            signedAt: onchainClientSignedAt.toString(),
            recordedAt: onchainClientRecordedAt.toString(),
            validOffchain: onchainClientValidOffchain
          },
          expected: {
            innerCadesHash: expectedInnerCadesHash,
            clientCadesHash: expectedClientCadesHash,
            clientCadesUri: expectedClientCadesUri,
            signerCommonName: cc?.signerCommonName || w?.clientSignerCommonName || null,
            signerSerialNumber: cc?.signerSerialNumber || w?.clientSignerSerialNumber || null,
            validOffchain: cc?.validOffchain ?? w?.clientValidOffchain ?? null
          },
          matches: {
            innerCadesHashMatches: expectedInnerCadesHash
              ? String(onchainInnerCadesHash).toLowerCase() === String(expectedInnerCadesHash).toLowerCase()
              : true,
            clientCadesHashMatches: expectedClientCadesHash
              ? String(onchainClientCadesHash).toLowerCase() === String(expectedClientCadesHash).toLowerCase()
              : true,
            clientCadesUriMatches: expectedClientCadesUri
              ? String(onchainClientCadesUri).toLowerCase() === String(expectedClientCadesUri).toLowerCase()
              : true,
            nestingMatchesUserSignature: onchainInnerMatchesUserSig
          }
        };
      } else {
        clientCountersignature = {
          skipped: false,
          existsOnChain: false
        };
      }
    } catch (err) {
      clientCountersignature = {
        skipped: false,
        error: "Errore lettura controfirma cliente on-chain",
        details: err.message
      };
    }

    return res.json({
      ok: true,
      forestUnitId,
      existsOnChain,
      onchain: {
        ricardianHash: onchainHash,
        merkleRoot: onchainRoot,
        ricardianUri: onchainRicardianUri,
        pdfUri: onchainPdfUri
      },
      expected: {
        ricardianHash: expectedRicardianHash,
        merkleRoot: expectedMerkleRoot,
        ricardianUri: expectedRicardianUri,
        pdfUri: expectedPdfUri,
        pdfHash: expectedPdfHash
      },
      pdf: {
        pdfPath: pdfPathUsed,
        expectedPdfHash,
        localCurrentPdfHash,
        pdfBaselineMatches
      },
      matches: {
        hashMatches,
        rootMatches,
        ricardianUriMatches,
        pdfUriMatches,
        pdfHashMatches
      },
      ipfsVerify,
      proofs,
      countersignature,
      clientCountersignature
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "VERIFY failed", details: err.message });
  }
});

// --------------------
// ROUTES LIST
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

(async () => {
  const dss = await dssHealthCheck();
  if (dss.ok) {
    console.log("[INFO] DSS service raggiungibile su", process.env.DSS_URL || "http://localhost:8080/services/rest");
  } else {
    console.warn("[WARN] DSS NON raggiungibile:", dss.error);
    console.warn("[WARN]", dss.hint);
    console.warn("[WARN] La validazione CAdES qualificata non sarà disponibile fino al riavvio di DSS.");
  }
})();