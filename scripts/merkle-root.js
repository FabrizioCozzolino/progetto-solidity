const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { MerkleTree } = require("merkletreejs");
const keccak256 = require("keccak256");
const ethers = hre.ethers; // ethers v6

const deployedPath = path.join(__dirname, "../deployed.json");
const deployed = JSON.parse(fs.readFileSync(deployedPath));
const CONTRACT_ADDRESS = deployed.ForestTracking || deployed.address;

if (!CONTRACT_ADDRESS) {
  console.error("❌ Indirizzo contratto non trovato nel file deployed.json.");
  process.exit(1);
}

const API_URL = "https://pollicino.topview.it:9443/api/get-forest-units/";
const AUTH_TOKEN = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0b2tlbl90eXBlIjoiYWNjZXNzIiwiZXhwIjoxNzUzMzUxNzMyLCJpYXQiOjE3NTMzNDgxMzIsImp0aSI6IjY2YTIzNmFlNjY2YTRkN2ZhMDA0YzQ5NzJjODA3NzJiIiwidXNlcl9pZCI6MTEwfQ.hhtuCeyZBN6a2fJh0kF6vyNp6r8olhrfFz33FEN0We4";

function leafHash(tree) {
  return keccak256(
    `${tree.epc}|${tree.firstReading}|${tree.treeType}|${tree.coordinates}|${tree.observations}`
  );
}

// Funzione per ottenere il prezzo ETH/EUR da CoinGecko
async function getEthPriceInEuro() {
  try {
    const res = await axios.get("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=eur");
    return res.data.ethereum.eur; // prezzo ETH in euro
  } catch (error) {
    console.error("❌ Errore nel recuperare il prezzo ETH/EUR:", error.message);
    return null;
  }
}

