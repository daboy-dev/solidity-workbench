// SPDX-License-Identifier: MIT
// Minimal fake of OpenZeppelin Contracts for tests.
pragma solidity ^0.8.20;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
}
