const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const ForestTracking = await hre.ethers.getContractFactory("ForestTracking");
  const forestTracking = await ForestTracking.deploy();
  await forestTracking.waitForDeployment();

  const address = forestTracking.target;
  console.log("ForestTracking deployed at:", address);

  // Salva l'indirizzo in un file
  const outputPath = path.join(__dirname, "../deployed.json");
  fs.writeFileSync(outputPath, JSON.stringify({ ForestTracking: address }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
