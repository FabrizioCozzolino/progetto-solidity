const { ethers } = require("hardhat");

async function main() {
  const ForestTracking = await ethers.getContractFactory("ForestTracking");
  const c = await ForestTracking.deploy();
  await c.waitForDeployment();

  const addr = await c.getAddress();
  console.log("✅ ForestTracking deployed to:", addr);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});