async function main() {
  console.log("=== INIZIO SCRIPT ===");

  const signer = (await ethers.getSigners())[0];
  console.log("👤 Signer address:", await signer.getAddress());

  const contractJson = require("../artifacts/contracts/ForestTracking.sol/ForestTracking.json");
  const contract = new ethers.Contract(CONTRACT_ADDRESS, contractJson.abi, signer);

  console.log("=== DEBUG CONTRATTO ===");
  console.log("Contract keys:", Object.keys(contract));
  console.log("Contract interface fragments count:", contract.interface.fragments.length);

  if (contract.interface && Array.isArray(contract.interface.fragments)) {
    const funcs = contract.interface.fragments
      .filter(f => f.type === "function")
      .map(f => f.name);
    console.log("📋 Funzioni disponibili:", funcs);
  } else {
    console.warn("⚠️ contract.interface.fragments non definito o non un array");
  }

  console.log("setMerkleRootTrees esiste? Tipo:", typeof contract.setMerkleRootTrees);
  console.log("=======================");

  console.log("✅ Contratto caricato da:", CONTRACT_ADDRESS);

  let response;
  try {
    response = await axios.get(API_URL, { headers: { Authorization: AUTH_TOKEN } });
    console.log("✅ Chiamata API riuscita, status:", response.status);
  } catch (e) {
    console.error("❌ Errore chiamata API:", e.response?.data || e.message);
    process.exit(1);
  }

  const forestUnits = response.data.forestUnits;
  const forestKey = Object.keys(forestUnits).find(
    k =>
      k.toLowerCase() === "vallombrosa" ||
      forestUnits[k].name?.toLowerCase().includes("vallombrosa")
  );

  if (!forestKey) {
    console.error("❌ Nessuna forest unit 'Vallombrosa' trovata.");
    process.exit(1);
  }

  console.log(`🌲 Forest unit trovata: '${forestKey}'`);
  const treesDict = forestUnits[forestKey].trees;
  const treeKeys = Object.keys(treesDict);

  if (treeKeys.length === 0) {
    console.warn("⚠️ Nessun albero trovato nella forest unit.");
    process.exit(1);
  }

  const batch = [];
  const leaves = [];
  const allTimbersLogs = [];

  for (const id of treeKeys) {
    const t = treesDict[id];
    const epc = t.domainUUID || t.domainUuid || id;
    const firstReading = t.firstReadingTime
      ? Math.floor(new Date(t.firstReadingTime).getTime() / 1000)
      : 0;
    const treeType = t.treeType?.specie || "";
    const coordinates = t.coordinates
      ? `${t.coordinates.latitude},${t.coordinates.longitude}`
      : "";
    const observations = t.notes || "";

    const obj = { epc, firstReading, treeType, coordinates, observations };
    batch.push(obj);
    leaves.push(leafHash(obj));

    // Gestione sawnTimbers (oggetto)
    if (t.sawnTimbers && Object.keys(t.sawnTimbers).length > 0) {
      for (const timberEpc of Object.keys(t.sawnTimbers)) {
        const timberData = t.sawnTimbers[timberEpc];
        allTimbersLogs.push({
          parentTreeEPC: epc,
          timberEPC: timberEpc,
          qualities: timberData.qualities || [],
          observations: timberData.observations || [],
          firstReadingTime: timberData.firstReadingTime || null,
        });
      }
    }
  }

  console.log(`✅ Alberi validi per Merkle tree: ${batch.length}`);
  console.log(`✅ Sawn timbers totali: ${allTimbersLogs.length}`);

  const merkleTree = new MerkleTree(leaves, keccak256, { sortPairs: true });
  const root = merkleTree.getHexRoot();
  console.log("🌲 Merkle Root calcolata:", root);

  try {
    if (typeof contract.setMerkleRootTrees !== "function") {
      console.error("❌ La funzione setMerkleRootTrees non è disponibile nel contratto.");
      process.exit(1);
    }

    // Stima gas
    const gasEstimate = await hre.ethers.provider.estimateGas({
      to: CONTRACT_ADDRESS,
      data: contract.interface.encodeFunctionData("setMerkleRootTrees", [root]),
      from: await signer.getAddress()
    });
    console.log("⏳ Stima gas per setMerkleRootTrees:", gasEstimate.toString());

    const feeData = await hre.ethers.provider.getFeeData();
    const gasPrice = feeData.gasPrice || feeData.maxFeePerGas;
    if (!gasPrice) {
      throw new Error("Impossibile ottenere gas price da provider");
    }
    console.log("💰 Gas price:", hre.ethers.formatUnits(gasPrice, "gwei"), "Gwei");

    const gasCost = gasEstimate * gasPrice;

    console.log(`💰 Costo stimato: ${hre.ethers.formatEther(gasCost)} ETH`);

    // Ottieni prezzo ETH/EUR
    const ethPriceEUR = await getEthPriceInEuro();
    if (ethPriceEUR !== null) {
      console.log(`💶 Costo stimato in Euro: €${(Number(hre.ethers.formatEther(gasCost)) * ethPriceEUR).toFixed(4)}`);
    } else {
      console.log("⚠️ Non è stato possibile recuperare il prezzo ETH/EUR per mostrare i costi in euro.");
    }

    // Invio transazione
    const tx = await contract.setMerkleRootTrees(root);
    const receipt = await tx.wait();

    const actualCost = receipt.gasUsed * gasPrice;

    console.log("✅ Merkle root aggiornata.");
    console.log(`⛽ Gas usato: ${receipt.gasUsed.toString()}`);
    console.log(`💸 Costo reale: ${hre.ethers.formatEther(actualCost)} ETH`);

    if (ethPriceEUR !== null) {
      console.log(`💶 Costo reale in Euro: €${(Number(hre.ethers.formatEther(actualCost)) * ethPriceEUR).toFixed(4)}`);
    }

    // Proof per il primo albero
    const proof = merkleTree.getHexProof(leafHash(batch[0]));
    console.log("📌 Proof primo albero:", proof);

    // Verifica immediata della proof sul contratto
    const leaf = leafHash(batch[0]);
    const isValid = await contract.verifyTreeProof(leaf, proof);
    console.log(`🔍 Proof valida per il primo albero? ${isValid ? "✅ SÌ" : "❌ NO"}`);

  } catch (e) {
    console.error("❌ Errore durante update Merkle root:", e.message);
    process.exit(1);
  }

  // Salva un file con alberi e sawn timbers unificati
  const unifiedLogPath = path.join(__dirname, "forest-units-log.json");
  const unifiedLog = {
    trees: batch,
    sawnTimbers: allTimbersLogs
  };
  fs.writeFileSync(unifiedLogPath, JSON.stringify(unifiedLog, null, 2));
  console.log(`💾 Log unificato salvato in ${unifiedLogPath}`);
}

main().catch((err) => {
  console.error("❌ Errore generale:", err);
  process.exit(1);
});
