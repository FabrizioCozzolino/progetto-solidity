// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract ForestTracking {
    // Merkle root per batch di alberi
    bytes32 public merkleRoot;

    event MerkleRootUpdated(bytes32 newRoot);

    // Solo owner può aggiornare il Merkle root
    function setMerkleRoot(bytes32 _root) external onlyOwner {
        merkleRoot = _root;
        emit MerkleRootUpdated(_root);
    }

    // Verifica Merkle proof per un albero (foglia = hash dei dati dell'albero)
    function verifyTreeProof(bytes32 leaf, bytes32[] calldata proof) public view returns (bool) {
        bytes32 computedHash = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 proofElement = proof[i];
            if (computedHash < proofElement) {
                computedHash = keccak256(abi.encodePacked(computedHash, proofElement));
            } else {
                computedHash = keccak256(abi.encodePacked(proofElement, computedHash));
            }
        }
        return computedHash == merkleRoot;
    }
    address public owner;

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Solo proprietario puo' modificare");
        _;
    }

    struct Tree {
        bytes32 epcHash;
        uint256 firstReading;
        bytes32 treeTypeHash;
        bytes32 coordHash;
        bytes32 observationsHash;
        bool exists;
    }

    mapping(bytes32 => Tree) public trees;

    event TreeAdded(bytes32 epcHash);
    event TreesBatchAdded(uint256 count);

    function addTree(
        string calldata epc,
        uint256 firstReading,
        string calldata treeType,
        string calldata coordinates,
        string calldata observations
    ) external onlyOwner {
        bytes32 epcHash = keccak256(bytes(epc));
        require(!trees[epcHash].exists, "Albero gia' registrato");

        trees[epcHash] = Tree({
            epcHash: epcHash,
            firstReading: firstReading,
            treeTypeHash: keccak256(bytes(treeType)),
            coordHash: keccak256(bytes(coordinates)),
            observationsHash: keccak256(bytes(observations)),
            exists: true
        });

        emit TreeAdded(epcHash);
    }

    // STRUCT PER BATCH
    struct TreeInput {
        string epc;
        uint256 firstReading;
        string treeType;
        string coordinates;
        string observations;
    }

    function addTreesBatch(TreeInput[] calldata batch) external onlyOwner {
        uint256 count = 0;
        for (uint256 i = 0; i < batch.length; i++) {
            bytes32 epcHash = keccak256(bytes(batch[i].epc));
            if (!trees[epcHash].exists) {
                trees[epcHash] = Tree({
                    epcHash: epcHash,
                    firstReading: batch[i].firstReading,
                    treeTypeHash: keccak256(bytes(batch[i].treeType)),
                    coordHash: keccak256(bytes(batch[i].coordinates)),
                    observationsHash: keccak256(bytes(batch[i].observations)),
                    exists: true
                });
                emit TreeAdded(epcHash);
                count++;
            }
        }
        emit TreesBatchAdded(count);
    }

    function getTree(string calldata epc) external view returns (
        uint256 firstReading,
        bytes32 treeTypeHash,
        bytes32 coordHash,
        bytes32 observationsHash
    ) {
        bytes32 epcHash = keccak256(bytes(epc));
        require(trees[epcHash].exists, "Tree non trovato");

        Tree memory t = trees[epcHash];
        return (t.firstReading, t.treeTypeHash, t.coordHash, t.observationsHash);
    }
}