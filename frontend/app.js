window.addEventListener("DOMContentLoaded", () => {
    const button = document.getElementById("registerButton");

    button.addEventListener("click", async () => {
        console.log("Hai cliccato sul bottone Registra Albero!");

        const species = document.getElementById("speciesInput").value;
        const age = parseInt(document.getElementById("ageInput").value);

        if (!species || isNaN(age)) {
            alert("Inserisci specie ed età valida");
            return;
        }

        try {
            await window.ethereum.request({ method: "eth_requestAccounts" });

            const provider = new ethers.providers.Web3Provider(window.ethereum);
            const signer = provider.getSigner();

            const contractAddress = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
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

            const contract = new ethers.Contract(contractAddress, contractABI, signer);
            const tx = await contract.registerTree(species, age);
            await tx.wait();

            alert("Albero registrato!");
        } catch (err) {
            console.error(err);
            alert("Errore durante la registrazione.");
        }
    });
});
