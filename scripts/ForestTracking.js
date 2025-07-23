const hre = require("hardhat");

async function main() {
  const ForestTracking = await hre.ethers.getContractFactory("ForestTracking");
  const contract = await ForestTracking.deploy();
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log("ForestTracking deployed at:", address);

  const fs = require("fs");
  fs.writeFileSync("deployed.json", JSON.stringify({ ForestTracking: address }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
