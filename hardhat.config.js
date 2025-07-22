import "@nomicfoundation/hardhat-toolbox";

export default {
  solidity: "0.8.20",
  networks: {
    hardhat: {},
    localhost: {
      url: "http://127.0.0.1:8545",  // Porta standard usata da `npx hardhat node`
      chainId: 31337,                // Chain ID predefinito della rete Hardhat
    },
  },
};
