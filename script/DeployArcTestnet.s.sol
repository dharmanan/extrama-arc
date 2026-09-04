// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ExtremaFactory} from "../contracts/src/ExtremaFactory.sol";
import {ExtremaPool} from "../contracts/src/ExtremaPool.sol";
import {ExtremaRenderer} from "../contracts/src/ExtremaRenderer.sol";
import {ExtremaTreasury} from "../contracts/src/ExtremaTreasury.sol";

interface IDeployVm {
    function envUint(string calldata name) external returns (uint256 value);
    function envAddress(string calldata name) external returns (address value);
    function addr(uint256 privateKey) external returns (address keyAddr);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

contract DeployArcTestnet {
    IDeployVm private constant VM =
        IDeployVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 public constant ARC_TESTNET_CHAIN_ID = 5_042_002;
    address public constant ARC_TESTNET_USDC =
        0x3600000000000000000000000000000000000000;

    address public constant TREASURY_CONTROLLER_A =
        0xafbB6Cc5C0a9C0eB1BfF8dB2eD807e83aAB8e321;
    address public constant TREASURY_CONTROLLER_B =
        0x99677aab4b168c274A34525D526346fC47Fab72c;

    error WrongChain(uint256 actual);
    error ZeroAddress();
    error InvalidRoleSeparation();
    error UsdcMissing();
    error DeploymentInvariantFailed();

    function run()
        external
        returns (
            ExtremaFactory factory,
            ExtremaTreasury treasury,
            ExtremaRenderer renderer
        )
    {
        if (block.chainid != ARC_TESTNET_CHAIN_ID) revert WrongChain(block.chainid);
        if (ARC_TESTNET_USDC.code.length == 0) revert UsdcMissing();

        uint256 deployerPrivateKey = VM.envUint("EXTREMA_DEPLOYER_PRIVATE_KEY");
        address deployer = VM.addr(deployerPrivateKey);
        address poolAdmin = deployer;
        address resolver = VM.envAddress("EXTREMA_RESOLVER");

        if (deployer == address(0) || resolver == address(0)) revert ZeroAddress();

        if (
            resolver == poolAdmin
                || resolver == TREASURY_CONTROLLER_A
                || resolver == TREASURY_CONTROLLER_B
        ) revert InvalidRoleSeparation();

        VM.startBroadcast(deployerPrivateKey);

        treasury = new ExtremaTreasury(
            ARC_TESTNET_USDC,
            TREASURY_CONTROLLER_A,
            TREASURY_CONTROLLER_B
        );
        renderer = new ExtremaRenderer();
        factory = new ExtremaFactory(
            ARC_TESTNET_USDC,
            address(treasury),
            poolAdmin,
            resolver,
            address(renderer)
        );

        for (uint8 asset = 0; asset < 4; ++asset) {
            for (uint8 direction = 0; direction < 2; ++direction) {
                for (uint8 cadence = 0; cadence < 3; ++cadence) {
                    factory.deployPool(
                        ExtremaPool.Asset(asset),
                        ExtremaPool.Direction(direction),
                        ExtremaPool.Cadence(cadence)
                    );
                }
            }
        }

        VM.stopBroadcast();

        if (factory.owner() != deployer) revert DeploymentInvariantFailed();
        if (factory.POOL_ADMIN() != deployer) revert DeploymentInvariantFailed();
        if (factory.poolCount() != 24) revert DeploymentInvariantFailed();
        if (factory.USDC() != ARC_TESTNET_USDC) revert DeploymentInvariantFailed();
        if (factory.TREASURY() != address(treasury)) revert DeploymentInvariantFailed();
        if (factory.defaultResolver() != resolver) revert DeploymentInvariantFailed();
        if (factory.defaultRenderer() != address(renderer)) revert DeploymentInvariantFailed();

        _verifyTwentyFourPools(factory, treasury, renderer, deployer, resolver);
    }

    function _verifyTwentyFourPools(
        ExtremaFactory factory,
        ExtremaTreasury treasury,
        ExtremaRenderer renderer,
        address poolAdmin,
        address resolver
    ) internal view {
        address[24] memory seenTickets;
        uint256 index = 0;

        for (uint8 asset = 0; asset < 4; ++asset) {
            for (uint8 direction = 0; direction < 2; ++direction) {
                for (uint8 cadence = 0; cadence < 3; ++cadence) {
                    address poolAddress = factory.poolFor(
                        ExtremaPool.Asset(asset),
                        ExtremaPool.Direction(direction),
                        ExtremaPool.Cadence(cadence)
                    );
                    if (poolAddress == address(0)) revert DeploymentInvariantFailed();

                    ExtremaPool pool = ExtremaPool(poolAddress);
                    if (address(pool.USDC()) != ARC_TESTNET_USDC) revert DeploymentInvariantFailed();
                    if (pool.TREASURY() != address(treasury)) revert DeploymentInvariantFailed();
                    if (pool.owner() != poolAdmin) revert DeploymentInvariantFailed();
                    if (pool.resolver() != resolver) revert DeploymentInvariantFailed();
                    if (uint8(pool.ASSET()) != asset) revert DeploymentInvariantFailed();
                    if (uint8(pool.DIRECTION()) != direction) revert DeploymentInvariantFailed();
                    if (uint8(pool.CADENCE()) != cadence) revert DeploymentInvariantFailed();

                    address ticketAddress = address(pool.TICKET());
                    if (ticketAddress == address(0)) revert DeploymentInvariantFailed();
                    if (pool.TICKET().renderer() != address(renderer)) revert DeploymentInvariantFailed();

                    for (uint256 i = 0; i < index; ++i) {
                        if (seenTickets[i] == ticketAddress) revert DeploymentInvariantFailed();
                    }
                    seenTickets[index] = ticketAddress;
                    ++index;
                }
            }
        }

        if (index != 24) revert DeploymentInvariantFailed();
    }
}
