const hre = require("hardhat");
const fs = require("fs");

async function main() {
  await hre.run('compile');

  const Bitacora = await hre.ethers.getContractFactory("Bitacora");
  const bitacora = await Bitacora.deploy();

  await bitacora.waitForDeployment();

  const address = await bitacora.getAddress();
  console.log("Bitacora deployed at:", address);

  fs.writeFileSync("deployed.json", JSON.stringify({ Bitacora: address }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error("Errore nel deploy:", error);
    process.exit(1);
  });
