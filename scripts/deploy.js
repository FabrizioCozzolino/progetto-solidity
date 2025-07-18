const hre = require("hardhat");

async function main() {
  const Hello = await hre.ethers.getContractFactory("Hello");
  const hello = await Hello.deploy("Ciao mondo!"); // deploy

  // In ethers v6 il deploy attende automaticamente il completamento
  // Quindi non serve await hello.deployTransaction.wait();

  console.log("Contract deployed to:", hello.target);  // in ethers v6 si usa .target per l'indirizzo
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
