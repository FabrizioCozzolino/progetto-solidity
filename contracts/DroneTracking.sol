// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

contract Bitacora {

    event NewDevice(string indexed id, bytes32 publicKey);
    event NewDataset(string indexed id, string indexed deviceId, bytes32 merkleRoot);

    error DatasetAlreadyRegistered(string);
    error DeviceNotRegistered(string);
    error DeviceAlreadyRegistered(string);
    error EmptyStringNotAllowed();
    error EmptyMerkleRootNotAllowed();

    address public owner;

    struct Device {
        string id;
        bytes32 pk;
        mapping(string => bytes32) datasets;
        string[] datasetIds;
    }

    mapping(string => Device) private devices;

    modifier onlyOwner() {
        require(msg.sender == owner, "Not authorized");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function registerDevice(string calldata _id, bytes32 _pk) external onlyOwner {
        if (bytes(_id).length == 0)
            revert EmptyStringNotAllowed();
        if (bytes(devices[_id].id).length > 0)
            revert DeviceAlreadyRegistered(_id);
        Device storage device = devices[_id];
        device.id = _id;
        device.pk = _pk;
        emit NewDevice(_id, _pk);
    }

    function registerDataset(string calldata _id, string calldata _deviceId, bytes32 _merkleRoot) external onlyOwner {
        if (bytes(_id).length == 0)
            revert EmptyStringNotAllowed();
        if (_merkleRoot == 0)
            revert EmptyMerkleRootNotAllowed();
        Device storage device = devices[_deviceId];
        if (bytes(device.id).length == 0)
            revert DeviceNotRegistered(_deviceId);
        if (device.datasets[_id] != 0)
            revert DatasetAlreadyRegistered(_id);
        device.datasets[_id] = _merkleRoot;
        device.datasetIds.push(_id);
        emit NewDataset(_id, _deviceId, _merkleRoot);
    }

    function getDataset(string calldata _id, string calldata _deviceId) external view returns(bytes32) {
        return devices[_deviceId].datasets[_id];
    }

    function getDevice(string calldata _id) external view returns (string memory, bytes32) {
        Device storage device = devices[_id];
        require(bytes(device.id).length != 0, "Device not found");
        return (device.id, device.pk);
    }

    function getAllDatasetIds(string calldata _deviceId) external view returns (string[] memory) {
        return devices[_deviceId].datasetIds;
    }
}
