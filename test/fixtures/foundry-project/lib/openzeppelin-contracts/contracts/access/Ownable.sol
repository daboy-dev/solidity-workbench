// SPDX-License-Identifier: MIT
// Minimal fake of OpenZeppelin Contracts for tests.
pragma solidity ^0.8.20;

import {Context} from "../utils/Context.sol";

abstract contract Ownable is Context {
    address private _owner;

    error OwnableUnauthorizedAccount(address account);

    constructor(address initialOwner) {
        _owner = initialOwner;
    }

    modifier onlyOwner() {
        if (_owner != _msgSender()) revert OwnableUnauthorizedAccount(_msgSender());
        _;
    }
}
