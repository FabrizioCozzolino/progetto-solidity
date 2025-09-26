// scripts/ForestTrackingBlockchain.js
const hre = require("hardhat");
const axios = require("axios");
const { MerkleTree } = require("merkletreejs");
const keccak256 = require("keccak256");
const fs = require("fs");
const path = require("path");

// Postman environment file
const postmanEnvPath = path.join(__dirname, "foresttracking.postman_environment.json");

const API_URL = "http://51.91.111.200:3000/api"; // usa l’IP pubblico
const ACCOUNT = "lorenzo"; // nome account
const AUTH_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0b2tlbl90eXBlIjoiYWNjZXNzIiwiZXhwIjoxNzU4ODc3MzEzLCJpYXQiOjE3NTg4NzM3MTMsImp0aSI6IjZkNGNhYTFiMWM4ZTQ1Yjg4MDE4OTU5ZTcyNGMwZGFhIiwidXNlcl9pZCI6MTE0fQ.PaPKJTP7praZ6jlrROqulpftebRuW1yUhhw7GPlCM2w";

// Funzione di hashing unificato
function hashUnified(obj) {
  return keccak256(
    `${obj.type}|${obj.epc}|${obj.firstReading}|${obj.treeType || ''}|${obj.extra1 || ''}|${obj.extra2 || ''}`
  );
}

// Recupera forest units
async function getForestUnits() {
  const resp = await axios.post(`${API_URL}/get-forest-units-by-account`, {
    account: ACCOUNT,
    authToken: AUTH_TOKEN
  });
  return resp.data.forestUnits;
}

// Funzioni per aggiungere dati
async function addTree(forestUnits, forestUnitKey, tree) {
  const resp = await axios.post(`${API_URL}/add-tree`, { forestUnits, forestUnitKey, tree });
  return resp.data.forestUnits;
}

async function addWoodLog(forestUnits, forestUnitKey, treeEpc, woodLog) {
  const resp = await axios.post(`${API_URL}/add-woodlog`, { forestUnits, forestUnitKey, treeEpc, woodLog });
  return resp.data.forestUnits;
}

async function addSawnTimber(forestUnits, forestUnitKey, woodLogEpc, sawnTimber) {
  const resp = await axios.post(`${API_URL}/add-sawntimber`, { forestUnits, forestUnitKey, woodLogEpc, sawnTimber });
  return resp.data.forestUnits;
}

// Genera Merkle root
function generateMerkleRoot(batch) {
  const leaves = batch.map(hashUnified);
  const merkleTree = new MerkleTree(leaves, keccak256, { sortPairs: true });
  return merkleTree.getHexRoot();
}

// Scrive root su blockchain
async function setMerkleRootOnChain(forestUnitKey, merkleRoot) {
  const [deployer] = await hre.ethers.getSigners();
  const deployedPath = path.join(__dirname, "../deployed.json");
  const deployed = JSON.parse(fs.readFileSync(deployedPath, "utf8"));
  const contractAddress = deployed.ForestTracking;

  const contract = await hre.ethers.getContractAt("ForestTracking", contractAddress, deployer);
  const tx = await contract["setMerkleRootUnified(string,bytes32)"](forestUnitKey, merkleRoot);
  await tx.wait();
  console.log(`✅ Merkle root per ${forestUnitKey} scritta su blockchain: ${merkleRoot}`);
  return contract;
}

// Aggiorna Postman environment
function updatePostmanEnv(forestUnitKey, forestUnits, batch) {
  const env = JSON.parse(fs.readFileSync(postmanEnvPath, "utf8"));
  env.values.forEach(v => {
    if (v.key === "forestUnitKey") v.value = forestUnitKey;
    if (v.key === "forestUnits") v.value = JSON.stringify(forestUnits, null, 2);
    if (v.key === "batch") v.value = JSON.stringify(batch, null, 2);
  });
  fs.writeFileSync(postmanEnvPath, JSON.stringify(env, null, 2));
  console.log("✅ Postman environment aggiornato con forestUnitKey, forestUnits e batch");
}

// Flusso completo
async function main() {
  let forestUnits = await getForestUnits();
  console.log("🌲 Forest Units recuperate:", JSON.stringify(forestUnits, null, 2));

  const forestUnitKey = Object.keys(forestUnits)[0];

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

  // Aggiorna Postman environment
  updatePostmanEnv(forestUnitKey, forestUnits, batch);

  // Genera Merkle root
  const root = generateMerkleRoot(batch);
  console.log("🌳 Merkle root generata:", root);

  // Scrive su blockchain
  const contract = await setMerkleRootOnChain(forestUnitKey, root);
}

main().catch(console.error);