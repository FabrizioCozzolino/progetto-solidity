const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  // ✅ Recupera il provider locale
  const provider = new hre.ethers.JsonRpcProvider("http://127.0.0.1:8545");

  // ✅ Recupera i signer locali (account simulati di Hardhat)
  const [signer] = await hre.ethers.getSigners();

  // ✅ Carica ABI e indirizzo del contratto
  const artifactPath = path.join(__dirname, "../artifacts/contracts/ForestTracking.sol/ForestTracking.json");
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));

  const contractAddress = "0x5FbDB2315678afecb367f032d93F642f64180aa3"; // usa l'indirizzo corretto del tuo contratto
  const contract = new hre.ethers.Contract(contractAddress, artifact.abi, signer);

  // ✅ Chiama funzioni del contratto (esempi)
  const tx = await contract.registerTree("Pioppo", "40.7128N, 74.0060W", "INFO");
  await tx.wait();
  console.log("🌳 Albero registrato!");

  const trees = await contract.getAllTrees();
  console.log("🌲 Tutti gli alberi registrati:");
  console.log(trees);
}

main().catch((error) => {
  console.error("❌ Errore:", error);
  process.exit(1);
});

const abi = [
    {
      "inputs": [],
      "stateMutability": "nonpayable",
      "type": "constructor"
    },
    {
      "anonymous": false,
      "inputs": [
        {
          "indexed": false,
          "internalType": "bytes32",
          "name": "epcHash",
          "type": "bytes32"
        }
      ],
      "name": "SawnTimberAdded",
      "type": "event"
    },
    {
      "anonymous": false,
      "inputs": [
        {
          "indexed": false,
          "internalType": "bytes32",
          "name": "epcHash",
          "type": "bytes32"
        }
      ],
      "name": "TreeAdded",
      "type": "event"
    },
    {
      "anonymous": false,
      "inputs": [
        {
          "indexed": false,
          "internalType": "bytes32",
          "name": "epcHash",
          "type": "bytes32"
        }
      ],
      "name": "WoodLogAdded",
      "type": "event"
    },
    {
      "inputs": [
        {
          "internalType": "string",
          "name": "epc",
          "type": "string"
        },
        {
          "internalType": "uint256",
          "name": "firstReading",
          "type": "uint256"
        },
        {
          "internalType": "string",
          "name": "woodLogEpc",
          "type": "string"
        },
        {
          "internalType": "string",
          "name": "observations",
          "type": "string"
        }
      ],
      "name": "addSawnTimber",
      "outputs": [],
      "stateMutability": "nonpayable",
      "type": "function"
    },
    {
      "inputs": [
        {
          "internalType": "string",
          "name": "epc",
          "type": "string"
        },
        {
          "internalType": "uint256",
          "name": "firstReading",
          "type": "uint256"
        },
        {
          "internalType": "string",
          "name": "treeType",
          "type": "string"
        },
        {
          "internalType": "string",
          "name": "coordinates",
          "type": "string"
        },
        {
          "internalType": "string",
          "name": "observations",
          "type": "string"
        }
      ],
      "name": "addTree",
      "outputs": [],
      "stateMutability": "nonpayable",
      "type": "function"
    },
    {
      "inputs": [
        {
          "internalType": "string",
          "name": "epc",
          "type": "string"
        },
        {
          "internalType": "uint256",
          "name": "firstReading",
          "type": "uint256"
        },
        {
          "internalType": "string",
          "name": "treeEpc",
          "type": "string"
        },
        {
          "internalType": "uint8",
          "name": "logSectionNumber",
          "type": "uint8"
        },
        {
          "internalType": "string",
          "name": "observations",
          "type": "string"
        }
      ],
      "name": "addWoodLog",
      "outputs": [],
      "stateMutability": "nonpayable",
      "type": "function"
    },
    {
      "inputs": [
        {
          "internalType": "string",
          "name": "epc",
          "type": "string"
        }
      ],
      "name": "getSawnTimber",
      "outputs": [
        {
          "internalType": "uint256",
          "name": "firstReading",
          "type": "uint256"
        },
        {
          "internalType": "bytes32",
          "name": "woodLogEpcHash",
          "type": "bytes32"
        },
        {
          "internalType": "bytes32",
          "name": "observationsHash",
          "type": "bytes32"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    },
    {
      "inputs": [
        {
          "internalType": "string",
          "name": "epc",
          "type": "string"
        }
      ],
      "name": "getTree",
      "outputs": [
        {
          "internalType": "uint256",
          "name": "firstReading",
          "type": "uint256"
        },
        {
          "internalType": "bytes32",
          "name": "treeTypeHash",
          "type": "bytes32"
        },
        {
          "internalType": "bytes32",
          "name": "coordHash",
          "type": "bytes32"
        },
        {
          "internalType": "bytes32",
          "name": "observationsHash",
          "type": "bytes32"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    },
    {
      "inputs": [
        {
          "internalType": "string",
          "name": "epc",
          "type": "string"
        }
      ],
      "name": "getWoodLog",
      "outputs": [
        {
          "internalType": "uint256",
          "name": "firstReading",
          "type": "uint256"
        },
        {
          "internalType": "bytes32",
          "name": "treeEpcHash",
          "type": "bytes32"
        },
        {
          "internalType": "uint8",
          "name": "logSectionNumber",
          "type": "uint8"
        },
        {
          "internalType": "bytes32",
          "name": "observationsHash",
          "type": "bytes32"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    },
    {
      "inputs": [],
      "name": "owner",
      "outputs": [
        {
          "internalType": "address",
          "name": "",
          "type": "address"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    },
    {
      "inputs": [
        {
          "internalType": "bytes32",
          "name": "",
          "type": "bytes32"
        }
      ],
      "name": "sawnTimbers",
      "outputs": [
        {
          "internalType": "bytes32",
          "name": "epcHash",
          "type": "bytes32"
        },
        {
          "internalType": "uint256",
          "name": "firstReading",
          "type": "uint256"
        },
        {
          "internalType": "bytes32",
          "name": "woodLogEpcHash",
          "type": "bytes32"
        },
        {
          "internalType": "bytes32",
          "name": "observationsHash",
          "type": "bytes32"
        },
        {
          "internalType": "bool",
          "name": "exists",
          "type": "bool"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    },
    {
      "inputs": [
        {
          "internalType": "bytes32",
          "name": "",
          "type": "bytes32"
        }
      ],
      "name": "trees",
      "outputs": [
        {
          "internalType": "bytes32",
          "name": "epcHash",
          "type": "bytes32"
        },
        {
          "internalType": "uint256",
          "name": "firstReading",
          "type": "uint256"
        },
        {
          "internalType": "bytes32",
          "name": "treeTypeHash",
          "type": "bytes32"
        },
        {
          "internalType": "bytes32",
          "name": "coordHash",
          "type": "bytes32"
        },
        {
          "internalType": "bytes32",
          "name": "observationsHash",
          "type": "bytes32"
        },
        {
          "internalType": "bool",
          "name": "exists",
          "type": "bool"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    },
    {
      "inputs": [
        {
          "internalType": "bytes32",
          "name": "",
          "type": "bytes32"
        }
      ],
      "name": "woodLogs",
      "outputs": [
        {
          "internalType": "bytes32",
          "name": "epcHash",
          "type": "bytes32"
        },
        {
          "internalType": "uint256",
          "name": "firstReading",
          "type": "uint256"
        },
        {
          "internalType": "bytes32",
          "name": "treeEpcHash",
          "type": "bytes32"
        },
        {
          "internalType": "uint8",
          "name": "logSectionNumber",
          "type": "uint8"
        },
        {
          "internalType": "bytes32",
          "name": "observationsHash",
          "type": "bytes32"
        },
        {
          "internalType": "bool",
          "name": "exists",
          "type": "bool"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    }
  ];// incolla ABI