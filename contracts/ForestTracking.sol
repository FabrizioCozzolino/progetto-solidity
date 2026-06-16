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
        string ricardianUri;
        string pdfUri;
        uint256 timestamp;
    }

    mapping(string => RicardianForestContract) public forestRicardians;

    event RicardianForestRegistered(
        string forestUnitKey,
        bytes32 ricardianHash,
        bytes32 merkleRoot,
        string ricardianUri,
        uint256 timestamp
    );

    event RicardianPdfUriUpdated(
        string forestUnitKey,
        string pdfUri,
        uint256 timestamp
    );

    function registerRicardianForest(
        string memory forestUnitKey,
        bytes32 ricardianHash,
        bytes32 merkleRoot,
        string memory ricardianUri
    ) external onlyOwner {
        forestRicardians[forestUnitKey].ricardianHash = ricardianHash;
        forestRicardians[forestUnitKey].merkleRoot = merkleRoot;
        forestRicardians[forestUnitKey].ricardianUri = ricardianUri;
        forestRicardians[forestUnitKey].timestamp = block.timestamp;

        emit RicardianForestRegistered(
            forestUnitKey,
            ricardianHash,
            merkleRoot,
            ricardianUri,
            block.timestamp
        );
    }

    function setRicardianPdfUri(
        string memory forestUnitKey,
        string memory pdfUri
    ) external onlyOwner {
        require(
            forestRicardians[forestUnitKey].ricardianHash != bytes32(0),
            "Ricardian non registrato"
        );

        forestRicardians[forestUnitKey].pdfUri = pdfUri;
        forestRicardians[forestUnitKey].timestamp = block.timestamp;

        emit RicardianPdfUriUpdated(
            forestUnitKey,
            pdfUri,
            block.timestamp
        );
    }

    function getRicardianForest(
        string memory forestUnitKey
    )
        external
        view
        returns (
            bytes32 ricardianHash,
            bytes32 merkleRoot,
            string memory ricardianUri,
            string memory pdfUri,
            uint256 timestamp
        )
    {
        RicardianForestContract memory data = forestRicardians[forestUnitKey];
        return (
            data.ricardianHash,
            data.merkleRoot,
            data.ricardianUri,
            data.pdfUri,
            data.timestamp
        );
    }

    // =================================================
    // ===== USER CAdES COUNTERSIGNATURE SECTION =======
    // =================================================

    struct RicardianUserCountersignature {
        bool exists;
        bytes32 pdfHash;
        bytes32 cadesHash;
        string cadesUri;
        string signerCommonName;
        string signerSerialNumber;
        uint256 signedAt;
        uint256 recordedAt;
        bool validOffchain;
    }

    mapping(string => RicardianUserCountersignature)
        public ricardianUserCountersignatures;

    event RicardianUserCountersigned(
        string forestUnitKey,
        bytes32 indexed ricardianHash,
        bytes32 indexed pdfHash,
        bytes32 indexed cadesHash,
        string cadesUri,
        string signerCommonName,
        string signerSerialNumber,
        uint256 signedAt,
        uint256 recordedAt,
        bool validOffchain
    );

    function registerUserCountersignature(
        string memory forestUnitKey,
        bytes32 pdfHash,
        bytes32 cadesHash,
        string memory cadesUri,
        string memory signerCommonName,
        string memory signerSerialNumber,
        uint256 signedAt,
        bool validOffchain
    ) external onlyOwner {
        require(
            forestRicardians[forestUnitKey].ricardianHash != bytes32(0),
            "Ricardian non registrato"
        );
        require(
            bytes(forestRicardians[forestUnitKey].pdfUri).length > 0,
            "PDF URI non registrato"
        );

        ricardianUserCountersignatures[
            forestUnitKey
        ] = RicardianUserCountersignature({
            exists: true,
            pdfHash: pdfHash,
            cadesHash: cadesHash,
            cadesUri: cadesUri,
            signerCommonName: signerCommonName,
            signerSerialNumber: signerSerialNumber,
            signedAt: signedAt,
            recordedAt: block.timestamp,
            validOffchain: validOffchain
        });

        emit RicardianUserCountersigned(
            forestUnitKey,
            forestRicardians[forestUnitKey].ricardianHash,
            pdfHash,
            cadesHash,
            cadesUri,
            signerCommonName,
            signerSerialNumber,
            signedAt,
            block.timestamp,
            validOffchain
        );
    }

    function getUserCountersignature(
        string memory forestUnitKey
    )
        external
        view
        returns (
            bool exists,
            bytes32 pdfHash,
            bytes32 cadesHash,
            string memory cadesUri,
            string memory signerCommonName,
            string memory signerSerialNumber,
            uint256 signedAt,
            uint256 recordedAt,
            bool validOffchain
        )
    {
        RicardianUserCountersignature memory data = ricardianUserCountersignatures[
            forestUnitKey
        ];

        return (
            data.exists,
            data.pdfHash,
            data.cadesHash,
            data.cadesUri,
            data.signerCommonName,
            data.signerSerialNumber,
            data.signedAt,
            data.recordedAt,
            data.validOffchain
        );
    }

    // ---------------------------------------------------------------
    // CONTROFIRMA DEL CLIENTE (firma annidata .p7m.p7m sopra il p7m)
    // Secondo slot on-chain, distinto dalla firma del firmatario.
    // Prerequisito: la firma del firmatario (registerUserCountersignature)
    // deve gia' esistere per questa forestUnitKey.
    // ---------------------------------------------------------------
    struct RicardianClientCountersignature {
        bool exists;
        bytes32 innerCadesHash;   // hash del .p7m del firmatario (payload firmato dal cliente)
        bytes32 clientCadesHash;  // hash del .p7m.p7m prodotto dal cliente
        string clientCadesUri;
        string signerCommonName;
        string signerSerialNumber;
        uint256 signedAt;
        uint256 recordedAt;
        bool validOffchain;
    }

    mapping(string => RicardianClientCountersignature)
        public ricardianClientCountersignatures;

    event RicardianClientCountersigned(
        string forestUnitKey,
        bytes32 indexed innerCadesHash,
        bytes32 indexed clientCadesHash,
        string clientCadesUri,
        string signerCommonName,
        string signerSerialNumber,
        uint256 signedAt,
        uint256 recordedAt,
        bool validOffchain
    );

    function registerClientCountersignature(
        string memory forestUnitKey,
        bytes32 innerCadesHash,
        bytes32 clientCadesHash,
        string memory clientCadesUri,
        string memory signerCommonName,
        string memory signerSerialNumber,
        uint256 signedAt,
        bool validOffchain
    ) external onlyOwner {
        require(
            forestRicardians[forestUnitKey].ricardianHash != bytes32(0),
            "Ricardian non registrato"
        );
        require(
            ricardianUserCountersignatures[forestUnitKey].exists,
            "Firma del firmatario non registrata"
        );
        require(
            ricardianUserCountersignatures[forestUnitKey].cadesHash == innerCadesHash,
            "innerCadesHash non coincide con la firma del firmatario"
        );

        ricardianClientCountersignatures[
            forestUnitKey
        ] = RicardianClientCountersignature({
            exists: true,
            innerCadesHash: innerCadesHash,
            clientCadesHash: clientCadesHash,
            clientCadesUri: clientCadesUri,
            signerCommonName: signerCommonName,
            signerSerialNumber: signerSerialNumber,
            signedAt: signedAt,
            recordedAt: block.timestamp,
            validOffchain: validOffchain
        });

        emit RicardianClientCountersigned(
            forestUnitKey,
            innerCadesHash,
            clientCadesHash,
            clientCadesUri,
            signerCommonName,
            signerSerialNumber,
            signedAt,
            block.timestamp,
            validOffchain
        );
    }

    function getClientCountersignature(
        string memory forestUnitKey
    )
        external
        view
        returns (
            bool exists,
            bytes32 innerCadesHash,
            bytes32 clientCadesHash,
            string memory clientCadesUri,
            string memory signerCommonName,
            string memory signerSerialNumber,
            uint256 signedAt,
            uint256 recordedAt,
            bool validOffchain
        )
    {
        RicardianClientCountersignature memory data = ricardianClientCountersignatures[
            forestUnitKey
        ];

        return (
            data.exists,
            data.innerCadesHash,
            data.clientCadesHash,
            data.clientCadesUri,
            data.signerCommonName,
            data.signerSerialNumber,
            data.signedAt,
            data.recordedAt,
            data.validOffchain
        );
    }
}