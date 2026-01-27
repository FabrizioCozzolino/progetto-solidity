require("dotenv").config({ path: "./environment_variables.env" });

const { ethers } = require("hardhat");
const fs = require("fs");
const IPFS = require("ipfs-http-client");
const axios = require("axios");
const { MerkleTree } = require("merkletreejs");
const keccak256 = require("keccak256");
const PDFDocument = require("pdfkit");

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

function generateRicardianPdf(ricardian, outPath) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const stream = fs.createWriteStream(outPath);
    doc.pipe(stream);

    doc.fontSize(18).text("Ricardian Contract - Forest Tracking", { align: "center" });
    doc.moveDown();

    doc.fontSize(12).text(`Type: ${ricardian.type}`);
    doc.text(`Version: ${ricardian.version}`);
    doc.text(`Jurisdiction: ${(ricardian.jurisdiction || []).join(", ")}`);
    if (ricardian.governingLaw) doc.text(`Governing law: ${ricardian.governingLaw}`);
    doc.moveDown();

    doc.fontSize(14).text("Actors", { underline: true });
    doc.fontSize(12).text(`Data owner: ${ricardian.actors?.dataOwner || ""}`);
    doc.text(`Data producer: ${ricardian.actors?.dataProducer || ""}`);
    doc.text(`Data consumer: ${ricardian.actors?.dataConsumer || ""}`);
    doc.moveDown();

    doc.fontSize(14).text("Scope", { underline: true });
    doc.fontSize(12).text(`Forest unit key: ${ricardian.scope?.forestUnitKey || ""}`);
    doc.text(`Included data: ${(ricardian.scope?.includedData || []).join(", ")}`);
    doc.moveDown();

    doc.fontSize(14).text("Human-readable agreement", { underline: true });
    doc.fontSize(12).text(ricardian.humanReadableAgreement?.text || "", {
      align: "left"
    });
    doc.moveDown();

    doc.fontSize(14).text("Technical bindings", { underline: true });
    doc.fontSize(12).text(`Merkle root: ${ricardian.technical?.merkleRootUnified || ""}`);
    doc.text(`Hash algorithm: ${ricardian.technical?.hashAlgorithm || ""}`);
    doc.text(`Storage: ${ricardian.technical?.storage || ""}`);
    if (ricardian.ipfsUri) doc.text(`IPFS URI: ${ricardian.ipfsUri}`);
    if (ricardian.ricardianHash) doc.text(`Ricardian hash (base): ${ricardian.ricardianHash}`);
    doc.moveDown();

    if (ricardian.signature?.eip712) {
      doc.fontSize(14).text("EIP-712 Signature", { underline: true });
      doc.fontSize(12).text(`Signer: ${ricardian.signature.eip712.signer}`);
      doc.text(`Signature: ${ricardian.signature.eip712.signature}`);
      doc.text(`ChainId: ${ricardian.signature.eip712.domain?.chainId}`);
      doc.text(`Verifying contract: ${ricardian.signature.eip712.domain?.verifyingContract}`);
      doc.moveDown();
    }

    doc.fontSize(10).text(`Created at: ${ricardian.timestamps?.createdAt || ""}`, { align: "right" });

    doc.end();

    stream.on("finish", resolve);
    stream.on("error", reject);
  });
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
  // 3.5) EIP-712 DOMAIN INFO
  // --------------------
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);

  const verifyingContract = process.env.FOREST_CONTRACT_ADDRESS;
  console.log("🆔 Chain ID:", chainId);
  console.log("🏛️ Verifying Contract:", verifyingContract);

    // --------------------
  // 4) RICARDIAN JSON (base, poi firma EIP-712)
  // --------------------
  const ricardianBase = {
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

    rightsAndDuties: {
      dataOwner: "Detiene la titolarità dei dati e autorizza la loro registrazione e verifica",
      dataProducer: "Garantisce la correttezza della raccolta e l'origine dei dati",
      dataConsumer: "Può verificare l’integrità dei dati ma non modificarli"
    },

    technical: {
      merkleRootUnified: root,
      batchFormat: "JSON",
      storage: useIPFS ? "IPFS" : "LOCAL_FILE",
      hashAlgorithm: "keccak256"
    },

    legal: {
      legalValue: "Probatorio",
      statement:
        "L'hash registrato on-chain costituisce prova di esistenza e integrità del dataset alla data di registrazione."
    },

    hashBinding: {
      bindsHumanReadableText: true,
      bindsDatasetMerkleRoot: true
    },

    timestamps: {
      createdAt: new Date().toISOString()
    }
  };

  // Hash "base" (senza firma, stabile)
  const ricardianHash = toKeccak256(ricardianBase);
  console.log("Ricardian hash (base):", ricardianHash);

  // --------------------
  // 4.5) FIRMA EIP-712 (off-chain)
  // --------------------
  const domain = {
    name: "RicardianForestTracking",
    version: "1",
    chainId,
    verifyingContract
  };

  const types = {
    RicardianForest: [
      { name: "forestUnitKey", type: "string" },
      { name: "ricardianHash", type: "bytes32" },
      { name: "merkleRoot", type: "bytes32" },
      { name: "createdAt", type: "string" }
    ]
  };

  const message = {
    forestUnitKey: selectedForestKey,
    ricardianHash,
    merkleRoot: root,
    createdAt: ricardianBase.timestamps.createdAt
  };

  const eip712Signature = await signer.signTypedData(domain, types, message);

  // Verifica (debug utile)
  const recovered = ethers.verifyTypedData(domain, types, message, eip712Signature);
  if (recovered.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error("❌ Firma EIP-712 non valida: recovered diverso dal signer");
  }
  console.log("✅ EIP-712 signature ok. Signer:", signer.address);

  // Ora il Ricardian completo (base + firma)
  const ricardianForest = {
    ...ricardianBase,
    ricardianHash, // mettiamo anche dentro al JSON per leggibilità
    signature: {
      eip712: {
        signer: signer.address,
        domain,
        types,
        message,
        signature: eip712Signature
      }
    }
  };


    // --------------------
  // 5) SALVA JSON (e opzionale IPFS) + GENERA PDF
  // --------------------
  let ipfsPath = null;

  // Salvo sempre localmente (comodo per PDF / debug)
  fs.writeFileSync("ricardian-forest.json", JSON.stringify(ricardianForest, null, 2));
  console.log("Saved Ricardian locally: ricardian-forest.json");

  if (useIPFS) {
    ipfsPath = await uploadToIPFS(ricardianForest, "ricardian-forest.json");
    console.log("Uploaded Ricardian to:", ipfsPath);

    // utile anche nel PDF / JSON
    ricardianForest.ipfsUri = ipfsPath;
    fs.writeFileSync("ricardian-forest.json", JSON.stringify(ricardianForest, null, 2));
  }

  // PDF
  const pdfPath = "ricardian-forest.pdf";
  await generateRicardianPdf(ricardianForest, pdfPath);
  console.log("📄 PDF generato:", pdfPath);


  // --------------------
