// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

struct Position {
    uint256 amount;
    uint64 openedAt;
}

enum Side {
    Long,
    Short
}

error InsufficientBalance(uint256 available, uint256 required);

event Deposited(address indexed account, uint256 amount);

type Shares is uint256;

uint256 constant MAX_BPS = 10_000;

function toShares(uint256 amount) pure returns (Shares) {
    return Shares.wrap(amount);
}
