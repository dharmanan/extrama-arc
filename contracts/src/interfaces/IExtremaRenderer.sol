// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface IExtremaRenderer {
    function tokenURI(address pool, uint256 tokenId) external view returns (string memory);
}
