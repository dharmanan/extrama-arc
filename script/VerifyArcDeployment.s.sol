// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ExtremaFactory} from "../contracts/src/ExtremaFactory.sol";
import {ExtremaPool} from "../contracts/src/ExtremaPool.sol";
import {ExtremaRenderer} from "../contracts/src/ExtremaRenderer.sol";
import {ExtremaTreasury} from "../contracts/src/ExtremaTreasury.sol";

interface IVerifyVm {
    function envAddress(string calldata name) external returns (address value);
}

contract VerifyArcDeployment {
    IVerifyVm private constant VM =
        IVerifyVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 public constant ARC_TESTNET_CHAIN_ID = 5_042_002;
    address public constant ARC_TESTNET_USDC =
        0x3600000000000000000000000000000000000000;

    address public constant TREASURY_CONTROLLER_A =
        0xafbB6Cc5C0a9C0eB1BfF8dB2eD807e83aAB8e321;
    address public constant TREASURY_CONTROLLER_B =
        0x99677aab4b168c274A34525D526346fC47Fab72c;

    error VerificationFailed();

    function run() external {
        if (block.chainid != ARC_TESTNET_CHAIN_ID) revert VerificationFailed();

        ExtremaFactory factory = ExtremaFactory(VM.envAddress("EXTREMA_FACTORY"));
        ExtremaTreasury treasury = ExtremaTreasury(VM.envAddress("EXTREMA_TREASURY"));
        ExtremaRenderer renderer = ExtremaRenderer(VM.envAddress("EXTREMA_RENDERER"));
        address resolver = VM.envAddress("EXTREMA_RESOLVER");
        address poolAdmin = factory.owner();

        if (factory.poolCount() != 24) revert VerificationFailed();
        if (factory.USDC() != ARC_TESTNET_USDC) revert VerificationFailed();
        if (factory.TREASURY() != address(treasury)) revert VerificationFailed();
        if (factory.POOL_ADMIN() != poolAdmin) revert VerificationFailed();
        if (factory.defaultResolver() != resolver) revert VerificationFailed();
        if (factory.defaultRenderer() != address(renderer)) revert VerificationFailed();

        if (address(treasury.USDC()) != ARC_TESTNET_USDC) revert VerificationFailed();
        if (treasury.CONTROLLER_A() != TREASURY_CONTROLLER_A) revert VerificationFailed();
        if (treasury.CONTROLLER_B() != TREASURY_CONTROLLER_B) revert VerificationFailed();

        address[24] memory tickets;
        uint256 index = 0;

        for (uint8 asset = 0; asset < 4; ++asset) {
            for (uint8 direction = 0; direction < 2; ++direction) {
                for (uint8 cadence = 0; cadence < 3; ++cadence) {
                    address poolAddress = factory.poolFor(
                        ExtremaPool.Asset(asset),
                        ExtremaPool.Direction(direction),
                        ExtremaPool.Cadence(cadence)
                    );
                    if (poolAddress == address(0)) revert VerificationFailed();

                    ExtremaPool pool = ExtremaPool(poolAddress);
                    if (address(pool.USDC()) != ARC_TESTNET_USDC) revert VerificationFailed();
                    if (pool.TREASURY() != address(treasury)) revert VerificationFailed();
                    if (pool.owner() != poolAdmin) revert VerificationFailed();
                    if (pool.resolver() != resolver) revert VerificationFailed();
                    if (uint8(pool.ASSET()) != asset) revert VerificationFailed();
                    if (uint8(pool.DIRECTION()) != direction) revert VerificationFailed();
                    if (uint8(pool.CADENCE()) != cadence) revert VerificationFailed();

                    address ticketAddress = address(pool.TICKET());
                    if (ticketAddress == address(0)) revert VerificationFailed();
                    if (pool.TICKET().renderer() != address(renderer)) revert VerificationFailed();

                    for (uint256 i = 0; i < index; ++i) {
                        if (tickets[i] == ticketAddress) revert VerificationFailed();
                    }
                    tickets[index] = ticketAddress;
                    ++index;
                }
            }
        }

        if (index != 24) revert VerificationFailed();
    }
}
