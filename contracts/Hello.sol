// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Hello {
    string private _message;
    address public owner;
    uint8 public constant MAX_LEN = 100;

    // Evento senza indexed per stringhe, indexed solo per address
    event MessageUpdated(string oldMessage, string newMessage, address indexed updatedBy);

    constructor(string memory initialMessage) {
        require(bytes(initialMessage).length <= MAX_LEN, "Messaggio iniziale troppo lungo");
        _message = initialMessage;
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Solo il proprietario puo' cambiare il messaggio");
        _;
    }

    function setMessage(string calldata newMessage) external onlyOwner {
        require(bytes(newMessage).length > 0, "Il messaggio non puo' essere vuoto");
        require(bytes(newMessage).length <= MAX_LEN, "Messaggio oltre i 100 caratteri");

        string memory old = _message;
        _message = newMessage;

        emit MessageUpdated(old, newMessage, msg.sender);
    }

    function getMessage() external view returns (string memory) {
        return _message;
    }
}
