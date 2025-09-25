// scripts/ForestTrackingBlockchain.js
const hre = require("hardhat");
const axios = require("axios");
const { MerkleTree } = require("merkletreejs");
const keccak256 = require("keccak256");
const fs = require("fs");
const path = require("path");

const API_URL = "http://localhost:3000/api"; // server mock
const ACCOUNT = "lorenzo"; // nome account
const AUTH_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0b2tlbl90eXBlIjoiYWNjZXNzIiwiZXhwIjoxNzU4ODAwMTg4LCJpYXQiOjE3NTg3OTY1ODgsImp0aSI6IjlmM2YwMTBhZDkyYzRmN2ViNzhkOGVhZTQ0MjU3ZmIzIiwidXNlcl9pZCI6MTE0fQ.2bVQNKNFS0KX0EPzFniPzIoZU7EtGo9-_PCiSKDKtKs"; // token fittizio

// Funzione di hashing unificato (Tree + WoodLog + SawnTimber)
function hashUnified(obj) {
  return keccak256(
    `${obj.type}|${obj.epc}|${obj.firstReading}|${obj.treeType || ''}|${obj.extra1 || ''}|${obj.extra2 || ''}`
  );
}

// Recupera tutte le forest units dall’API
async function getForestUnits() {
  const resp = await axios.post(`${API_URL}/get-forest-units-by-account`, {
    account: ACCOUNT,
    authToken: AUTH_TOKEN
  });
  return resp.data.forestUnits;
}

// Aggiunge un albero
async function addTree(forestUnits, forestUnitKey, tree) {
  const resp = await axios.post(`${API_URL}/add-tree`, { forestUnits, forestUnitKey, tree });
  return resp.data.forestUnits;
}

// Aggiunge un tronco
async function addWoodLog(forestUnits, forestUnitKey, treeEpc, woodLog) {
  const resp = await axios.post(`${API_URL}/add-woodlog`, { forestUnits, forestUnitKey, treeEpc, woodLog });
  return resp.data.forestUnits;
}

// Aggiunge una tavola segata
async function addSawnTimber(forestUnits, forestUnitKey, woodLogEpc, sawnTimber) {
  const resp = await axios.post(`${API_URL}/add-sawntimber`, { forestUnits, forestUnitKey, woodLogEpc, sawnTimber });
  return resp.data.forestUnits;
}

// Genera la Merkle root da batch unificato
function generateMerkleRoot(batch) {
  const leaves = batch.map(hashUnified);
  const merkleTree = new MerkleTree(leaves, keccak256, { sortPairs: true });
  return merkleTree.getHexRoot();
}

// Scrive la root sul contratto per una forest unit specifica
async function setMerkleRootOnChain(forestUnitKey, merkleRoot) {
  const [deployer] = await hre.ethers.getSigners();

  const deployedPath = path.join(__dirname, "../deployed.json");
  if (!fs.existsSync(deployedPath)) throw new Error("File deployed.json non trovato. Deploya il contratto prima!");

  const deployed = JSON.parse(fs.readFileSync(deployedPath, "utf8"));
  const contractAddress = deployed.ForestTracking;
  if (!contractAddress) throw new Error("Indirizzo contratto non trovato in deployed.json");

  const contract = await hre.ethers.getContractAt("ForestTracking", contractAddress, deployer);

  // ✅ chiama la funzione con signature esplicita
  const tx = await contract["setMerkleRootUnified(string,bytes32)"](forestUnitKey, merkleRoot);
  await tx.wait();

  console.log(`✅ Merkle root per ${forestUnitKey} scritta su blockchain: ${merkleRoot}`);
  return contract;
}


// Verifica Merkle proof di un elemento
async function verifyProof(contract, forestUnitKey, element, batch) {
  const leaves = batch.map(hashUnified);
  const merkleTree = new MerkleTree(leaves, keccak256, { sortPairs: true });
  const leafHash = hashUnified(element);
  const proof = merkleTree.getHexProof(leafHash);

  const rootOnChain = await contract.merkleRoots(forestUnitKey);
  const isValid = merkleTree.verify(proof, leafHash, rootOnChain);

  console.log("🔹 Elemento:", element);
  console.log("🔹 Leaf hash:", leafHash.toString('hex'));
  console.log("🔹 Proof:", proof);
  console.log("🔹 Root on chain:", rootOnChain);
  console.log("✅ Proof valida?", isValid);
}

// Flusso completo
async function main() {
  let forestUnits = await getForestUnits();
  const forestUnitKey = Object.keys(forestUnits)[0]; // usa la prima forest unit disponibile

  // Aggiungi dati
  const tree = { epc: "TREE123", type: "Tree", firstReading: new Date().toISOString(), treeType: "DOUGLASFIR" };
  forestUnits = await addTree(forestUnits, forestUnitKey, tree);

  const woodLog = { epc: "WOODLOG123", type: "WoodLog", firstReading: new Date().toISOString(), extra1: "diameter:30cm" };
  forestUnits = await addWoodLog(forestUnits, forestUnitKey, tree.epc, woodLog);

  const sawnTimber = { epc: "SAWNTIMBER123", type: "SawnTimber", firstReading: new Date().toISOString(), extra1: "length:2m" };
  forestUnits = await addSawnTimber(forestUnits, forestUnitKey, woodLog.epc, sawnTimber);

  // Crea batch unificato
  const batch = [];
  const treesObj = forestUnits[forestUnitKey].trees || {};
  for (const t of Object.values(treesObj)) {
    batch.push(t);
    if (t.woodLogs) {
      for (const w of Object.values(t.woodLogs)) {
        batch.push(w);
        if (w.sawnTimbers) batch.push(...Object.values(w.sawnTimbers));
      }
    }
  }

  // Genera Merkle root
  const root = generateMerkleRoot(batch);
  console.log("🌳 Merkle root generata:", root);

  // Scrive su blockchain
  const contract = await setMerkleRootOnChain(forestUnitKey, root);

  // Verifica proof per ogni elemento
  for (const elem of batch) {
    await verifyProof(contract, forestUnitKey, elem, batch);
  }
}

main().catch(console.error);