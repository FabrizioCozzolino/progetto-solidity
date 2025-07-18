import hre from "hardhat";

async function main() {
  await hre.run('compile');

  const ForestTracking = await hre.ethers.getContractFactory("ForestTracking");

  // In ethers v6 deploy() restituisce il contratto deployato, non serve .deployed()
  const forestTracking = await ForestTracking.deploy();

  // Attendi il mining della transazione di deploy
  await forestTracking.waitForDeployment();

  console.log("✅ ForestTracking deployato a:", forestTracking.target);
}

main().catch((error) => {
  console.error("❌ Errore nel deploy:", error);
  process.exitCode = 1;
});
