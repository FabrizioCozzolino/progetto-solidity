// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

contract ForestTracking {
    address public owner;

    modifier onlyOwner() {
        require(msg.sender == owner, "Solo proprietario puo' modificare");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    // --- Merkle root unificata ---
    bytes32 public merkleRootUnified;
    event MerkleRootUnifiedUpdated(bytes32 newRoot);

    function setMerkleRootUnified(bytes32 _root) external onlyOwner {
        merkleRootUnified = _root;
        emit MerkleRootUnifiedUpdated(_root);
    }

    function verifyUnifiedProof(
        bytes32 leaf,
        bytes32[] calldata proof
    ) public view returns (bool) {
        bytes32 computedHash = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 proofElement = proof[i];
            if (computedHash < proofElement) {
                computedHash = keccak256(
                    abi.encodePacked(computedHash, proofElement)
                );
            } else {
                computedHash = keccak256(
                    abi.encodePacked(proofElement, computedHash)
                );
            }
        }
        return computedHash == merkleRootUnified;
    }

    function verifyUnifiedProofWithRoot(
        bytes32 leaf,
        bytes32[] calldata proof,
        bytes32 root
    ) external pure returns (bool) {
        return MerkleProof.verifyCalldata(proof, root, leaf);
    }

    // --- Merkle root specifica per i wood logs ---
    bytes32 public merkleRootWoodLogs;
    event MerkleRootWoodLogsUpdated(bytes32 newRoot);

    function setMerkleRootWoodLogs(bytes32 _root) external onlyOwner {
        merkleRootWoodLogs = _root;
        emit MerkleRootWoodLogsUpdated(_root);
    }

    function verifyWoodLogProof(
        bytes32 leaf,
        bytes32[] calldata proof
    ) external view returns (bool) {
        return MerkleProof.verifyCalldata(
            proof,
            merkleRootWoodLogs,
            leaf
        );
    }

    // --- Dati forestali ---
    struct ForestData {
        bytes32 merkleRoot;
        string ipfsHash;
        uint256 timestamp;
    }

    mapping(string => ForestData) public forestRegistry;

    event ForestDataRegistered(
        string forestUnitKey,
        bytes32 merkleRoot,
        string ipfsHash,
        uint256 timestamp
    );

    function registerForestData(
        string memory forestUnitKey,
        bytes32 merkleRoot,
        string memory ipfsHash
    ) external onlyOwner {
        forestRegistry[forestUnitKey] = ForestData({
            merkleRoot: merkleRoot,
            ipfsHash: ipfsHash,
            timestamp: block.timestamp
        });

        emit ForestDataRegistered(
            forestUnitKey,
            merkleRoot,
            ipfsHash,
            block.timestamp
        );
    }

    function getForestData(
        string memory forestUnitKey
    ) external view returns (bytes32, string memory, uint256) {
        ForestData memory data = forestRegistry[forestUnitKey];
        return (data.merkleRoot, data.ipfsHash, data.timestamp);
    }

    // =================================================
    // ========== RICARDIAN CONTRACT SECTION ===========
    // =================================================

    struct RicardianForestContract {
        bytes32 ricardianHash;
        bytes32 merkleRoot;
        string ipfsHash;
        uint256 timestamp;
    }

    mapping(string => RicardianForestContract) public forestRicardians;

    event RicardianForestRegistered(
        string forestUnitKey,
        bytes32 ricardianHash,
        bytes32 merkleRoot,
        string ipfsHash,
        uint256 timestamp
    );

    function registerRicardianForest(
        string memory forestUnitKey,
        bytes32 ricardianHash,
        bytes32 merkleRoot,
        string memory ipfsHash
    ) external onlyOwner {
        forestRicardians[forestUnitKey] = RicardianForestContract({
            ricardianHash: ricardianHash,
            merkleRoot: merkleRoot,
            ipfsHash: ipfsHash,
            timestamp: block.timestamp
        });

        emit RicardianForestRegistered(
            forestUnitKey,
            ricardianHash,
            merkleRoot,
            ipfsHash,
            block.timestamp
        );
    }
}