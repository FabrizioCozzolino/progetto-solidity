require("dotenv").config({ path: "./environment_variables.env" });

const { ethers } = require("hardhat");
const fs = require("fs");
const IPFS = require("ipfs-http-client");
const axios = require("axios");
const { MerkleTree } = require("merkletreejs");
const keccak256 = require("keccak256");

// --------------------
// FLAG IPFS (env)
// --------------------
const useIPFS = process.env.USE_IPFS === "true" || process.env.USE_IPFS === "1";

// --------------------
// IPFS CLIENT (daemon locale)
// --------------------
const ipfs = IPFS.create({ host: "localhost", port: "5002", protocol: "http" });

// --------------------
// UTILS
// --------------------
function toKeccak256(obj) {
  return ethers.keccak256(
    ethers.toUtf8Bytes(JSON.stringify(obj))
  );
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

// --------------------
// UPLOAD + PIN IPFS
// --------------------
async function uploadToIPFS(json, filename) {
  fs.writeFileSync(filename, JSON.stringify(json, null, 2));
  const fileContent = fs.readFileSync(filename);

  // 1) ADD
  const { cid } = await ipfs.add({ path: filename, content: fileContent });
  const ipfsUri = `ipfs://${cid}/${filename}`;

  // 2) PIN
  await ipfs.pin.add(cid);

  return ipfsUri;
}

async function fetchFromIPFS(ipfsUri) {
  const parts = ipfsUri.replace("ipfs://", "").split("/");
  const cid = parts[0];

  const chunks = [];
  for await (const chunk of ipfs.cat(cid)) {
    chunks.push(chunk);
  }

  const fileContent = Buffer.concat(chunks).toString();
  return JSON.parse(fileContent);
}

// --------------------
// MAIN
// --------------------
async function main() {
  const [signer] = await ethers.getSigners();
  console.log("Using account:", signer.address);

  // --------------------
  // 1) RECUPERA FOREST UNITS DAL BACKEND
  // --------------------
  const LOGIN_CREDENTIALS = { username: "lorenzo", password: "puglet007" };
  let token;
  try {
    const res = await axios.post("https://digimedfor.topview.it/api/get-token/", LOGIN_CREDENTIALS, {
      httpsAgent: new (require("https").Agent)({ rejectUnauthorized: false })
    });
    token = res.data.access;
  } catch (e) {
    console.error("❌ Errore login:", e.message);
    process.exit(1);
  }

  let forestUnits;
  try {
    const res = await axios.get("https://digimedfor.topview.it/api/get-forest-units/", {
      headers: { Authorization: `Bearer ${token}` },
      httpsAgent: new (require("https").Agent)({ rejectUnauthorized: false })
    });
    forestUnits = res.data.forestUnits;
  } catch (e) {
    console.error("❌ Errore fetch forest units:", e.message);
    process.exit(1);
  }

  const forestKeys = Object.keys(forestUnits);
  if (forestKeys.length === 0) {
    console.error("❌ Nessuna forest unit disponibile.");
    process.exit(1);
  }

  const selectedForestKey = forestKeys[0];
  const unit = forestUnits[selectedForestKey];
  console.log(`\n✅ Forest Unit selezionata: ${unit.name || selectedForestKey}\n`);

  // --------------------
  // 2) COSTRUISCI BATCH UNIFICATO
  // --------------------
  const leaves = [];
  const batchWithProof = [];
  const seenEpcs = new Set();

  const formatDate = d => d ? new Date(d).toISOString() : "";

  function getObservations(obj) {
    if (!obj) return "";
    if (Array.isArray(obj.observations)) return obj.observations.join("; ");
    return obj.observations || "";
  }

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
      coordinates: t.coordinates ? `${t.coordinates.latitude || t.coordinates.lat || ""},${t.coordinates.longitude || t.coordinates.lon || ""}`.replace(/(^,|,$)/g, "") : "",
      notes: Array.isArray(t.notes) ? t.notes.map(n => n.description || n).join("; ") : t.notes || "",
      observations: getObservations(t),
      forestUnitId: selectedForestKey,
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
        coordinates: log.coordinates ? `${log.coordinates.latitude || log.coordinates.lat || ""},${log.coordinates.longitude || log.coordinates.lon || ""}`.replace(/(^,|,$)/g, "") : "",
        notes: Array.isArray(log.notes) ? log.notes.map(n => n.description || n).join("; ") : log.notes || "",
        observations: getObservations(log),
        forestUnitId: selectedForestKey,
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
          coordinates: st?.coordinates ? `${st.coordinates.latitude || st.coordinates.lat || ""},${st.coordinates.longitude || st.coordinates.lon || ""}`.replace(/(^,|,$)/g, "") : "",
          notes: Array.isArray(st?.notes) ? st.notes.map(n => n.description || n).join("; ") : st?.notes || "",
          observations: getObservations(st),
          forestUnitId: selectedForestKey,
          domainUUID: st?.domainUUID || st?.domainUuid,
          deleted: st?.deleted || false,
          lastModification: st?.lastModification || st?.lastModfication || ""
        };
        addToBatch(stObj);
      }
    }
  }

  // --------------------
  // 3) MERKLE TREE UNIFICATO
  // --------------------
  const merkleTree = new MerkleTree(leaves, keccak256, { sortPairs: true });
  const root = merkleTree.getHexRoot();
  console.log("\n🔑 Merkle Root:", root);

  // --------------------
