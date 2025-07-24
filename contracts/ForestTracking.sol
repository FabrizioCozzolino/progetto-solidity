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

    // --- Alberi ---
    bytes32 public merkleRootTrees;

    struct Tree {
        bytes32 epcHash;
        uint256 firstReading;
        bytes32 treeTypeHash;
        bytes32 coordHash;
        bytes32 observationsHash;
        bool exists;
    }

    mapping(bytes32 => Tree) private trees;
    bytes32[] private registeredEPCs;

    event TreeAdded(bytes32 epcHash);
    event MerkleRootTreesUpdated(bytes32 newRoot);
    event TreesBatchAdded(uint256 count);

    function setMerkleRootTrees(bytes32 _root) external onlyOwner {
        merkleRootTrees = _root;
        emit MerkleRootTreesUpdated(_root);
    }

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
        return computedHash == merkleRootTrees;
    }

    // --- Wood Logs ---
    bytes32 public merkleRootWoodLogs;

    struct WoodLog {
        bytes32 epcHash;
        uint256 firstReading;
        bytes32 treeTypeHash;
        uint256 logSectionNumber;
        bytes32 parentTreeEpcHash;
        bytes32 observationsHash;
        bool exists;
    }

    mapping(bytes32 => WoodLog) private woodLogs;
    bytes32[] private registeredWoodLogEPCs;

    event WoodLogAdded(bytes32 epcHash);
    event MerkleRootWoodLogsUpdated(bytes32 newRoot);
    event WoodLogsBatchAdded(uint256 count);

    function setMerkleRootWoodLogs(bytes32 _root) external onlyOwner {
        merkleRootWoodLogs = _root;
        emit MerkleRootWoodLogsUpdated(_root);
    }

    function verifyWoodLogProof(bytes32 leaf, bytes32[] calldata proof) public view returns (bool) {
        bytes32 computedHash = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 proofElement = proof[i];
            if (computedHash < proofElement) {
                computedHash = keccak256(abi.encodePacked(computedHash, proofElement));
            } else {
                computedHash = keccak256(abi.encodePacked(proofElement, computedHash));
            }
        }
        return computedHash == merkleRootWoodLogs;
    }

    function addWoodLog(
        string calldata epc,
        uint256 firstReading,
        string calldata treeType,
        uint256 logSectionNumber,
        string calldata parentTreeEpc,
        string calldata observations
    ) external onlyOwner {
        bytes32 epcHash = keccak256(bytes(epc));
        require(!woodLogs[epcHash].exists, "WoodLog gia' registrato");

        woodLogs[epcHash] = WoodLog({
            epcHash: epcHash,
            firstReading: firstReading,
            treeTypeHash: keccak256(bytes(treeType)),
            logSectionNumber: logSectionNumber,
            parentTreeEpcHash: keccak256(bytes(parentTreeEpc)),
            observationsHash: keccak256(bytes(observations)),
            exists: true
        });

        registeredWoodLogEPCs.push(epcHash);
        emit WoodLogAdded(epcHash);
    }

    struct WoodLogInput {
        string epc;
        uint256 firstReading;
        string treeType;
        uint256 logSectionNumber;
        string parentTreeEpc;
        string observations;
    }

    function addWoodLogsBatch(WoodLogInput[] calldata batch) external onlyOwner {
        uint256 count = 0;
        for (uint256 i = 0; i < batch.length; i++) {
            bytes32 epcHash = keccak256(bytes(batch[i].epc));
            if (!woodLogs[epcHash].exists) {
                woodLogs[epcHash] = WoodLog({
                    epcHash: epcHash,
                    firstReading: batch[i].firstReading,
                    treeTypeHash: keccak256(bytes(batch[i].treeType)),
                    logSectionNumber: batch[i].logSectionNumber,
                    parentTreeEpcHash: keccak256(bytes(batch[i].parentTreeEpc)),
                    observationsHash: keccak256(bytes(batch[i].observations)),
                    exists: true
                });
                registeredWoodLogEPCs.push(epcHash);
                emit WoodLogAdded(epcHash);
                count++;
            }
        }
        emit WoodLogsBatchAdded(count);
    }

    function getWoodLog(string calldata epc) external view returns (
        uint256 firstReading,
        bytes32 treeTypeHash,
        uint256 logSectionNumber,
        bytes32 parentTreeEpcHash,
        bytes32 observationsHash
    ) {
        bytes32 epcHash = keccak256(bytes(epc));
        require(woodLogs[epcHash].exists, "WoodLog non trovato");

        WoodLog memory wl = woodLogs[epcHash];
        return (
            wl.firstReading,
            wl.treeTypeHash,
            wl.logSectionNumber,
            wl.parentTreeEpcHash,
            wl.observationsHash
        );
    }

    function isWoodLogRegistered(string calldata epc) external view returns (bool) {
        bytes32 epcHash = keccak256(bytes(epc));
        return woodLogs[epcHash].exists;
    }

    function totalWoodLogs() external view returns (uint256) {
        return registeredWoodLogEPCs.length;
    }

    // --- Sawn Timbers ---
    bytes32 public merkleRootSawnTimbers;

    struct SawnTimber {
        bytes32 epcHash;
        uint256 firstReading;
        bytes32 treeTypeHash;
        bytes32 observationsHash;
        bool exists;
    }

    mapping(bytes32 => SawnTimber) private sawnTimbers;
    bytes32[] private registeredSawnTimberEPCs;

    event SawnTimberAdded(bytes32 epcHash);
    event MerkleRootSawnTimbersUpdated(bytes32 newRoot);
    event SawnTimbersBatchAdded(uint256 count);

    function setMerkleRootSawnTimbers(bytes32 _root) external onlyOwner {
        merkleRootSawnTimbers = _root;
        emit MerkleRootSawnTimbersUpdated(_root);
    }

    function verifySawnTimberProof(bytes32 leaf, bytes32[] calldata proof) public view returns (bool) {
        bytes32 computedHash = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 proofElement = proof[i];
            if (computedHash < proofElement) {
                computedHash = keccak256(abi.encodePacked(computedHash, proofElement));
            } else {
                computedHash = keccak256(abi.encodePacked(proofElement, computedHash));
            }
        }
        return computedHash == merkleRootSawnTimbers;
    }

    function addSawnTimber(
        string calldata epc,
        uint256 firstReading,
        string calldata treeType,
        string calldata observations
    ) external onlyOwner {
        bytes32 epcHash = keccak256(bytes(epc));
        require(!sawnTimbers[epcHash].exists, "SawnTimber gia' registrato");

        sawnTimbers[epcHash] = SawnTimber({
            epcHash: epcHash,
            firstReading: firstReading,
            treeTypeHash: keccak256(bytes(treeType)),
            observationsHash: keccak256(bytes(observations)),
            exists: true
        });

        registeredSawnTimberEPCs.push(epcHash);
        emit SawnTimberAdded(epcHash);
    }

    struct SawnTimberInput {
        string epc;
        uint256 firstReading;
        string treeType;
        string observations;
    }

    function addSawnTimbersBatch(SawnTimberInput[] calldata batch) external onlyOwner {
        uint256 count = 0;
        for (uint256 i = 0; i < batch.length; i++) {
            bytes32 epcHash = keccak256(bytes(batch[i].epc));
            if (!sawnTimbers[epcHash].exists) {
                sawnTimbers[epcHash] = SawnTimber({
                    epcHash: epcHash,
                    firstReading: batch[i].firstReading,
                    treeTypeHash: keccak256(bytes(batch[i].treeType)),
                    observationsHash: keccak256(bytes(batch[i].observations)),
                    exists: true
                });
                registeredSawnTimberEPCs.push(epcHash);
                emit SawnTimberAdded(epcHash);
                count++;
            }
        }
        emit SawnTimbersBatchAdded(count);
    }

    function getSawnTimber(string calldata epc) external view returns (
        uint256 firstReading,
        bytes32 treeTypeHash,
        bytes32 observationsHash
    ) {
        bytes32 epcHash = keccak256(bytes(epc));
        require(sawnTimbers[epcHash].exists, "SawnTimber non trovato");

        SawnTimber memory st = sawnTimbers[epcHash];
        return (st.firstReading, st.treeTypeHash, st.observationsHash);
    }

    function isSawnTimberRegistered(string calldata epc) external view returns (bool) {
        bytes32 epcHash = keccak256(bytes(epc));
        return sawnTimbers[epcHash].exists;
    }

    function totalSawnTimbers() external view returns (uint256) {
        return registeredSawnTimberEPCs.length;
    }

    // ✅ Nuove versioni con 3 argomenti
    function verifyTreeProofWithRoot(bytes32 leaf, bytes32[] calldata proof, bytes32 root) external pure returns (bool) {
        return MerkleProof.verifyCalldata(proof, root, leaf);
    }

    function verifyWoodLogProofWithRoot(bytes32 leaf, bytes32[] calldata proof, bytes32 root) external pure returns (bool) {
        return MerkleProof.verifyCalldata(proof, root, leaf);
    }

    function verifySawnTimberProofWithRoot(bytes32 leaf, bytes32[] calldata proof, bytes32 root) external pure returns (bool) {
        return MerkleProof.verifyCalldata(proof, root, leaf);
    }
}
