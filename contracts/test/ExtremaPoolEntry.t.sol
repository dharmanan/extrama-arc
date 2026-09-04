// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ExtremaPool} from "../src/ExtremaPool.sol";
import {ExtremaTicket} from "../src/ExtremaTicket.sol";
import {MockUSDC} from "./MockUSDC.sol";

interface Vm {
    function warp(uint256) external;
    function prank(address) external;
    function expectRevert(bytes4) external;
}

contract ExtremaPoolEntryTest {
    Vm internal constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    address internal constant TREASURY = address(0xA11CE);
    address internal constant RESOLVER = address(0xB0B);
    address internal constant RENDERER = address(0xC0DE);
    address internal constant ALICE = address(0x1001);
    address internal constant BOB = address(0x1002);

    MockUSDC internal usdc;
    ExtremaPool internal pool;
    ExtremaTicket internal ticket;

    uint64 internal openAt;
    uint64 internal closeAt;
    uint64 internal observationStartAt;
    uint64 internal observationEndAt;

    function setUp() public {
        vm.warp(1_000_000);
        usdc = new MockUSDC();
        pool = new ExtremaPool(
            address(usdc),
            TREASURY,
            RESOLVER,
            address(this),
            RENDERER,
            address(this),
            ExtremaPool.Asset.ETH,
            ExtremaPool.Direction.LOW,
            ExtremaPool.Cadence.WEEKLY
        );
        ticket = ExtremaTicket(address(pool.TICKET()));

        openAt = uint64(block.timestamp);
        closeAt = openAt + 100;
        observationStartAt = closeAt;
        observationEndAt = observationStartAt + 100;

        _fund(ALICE);
        _fund(BOB);
    }

    function testRoundCreation() public {
        uint256 roundId = _createRound();
        ExtremaPool.Round memory round = pool.getRound(roundId);

        require(roundId == 1, "round id");
        require(round.entryCount == 0, "entry count");
        require(round.status == ExtremaPool.RoundStatus.ENTRY_OPEN, "status");
        require(pool.ASSET() == ExtremaPool.Asset.ETH, "asset");
        require(pool.DIRECTION() == ExtremaPool.Direction.LOW, "direction");
        require(pool.CADENCE() == ExtremaPool.Cadence.WEEKLY, "cadence");
    }

    function testEntryTransfersOneUsdcAndMintsTicket() public {
        uint256 roundId = _createRound();
        uint256 beforeBalance = usdc.balanceOf(ALICE);

        vm.prank(ALICE);
        uint256 ticketId = pool.enterPrediction(roundId, 208_543);

        require(beforeBalance - usdc.balanceOf(ALICE) == 1_000_000, "stake");
        require(usdc.balanceOf(address(pool)) == 1_000_000, "pool");
        require(ticket.ownerOf(ticketId) == ALICE, "ticket owner");
    }

    function testDuplicateWalletRejected() public {
        uint256 roundId = _createRound();

        vm.prank(ALICE);
        pool.enterPrediction(roundId, 208_543);

        vm.expectRevert(ExtremaPool.AlreadyEntered.selector);
        vm.prank(ALICE);
        pool.enterPrediction(roundId, 208_544);
    }

    function testDuplicatePriceRejected() public {
        uint256 roundId = _createRound();

        vm.prank(ALICE);
        pool.enterPrediction(roundId, 208_543);

        vm.expectRevert(ExtremaPool.PriceAlreadyTaken.selector);
        vm.prank(BOB);
        pool.enterPrediction(roundId, 208_543);
    }

    function testEntryAfterCloseRejected() public {
        uint256 roundId = _createRound();
        vm.warp(closeAt);

        vm.expectRevert(ExtremaPool.EntryClosed.selector);
        vm.prank(ALICE);
        pool.enterPrediction(roundId, 208_543);
    }

    function _createRound() internal returns (uint256) {
        return pool.createRound(
            openAt,
            closeAt,
            observationStartAt,
            observationEndAt
        );
    }

    function _fund(address user) internal {
        usdc.mint(user, 100_000_000);
        vm.prank(user);
        usdc.approve(address(pool), type(uint256).max);
    }
}
