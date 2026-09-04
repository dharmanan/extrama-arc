// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ExtremaFactory} from "../src/ExtremaFactory.sol";
import {ExtremaPool} from "../src/ExtremaPool.sol";
import {ExtremaTicket} from "../src/ExtremaTicket.sol";
import {ExtremaTreasury} from "../src/ExtremaTreasury.sol";
import {ExtremaRenderer} from "../src/ExtremaRenderer.sol";
import {MockUSDC} from "./MockUSDC.sol";
import {ExtremaTestBase} from "./TestBase.sol";

contract ExtremaFactoryTest is ExtremaTestBase {
    address internal constant CONTROLLER_A =
        0xafbB6Cc5C0a9C0eB1BfF8dB2eD807e83aAB8e321;
    address internal constant CONTROLLER_B =
        0x99677aab4b168c274A34525D526346fC47Fab72c;
    address internal constant RESOLVER = address(0xB0B);
    address internal constant NEW_RESOLVER = address(0xBEEF);

    MockUSDC internal usdc;
    ExtremaTreasury internal treasury;
    ExtremaRenderer internal renderer;
    ExtremaFactory internal factory;

    function setUp() public {
        usdc = new MockUSDC();
        treasury = new ExtremaTreasury(
            address(usdc),
            CONTROLLER_A,
            CONTROLLER_B
        );
        renderer = new ExtremaRenderer();
        factory = new ExtremaFactory(
            address(usdc),
            address(treasury),
            address(this),
            RESOLVER,
            address(renderer)
        );
    }

    function testDeploysAll24UniquePoolsAndTicketCollections() public {
        address[] memory tickets = new address[](24);
        uint256 index;

        for (uint8 asset = 0; asset < 4; ++asset) {
            for (uint8 direction = 0; direction < 2; ++direction) {
                for (uint8 cadence = 0; cadence < 3; ++cadence) {
                    address poolAddress = factory.deployPool(
                        ExtremaPool.Asset(asset),
                        ExtremaPool.Direction(direction),
                        ExtremaPool.Cadence(cadence)
                    );

                    ExtremaPool deployed = ExtremaPool(poolAddress);
                    require(uint8(deployed.ASSET()) == asset, "asset");
                    require(uint8(deployed.DIRECTION()) == direction, "direction");
                    require(uint8(deployed.CADENCE()) == cadence, "cadence");

                    address ticketAddress = address(deployed.TICKET());
                    require(ticketAddress != address(0), "ticket");

                    for (uint256 j = 0; j < index; ++j) {
                        require(tickets[j] != ticketAddress, "duplicate ticket");
                    }

                    tickets[index++] = ticketAddress;

                    require(
                        factory.poolFor(
                            ExtremaPool.Asset(asset),
                            ExtremaPool.Direction(direction),
                            ExtremaPool.Cadence(cadence)
                        ) == poolAddress,
                        "registry"
                    );
                }
            }
        }

        require(factory.poolCount() == 24, "pool count");
        require(factory.pools().length == 24, "pool list");
    }

    function testDuplicatePoolIdentityRejected() public {
        factory.deployPool(
            ExtremaPool.Asset.BTC,
            ExtremaPool.Direction.HIGH,
            ExtremaPool.Cadence.DAILY
        );

        VM.expectRevert(ExtremaFactory.PoolAlreadyExists.selector);
        factory.deployPool(
            ExtremaPool.Asset.BTC,
            ExtremaPool.Direction.HIGH,
            ExtremaPool.Cadence.DAILY
        );
    }

    function testHighAndLowPoolsHaveSeparateCollections() public {
        ExtremaPool highPool = ExtremaPool(
            factory.deployPool(
                ExtremaPool.Asset.BTC,
                ExtremaPool.Direction.HIGH,
                ExtremaPool.Cadence.DAILY
            )
        );

        ExtremaPool lowPool = ExtremaPool(
            factory.deployPool(
                ExtremaPool.Asset.BTC,
                ExtremaPool.Direction.LOW,
                ExtremaPool.Cadence.DAILY
            )
        );

        ExtremaTicket highTicket = highPool.TICKET();
        ExtremaTicket lowTicket = lowPool.TICKET();

        require(address(highTicket) != address(lowTicket), "same collection");
        require(
            keccak256(bytes(highTicket.name())) != keccak256(bytes(lowTicket.name())),
            "same name"
        );
    }

    function testFactoryCanRotateResolverWithoutPoolEscrowAuthority() public {
        ExtremaPool first = ExtremaPool(
            factory.deployPool(
                ExtremaPool.Asset.ETH,
                ExtremaPool.Direction.HIGH,
                ExtremaPool.Cadence.WEEKLY
            )
        );
        ExtremaPool second = ExtremaPool(
            factory.deployPool(
                ExtremaPool.Asset.SOL,
                ExtremaPool.Direction.LOW,
                ExtremaPool.Cadence.QUARTERLY
            )
        );

        factory.setResolver(NEW_RESOLVER);

        require(first.resolver() == NEW_RESOLVER, "first resolver");
        require(second.resolver() == NEW_RESOLVER, "second resolver");

        VM.expectRevert(ExtremaPool.NotOwner.selector);
        VM.prank(address(factory));
        first.rescueExcessUSDC(1);
    }

    function testRendererCanBeRotatedAcrossCollections() public {
        ExtremaPool first = ExtremaPool(
            factory.deployPool(
                ExtremaPool.Asset.ETH,
                ExtremaPool.Direction.HIGH,
                ExtremaPool.Cadence.DAILY
            )
        );
        ExtremaPool second = ExtremaPool(
            factory.deployPool(
                ExtremaPool.Asset.HYPE,
                ExtremaPool.Direction.LOW,
                ExtremaPool.Cadence.WEEKLY
            )
        );

        ExtremaRenderer nextRenderer = new ExtremaRenderer();
        factory.setRendererForAll(address(nextRenderer));

        require(first.TICKET().renderer() == address(nextRenderer), "first renderer");
        require(second.TICKET().renderer() == address(nextRenderer), "second renderer");
    }
}
