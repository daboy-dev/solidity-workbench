// SPDX-License-Identifier: MIT
// Minimal fake of OpenZeppelin Contracts for tests.
pragma solidity ^0.8.20;

abstract contract Context {
    function _msgSender() internal view virtual returns (address) {
        return msg.sender;
    }
}
