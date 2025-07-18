// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract ForestTracking {
    address public owner;

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Solo proprietario puo' modificare");
        _;
    }

    struct Tree {
        bytes32 epcHash;         // hash EPC stringa
        uint256 firstReading;    // timestamp
        bytes32 treeTypeHash;    // hash tipo albero
        bytes32 coordHash;       // hash coordinate stringa
        bytes32 observationsHash;// hash note osservazioni
        bool exists;
    }

    struct WoodLog {
        bytes32 epcHash;
        uint256 firstReading;
        bytes32 treeEpcHash;     // link a Tree
        uint8 logSectionNumber;
        bytes32 observationsHash;
        bool exists;
    }

    struct SawnTimber {
        bytes32 epcHash;
        uint256 firstReading;
        bytes32 woodLogEpcHash;  // link a WoodLog
        bytes32 observationsHash;
        bool exists;
    }

    mapping(bytes32 => Tree) public trees;
    mapping(bytes32 => WoodLog) public woodLogs;
    mapping(bytes32 => SawnTimber) public sawnTimbers;

    // Eventi per tracciamento
    event TreeAdded(bytes32 epcHash);
    event WoodLogAdded(bytes32 epcHash);
    event SawnTimberAdded(bytes32 epcHash);

    // Funzioni di inserimento

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

    function addWoodLog(
        string calldata epc,
        uint256 firstReading,
        string calldata treeEpc,
        uint8 logSectionNumber,
        string calldata observations
    ) external onlyOwner {
        bytes32 epcHash = keccak256(bytes(epc));
        require(!woodLogs[epcHash].exists, "WoodLog gia' registrato");

        bytes32 treeEpcHash = keccak256(bytes(treeEpc));
        require(trees[treeEpcHash].exists, "Tree non esistente");

        woodLogs[epcHash] = WoodLog({
            epcHash: epcHash,
            firstReading: firstReading,
            treeEpcHash: treeEpcHash,
            logSectionNumber: logSectionNumber,
            observationsHash: keccak256(bytes(observations)),
            exists: true
        });

        emit WoodLogAdded(epcHash);
    }

    function addSawnTimber(
        string calldata epc,
        uint256 firstReading,
        string calldata woodLogEpc,
        string calldata observations
    ) external onlyOwner {
        bytes32 epcHash = keccak256(bytes(epc));
        require(!sawnTimbers[epcHash].exists, "SawnTimber gia' registrato");

        bytes32 woodLogEpcHash = keccak256(bytes(woodLogEpc));
        require(woodLogs[woodLogEpcHash].exists, "WoodLog non esistente");

        sawnTimbers[epcHash] = SawnTimber({
            epcHash: epcHash,
            firstReading: firstReading,
            woodLogEpcHash: woodLogEpcHash,
            observationsHash: keccak256(bytes(observations)),
            exists: true
        });

        emit SawnTimberAdded(epcHash);
    }

    // Funzioni di lettura (esempio per Tree)

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

        // Funzione di lettura per WoodLog
    function getWoodLog(string calldata epc) external view returns (
        uint256 firstReading,
        bytes32 treeEpcHash,
        uint8 logSectionNumber,
        bytes32 observationsHash
    ) {
        bytes32 epcHash = keccak256(bytes(epc));
        require(woodLogs[epcHash].exists, "WoodLog non trovato");

        WoodLog memory wl = woodLogs[epcHash];
        return (wl.firstReading, wl.treeEpcHash, wl.logSectionNumber, wl.observationsHash);
    }

    // Funzione di lettura per SawnTimber
    function getSawnTimber(string calldata epc) external view returns (
        uint256 firstReading,
        bytes32 woodLogEpcHash,
        bytes32 observationsHash
    ) {
        bytes32 epcHash = keccak256(bytes(epc));
        require(sawnTimbers[epcHash].exists, "SawnTimber non trovato");

        SawnTimber memory st = sawnTimbers[epcHash];
        return (st.firstReading, st.woodLogEpcHash, st.observationsHash);
    }
}