// 4) RICARDIAN JSON
// --------------------
const ricardianForest = {
  version: "1.0",
  type: "RicardianForestTracking",

  jurisdiction: ["IT", "EU"],
  governingLaw: "Diritto italiano ed europeo",

  actors: {
    dataOwner: "TopView Srl",
    dataProducer: "Operatore drone",
    dataConsumer: "Cliente finale"
  },

  purpose: "Tracciabilità e prova di integrità dei dati forestali",

  scope: {
    forestUnitKey: selectedForestKey,
    includedData: ["trees", "wood_logs", "sawn_timbers"]
  },

  // ---- TESTO LEGALE HUMAN-READABLE (fondamentale)
  humanReadableAgreement: {
    language: "it",
    text: `
Il presente accordo disciplina la raccolta, la registrazione, la conservazione
e la verifica dell’integrità dei dati forestali relativi all’unità forestale
"${selectedForestKey}".

Le parti riconoscono che il dataset è memorizzato off-chain e che l’hash
crittografico registrato su blockchain costituisce prova di esistenza,
immutabilità e integrità dei dati alla data di registrazione.

Il presente documento è strutturato come contratto ricardiano, essendo
interpretabile sia da esseri umani sia da sistemi automatici.
`.trim()
  },

  // ---- DIRITTI E DOVERI (chi fa cosa)
  rightsAndDuties: {
    dataOwner: "Detiene la titolarità dei dati e autorizza la loro registrazione e verifica",
    dataProducer: "Garantisce la correttezza della raccolta e l'origine dei dati",
    dataConsumer: "Può verificare l’integrità dei dati ma non modificarli"
  },

  technical: {
    merkleRootUnified: root,
    batchFormat: "JSON",
    storage: "IPFS",
    hashAlgorithm: "keccak256"
  },

  legal: {
    legalValue: "Probatorio",
    statement:
      "L'hash registrato on-chain costituisce prova di esistenza e integrità del dataset alla data di registrazione."
  },

  // ---- COLLEGAMENTO CRITTOGRAFICO TESTO ↔ DATI
  hashBinding: {
    bindsHumanReadableText: true,
    bindsDatasetMerkleRoot: true
  },

  timestamps: {
    createdAt: new Date().toISOString()
  }
};

  // --------------------
  // 5) UPLOAD SU IPFS (solo se USE_IPFS=true)
  // --------------------
  let ipfsPath = null;
  if (useIPFS) {
    ipfsPath = await uploadToIPFS(ricardianForest, "ricardian-forest.json");
    console.log("Uploaded Ricardian to:", ipfsPath);
  } else {
    fs.writeFileSync("ricardian-forest.json", JSON.stringify(ricardianForest, null, 2));
    console.log("Saved Ricardian locally: ricardian-forest.json");
  }

  const ricardianHash = toKeccak256(ricardianForest);
  console.log("Ricardian hash:", ricardianHash);

  // --------------------
  // 6) REGISTRA ON-CHAIN
  // --------------------
  const ForestTracking = await ethers.getContractAt("ForestTracking", process.env.FOREST_CONTRACT_ADDRESS);

  const tx = await ForestTracking.registerRicardianForest(
    selectedForestKey,
    ricardianHash,
    root,
    ipfsPath || "file://ricardian-forest.json"
  );
  await tx.wait();
  console.log("✅ Ricardian Forest registered on-chain");

  // --------------------
  // 7) VERIFICA HASH IPFS (solo se USE_IPFS=true)
  // --------------------
  if (useIPFS) {
    console.log("\nVerifying Ricardian JSON...");
    const fetchedJSON = await fetchFromIPFS(ipfsPath);
    const fetchedHash = toKeccak256(fetchedJSON);
    if (fetchedHash === ricardianHash) console.log("✅ IPFS JSON hash matches on-chain Ricardian hash");
    else console.log("❌ Hash mismatch!");
  }

  // --------------------
  // 8) VERIFICA MERKLE PROOF
  // --------------------
  console.log("\nVerifying Merkle proofs for all leaves...");
  let validCount = 0;
  let invalidCount = 0;

  for (let i = 0; i < leaves.length; i++) {
    const leaf = leaves[i];
    const obj = batchWithProof[i];
    const proof = merkleTree.getProof(leaf).map(x => '0x' + x.data.toString('hex'));

    const isValid = merkleTree.verify(proof, leaf, merkleTree.getRoot());
    console.log(`Leaf ${i + 1}: EPC ${obj.epc} | Proof valid: ${isValid}`);

    if (isValid) validCount++;
    else invalidCount++;
  }

  console.log("\n✅ Proof valide:", validCount, "/", leaves.length);
  console.log("❌ Proof non valide:", invalidCount, "/", leaves.length);

  // --------------------
  // 9) SALVA BATCH JSON CON PROOF
  // --------------------
  const outputDir = "./file-json";
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);
  fs.writeFileSync(`${outputDir}/forest-unified-batch.json`, JSON.stringify(batchWithProof, null, 2));
  console.log("💾 Salvato batch JSON con proof: forest-unified-batch.json");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});