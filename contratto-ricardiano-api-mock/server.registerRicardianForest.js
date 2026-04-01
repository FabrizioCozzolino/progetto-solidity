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
const multer = require("multer");

const { create } = require("ipfs-http-client");
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);

// --------------------
// CONFIG
// --------------------
const PORT = Number(process.env.PORT || 3000);

// TopView endpoints
const TOPVIEW_TOKEN_URL = process.env.TOPVIEW_TOKEN_URL || "https://digimedfor.topview.it/api/get-token/";
const TOPVIEW_FOREST_UNITS_URL = process.env.TOPVIEW_FOREST_UNITS_URL || "https://digimedfor.topview.it/api/get-forest-units/";
const TOPVIEW_USERNAME = process.env.TOPVIEW_USERNAME || "operator";
const TOPVIEW_PASSWORD = process.env.TOPVIEW_PASSWORD || "1234567!";
const TOPVIEW_HTTPS_INSECURE = (process.env.TOPVIEW_HTTPS_INSECURE || "true") === "true";

const RICARDIAN_DIR = process.env.RICARDIAN_DIR || path.join(__dirname, "storage", "ricardians");
const CADES_DIR = process.env.CADES_DIR || path.join(__dirname, "storage", "cades");
const TMP_DIR = process.env.TMP_DIR || path.join(__dirname, "storage", "tmp");

for (const dir of [RICARDIAN_DIR, CADES_DIR, TMP_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// EVM / Contract
const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
const PRIVATE_KEY =
  process.env.PRIVATE_KEY ||
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

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
  cades: {}
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

async function extractCertificateInfoFromP7m(p7mPath) {

  const certOutPath = path.join(
    TMP_DIR,
    `cert-${Date.now()}.pem`
  );

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

    const { stdout } = await execFileAsync("openssl", [
      "x509",
      "-in", certOutPath,
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

    return {

      signerCommonName: parseSubjectField(subject, "CN"),
      signerSerialNumber: parseSubjectField(subject, "serialNumber"),

      organization: parseSubjectField(subject, "O"),
      country: parseSubjectField(subject, "C"),

      issuer,

      validFrom: get(/Not Before:\s*(.+)/),
      validTo: get(/Not After\s*:\s*(.+)/),

      signatureAlgorithm: get(/Signature Algorithm:\s*(.+)/),

      keyUsage: get(/X509v3 Key Usage:.*\n\s*(.+)/),
      extendedKeyUsage: get(/X509v3 Extended Key Usage:.*\n\s*(.+)/),
      policy: get(/Policy:\s*([0-9\.]+)/),

      rawSubject: subject,
      rawIssuer: issuer,
      rawCertificate: certText
    };

  } catch (err) {

    return {
      error: err.message
    };

  } finally {

    if (fs.existsSync(certOutPath)) {
      try { fs.unlinkSync(certOutPath); } catch {}
    }

  }
}

async function verifyAndExtractCadesAttachedPdf(p7mPath, extractedPdfPath) {
  const attempts = [
    ["cms", "-verify", "-inform", "DER", "-binary", "-noverify", "-in", p7mPath, "-out", extractedPdfPath],
    ["smime", "-verify", "-inform", "DER", "-binary", "-noverify", "-in", p7mPath, "-out", extractedPdfPath]
  ];

  let lastError = null;

  for (const args of attempts) {
    try {
      const { stderr } = await execFileAsync("openssl", args);
      return {
        ok: true,
        stderr: stderr || ""
      };
    } catch (err) {
      lastError = err;
    }
  }

  return {
    ok: false,
    error: lastError?.message || "OpenSSL verify failed"
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

  const selectedForestKey = keys[keys.length - 2];
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

async function buildAndSignRicardianInternal(forestUnitId, merkleRoot, storageMode = "LOCAL_FILE") {
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
      storage: storageMode,
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

async function persistRicardianLocalInternal(forestUnitId) {
  const r = state.ricardians?.[forestUnitId];
  if (!r?.ricardianForest) throw new Error("Ricardian non trovato (buildAndSign non eseguito)");

  const safeName = String(forestUnitId).replace(/[^a-zA-Z0-9_-]/g, "_");
  const outPath = path.join(RICARDIAN_DIR, `ricardian-${safeName}.json`);
  fs.writeFileSync(outPath, JSON.stringify(r.ricardianForest, null, 2));

  r.jsonPath = outPath;
  r.storageUri = toFileUri(outPath);
  return { storageUri: r.storageUri, jsonPath: outPath };
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

  const tx = await contract.setRicardianPdfUri(forestUnitId, pdfUri);
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
    r.storageUri = toFileUri(outPath);

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

    fs.renameSync(uploadedTempPath, finalP7mPath);
    uploadedTempPath = null;

    const verifyResult = await verifyAndExtractCadesAttachedPdf(finalP7mPath, extractedPdfPath);
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
    const extractedPdfHash = sha256FileBytes32(extractedPdfPath);
    const cadesHash = sha256FileBytes32(finalP7mPath);

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
    path.join(__dirname, "storage", "ricardians", "trusted-ca.pem");

const trustResult = await verifyCadesSignatureTrust(finalP7mPath, caFilePath);

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
      caFilePath
    };

    return res.json({
      ok: true,
      forestUnitId,
      validOffchain,
      trustedSignature: trustResult.trusted,
      trustDetails: trustResult.ok ? trustResult.details : trustResult.error,
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

// --------------------
// OFFICIAL #1: WRITE CONTRACT ON-CHAIN
// --------------------
app.post("/api/contract/write", async (req, res) => {
  try {
    const useIPFS = !!req.body?.useIPFS;

    const login = await topviewEnsureLogin(
      process.env.TOPVIEW_USERNAME,
      process.env.TOPVIEW_PASSWORD
    );

    let forestUnitId = req.body?.forestUnitId;
    let imported;

    if (!forestUnitId) {
      imported = await topviewImportLatest();
      forestUnitId = imported.forestUnitId;
    } else {
      imported = await topviewImportForestUnitById(forestUnitId);
    }

    const forestData = imported.unit;

    const batch = await buildUnifiedBatchInternal(forestUnitId, forestData);

    const ric = await buildAndSignRicardianInternal(
      forestUnitId,
      batch.merkleRoot,
      useIPFS ? "IPFS" : "LOCAL_FILE"
    );

    let storage;
    if (useIPFS) storage = await uploadRicardianToIpfsInternal(forestUnitId);
    else storage = await persistRicardianLocalInternal(forestUnitId);

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
      pdfUri: null,
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

    const baseUrl = getBaseUrl(req);
    const pdfViewUrl = `${baseUrl}/api/ricardian/pdf/${encodeURIComponent(forestUnitId)}/view`;
    const pdfDownloadUrl = `${baseUrl}/api/ricardian/pdf/${encodeURIComponent(forestUnitId)}/download`;

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
      ricardianUri: existingWrite?.ricardianUri || existingRic.storageUri || null,
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
      countersignature
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