// 6) REGISTRA ON-CHAIN (con stima gas)
// --------------------
const ForestTracking = await ethers.getContractAt(
  "ForestTracking",
  process.env.FOREST_CONTRACT_ADDRESS
);

// --- STIMA GAS ---
const gasEstimate = await ethers.provider.estimateGas({
  to: process.env.FOREST_CONTRACT_ADDRESS,
  data: ForestTracking.interface.encodeFunctionData(
    "registerRicardianForest",
    [
      selectedForestKey,
      ricardianHash,
      root,
      ipfsPath || "file://ricardian-forest.json"
    ]
  ),
  from: signer.address
});

const feeData = await ethers.provider.getFeeData();
const gasPrice = feeData.gasPrice || ethers.parseUnits("20", "gwei");
const gasCostWei = gasEstimate * gasPrice;
const gasCostEth = Number(ethers.formatEther(gasCostWei));
const ethPrice = await getEthPriceInEuro();

console.log(
  `⛽ Gas stimato: ${gasEstimate.toString()} | ` +
  `Costo: ${gasCostEth.toFixed(6)} ETH ≈ €${(gasCostEth * ethPrice).toFixed(2)}`
);

// --- INVIO TRANSAZIONE ---
console.log("⏳ Invio transazione per registrare il Ricardian Contract...");

const tx = await ForestTracking.registerRicardianForest(
  selectedForestKey,
  ricardianHash,
  root,
  ipfsPath || "file://ricardian-forest.json"
);

const receipt = await tx.wait();

console.log("✅ Ricardian Forest registered on-chain");
console.log("🔗 Tx hash:", receipt.transactionHash || tx.hash);
console.log("📦 Block number:", receipt.blockNumber);

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