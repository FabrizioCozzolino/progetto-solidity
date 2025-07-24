const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { MerkleTree } = require("merkletreejs");
const keccak256 = require("keccak256");
const ethers = hre.ethers;

const deployedPath = path.join(__dirname, "../deployed.json");
const deployed = JSON.parse(fs.readFileSync(deployedPath));
const CONTRACT_ADDRESS = deployed.ForestTracking || deployed.address;

const API_URL = "https://pollicino.topview.it:9443/api/get-forest-units/";
const AUTH_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0b2tlbl90eXBlIjoiYWNjZXNzIiwiZXhwIjoxNzUzMzUxNzMyLCJpYXQiOjE3NTMzNDgxMzIsImp0aSI6IjY2YTIzNmFlNjY2YTRkN2ZhMDA0YzQ5NzJjODA3NzJiIiwidXNlcl9pZCI6MTEwfQ.hhtuCeyZBN6a2fJh0kF6vyNp6r8olhrfFz33FEN0We4";

function hashSawnTimber(st) {
  return keccak256(
    `${st.epc}|${st.firstReading}|${st.treeType}|${st.observations}`
  );
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

async function main() {
  console.log("=== SCRIPT SAWN TIMBERS ===");

  const signer = (await ethers.getSigners())[0];
  console.log("👤 Signer:", signer.address);

  const contractJson = require("../artifacts/contracts/ForestTracking.sol/ForestTracking.json");
  const contract = new ethers.Contract(CONTRACT_ADDRESS, contractJson.abi, signer);

  // Fetch forest units
  const res = await axios.get(API_URL, {
    headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
  });

  const forestUnits = res.data.forestUnits;
  const forestKey = Object.keys(forestUnits).find(
    (k) =>
      k.toLowerCase() === "vallombrosa" ||
      forestUnits[k].name?.toLowerCase().includes("vallombrosa")
  );
  if (!forestKey) throw new Error("⚠️ Nessuna forest unit 'Vallombrosa' trovata.");

  const sawnTimbers = [];

  for (const tree of Object.values(forestUnits[forestKey].trees || {})) {
    if (!tree.woodLogs) continue;
    for (const woodLog of Object.values(tree.woodLogs)) {
      const list = woodLog.sawnTimbers || {};
      for (const st of Object.values(list)) {
        const epc = st.epc || st.id || "";
        const firstReading = st.firstReadingTime
          ? Math.floor(new Date(st.firstReadingTime).getTime() / 1000)
          : 0;
        const treeType = tree.treeType?.specie || "";
        const observations = (st.observations || [])
          .map(
            (o) =>
              `${o.phenomenonType?.phenomenonTypeName || ""}: ${o.quantity} ${
                o.unit?.unitName || ""
              }`
          )
          .join("; ");

        sawnTimbers.push({
          epc,
          firstReading,
          treeType,
          observations,
        });
      }
    }
  }

  console.log(`✅ Trovati sawn timbers: ${sawnTimbers.length}`);
  if (sawnTimbers.length === 0) return;

  // Calcola Merkle Tree e root
  const leaves = sawnTimbers.map(hashSawnTimber);
  const tree = new MerkleTree(leaves, keccak256, { sortPairs: true });
  const root = tree.getHexRoot();

  console.log("🌲 Merkle root sawn timbers:", root);

  if (contract.interface && Array.isArray(contract.interface.fragments)) {
    const funcs = contract.interface.fragments
      .filter(f => f.type === "function")
      .map(f => f.name);
    console.log("📋 Funzioni disponibili:", funcs);
  } else {
    console.warn("⚠️ contract.interface.fragments non definito o non un array");
  }

  // Stima gas e costo
  const gasEstimate = await hre.ethers.provider.estimateGas({
  to: CONTRACT_ADDRESS,
  data: contract.interface.encodeFunctionData("setMerkleRootSawnTimbers", [root]),
  from: await signer.getAddress(),
});

const feeData = await hre.ethers.provider.getFeeData();
const gasPrice = feeData.gasPrice;

if (!gasPrice) {
  throw new Error("Gas price non disponibile dal provider");
}

// ethers v6 usa bigint
const gasCostWei = gasEstimate * gasPrice;
const gasCostEth = Number(hre.ethers.formatEther(gasCostWei.toString()));
const ethEur = await getEthPriceInEuro();

console.log(`💰 Costo stimato: ${gasCostEth.toFixed(6)} ETH ≈ €${(gasCostEth * ethEur).toFixed(2)}`);


  // Invia tx
  const tx = await contract.setMerkleRootSawnTimbers(root);
const receipt = await tx.wait();


  const actualGasCostWei = receipt.gasUsed * gasPrice;
const actualEth = Number(hre.ethers.formatEther(actualGasCostWei.toString()));


  console.log("✅ Merkle root aggiornata.");
  console.log(`⛽ Gas usato: ${receipt.gasUsed.toString()}`);
  console.log(`💸 Costo reale: ${actualEth.toFixed(6)} ETH ≈ €${(actualEth * ethEur).toFixed(2)}`);

  // Salvataggio su file
  const outPath = path.join(__dirname, "sawn-timbers-batch.json");
  fs.writeFileSync(outPath, JSON.stringify(sawnTimbers, null, 2));
  console.log(`💾 Log salvato in ${outPath}`);
}

main().catch(console.error);
