// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

// TODO: Add access control
// TODO: Add handy getters

contract Bitacora {

    event NewDevice(string indexed id, bytes32 publicKey);
    event NewDataset(string indexed id, string indexed deviceId, bytes32 merkleRoot);

    error DatasetAlreadyRegistered(string);
    error DeviceNotRegistered(string);
    error DeviceAlreadyRegistered(string);
    error EmptyStringNotAllowed();
    error EmptyMerkleRootNotAllowed();

    struct Device {
        string id;
        bytes32 pk;
        mapping(string => bytes32) datasets;
    }

    mapping(string => Device) public devices;

    function registerDevice(string calldata _id, bytes32 _pk) external {
        if (bytes(_id).length == 0)
            revert EmptyStringNotAllowed();
        if (bytes(devices[_id].id).length > 0)
            revert DeviceAlreadyRegistered(_id);
        Device storage device = devices[_id];
        device.id = _id;
        device.pk = _pk;
        emit NewDevice(_id, _pk);
    }

    function registerDataset(string calldata _id, string calldata _deviceId, bytes32 _merkleRoot) external {
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
        emit NewDataset(_id, _deviceId, _merkleRoot);
    }

    function getDataset(string calldata _id, string calldata _deviceId) external view returns(bytes32) {
        return devices[_deviceId].datasets[_id];
    }
}