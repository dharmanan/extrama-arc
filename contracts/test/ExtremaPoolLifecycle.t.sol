// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ExtremaPool} from "../src/ExtremaPool.sol";
import {ExtremaTicket} from "../src/ExtremaTicket.sol";
import {ExtremaTreasury} from "../src/ExtremaTreasury.sol";
import {ExtremaRenderer} from "../src/ExtremaRenderer.sol";
import {MockUSDC} from "./MockUSDC.sol";
import {ExtremaTestBase} from "./TestBase.sol";

contract ExtremaPoolLifecycleTest is ExtremaTestBase {
    address internal constant CONTROLLER_A =
        0xafbB6Cc5C0a9C0eB1BfF8dB2eD807e83aAB8e321;
    address internal constant CONTROLLER_B =
        0x99677aab4b168c274A34525D526346fC47Fab72c;
    address internal constant RESOLVER = address(0xB0B);
    address internal constant ALICE = address(0x1001);
    address internal constant BOB = address(0x1002);
    address internal constant CAROL = address(0x1003);
    address internal constant DAVE = address(0x1004);
    address internal constant EVE = address(0x1005);

    MockUSDC internal usdc;
    ExtremaTreasury internal treasury;
    ExtremaRenderer internal renderer;
    ExtremaPool internal pool;
    ExtremaTicket internal ticket;

    uint64 internal openAt;
    uint64 internal closeAt;
    uint64 internal observationStartAt;
    uint64 internal observationEndAt;

    function setUp() public {
        VM.warp(1_000_000);

        usdc = new MockUSDC();
        treasury = new ExtremaTreasury(
            address(usdc),
            CONTROLLER_A,
            CONTROLLER_B
        );
        renderer = new ExtremaRenderer();

        pool = new ExtremaPool(
            address(usdc),
            address(treasury),
            RESOLVER,
            address(this),
            address(renderer),
            address(this),
            ExtremaPool.Asset.ETH,
            ExtremaPool.Direction.LOW,
            ExtremaPool.Cadence.WEEKLY
        );
        ticket = pool.TICKET();

        openAt = uint64(block.timestamp);
        closeAt = openAt + 100;
        observationStartAt = closeAt;
        observationEndAt = observationStartAt + 100;

        _fundAndApprove(ALICE);
        _fundAndApprove(BOB);
        _fundAndApprove(CAROL);
        _fundAndApprove(DAVE);
    }

    function testSettlementRanksWinnersAndAccountsEveryUsdc() public {
        (
            uint256 roundId,
            uint256 aliceTicket,
            uint256 bobTicket,
            uint256 carolTicket
        ) = _settleFour();

        uint256[3] memory winners = pool.getWinners(roundId);

        require(winners[0] == aliceTicket, "first");
        require(winners[1] == bobTicket, "second");
        require(winners[2] == carolTicket, "third");

        require(pool.claimableByTicket(aliceTicket) == 2_160_000, "first payout");
        require(pool.claimableByTicket(bobTicket) == 900_000, "second payout");
        require(pool.claimableByTicket(carolTicket) == 540_000, "third payout");
        require(usdc.balanceOf(address(treasury)) == 400_000, "treasury share");
        require(pool.totalReservedUsdc() == 3_600_000, "reserved");
        require(pool.escrowInvariantHolds(), "invariant");

        ExtremaPool.Round memory round = pool.getRound(roundId);
        require(round.escrowRemaining == 3_600_000, "round escrow");
    }

    function testTieBreakUsesEarlierEntrySequence() public {
        uint256 roundId = _createRound();
        uint256 aliceTicket = _enter(ALICE, roundId, 9_900);
        uint256 bobTicket = _enter(BOB, roundId, 10_100);
        _enter(CAROL, roundId, 12_000);

        _advanceToSettlement(roundId);

        VM.prank(RESOLVER);
        pool.settleRound(roundId, 10_000);

        uint256[3] memory winners = pool.getWinners(roundId);
        require(winners[0] == aliceTicket, "earlier first");
        require(winners[1] == bobTicket, "later second");
    }

    function testTransferredWinningNftOwnsClaimAndCannotDoubleClaim() public {
        (, uint256 winningTicket,,) = _settleFour();

        VM.prank(ALICE);
        ticket.transferFrom(ALICE, EVE, winningTicket);

        VM.expectRevert(ExtremaPool.NotTicketOwner.selector);
        VM.prank(ALICE);
        pool.claim(winningTicket);

        uint256 beforeBalance = usdc.balanceOf(EVE);

        VM.prank(EVE);
        pool.claim(winningTicket);

        require(usdc.balanceOf(EVE) - beforeBalance == 2_160_000, "winner claim");
        require(ticket.ownerOf(winningTicket) == EVE, "nft owner");

        VM.expectRevert(ExtremaPool.AlreadyClaimed.selector);
        VM.prank(EVE);
        pool.claim(winningTicket);
    }

    function testCancelledRoundRefundFollowsTransferredNft() public {
        uint256 roundId = _createRound();
        uint256 aliceTicket = _enter(ALICE, roundId, 10_000);
        uint256 bobTicket = _enter(BOB, roundId, 11_000);

        VM.prank(ALICE);
        ticket.transferFrom(ALICE, EVE, aliceTicket);

        _advanceToSettlement(roundId);

        VM.prank(RESOLVER);
        pool.cancelRound(roundId);

        VM.expectRevert(ExtremaPool.NotTicketOwner.selector);
        VM.prank(ALICE);
        pool.refund(aliceTicket);

        uint256 beforeBalance = usdc.balanceOf(EVE);

        VM.prank(EVE);
        pool.refund(aliceTicket);

        require(usdc.balanceOf(EVE) - beforeBalance == 1_000_000, "refund");

        VM.expectRevert(ExtremaPool.AlreadyRefunded.selector);
        VM.prank(EVE);
        pool.refund(aliceTicket);

        VM.prank(BOB);
        pool.refund(bobTicket);

        require(pool.totalReservedUsdc() == 0, "reserved zero");
        require(pool.escrowInvariantHolds(), "refund invariant");
    }

    function testThreeEntriesCannotBeCancelled() public {
        uint256 roundId = _createRound();
        _enter(ALICE, roundId, 10_000);
        _enter(BOB, roundId, 11_000);
        _enter(CAROL, roundId, 12_000);

        _advanceToSettlement(roundId);

        VM.expectRevert(ExtremaPool.TooManyEntriesForCancellation.selector);
        VM.prank(RESOLVER);
        pool.cancelRound(roundId);
    }

    function testUnauthorizedSettlementRejected() public {
        uint256 roundId = _createRound();
        _enter(ALICE, roundId, 10_000);
        _enter(BOB, roundId, 11_000);
        _enter(CAROL, roundId, 12_000);

        _advanceToSettlement(roundId);

        VM.expectRevert(ExtremaPool.NotResolver.selector);
        VM.prank(ALICE);
        pool.settleRound(roundId, 10_100);
    }

    function testOwnerCanRescueOnlyAccidentalExcessUsdc() public {
        uint256 roundId = _createRound();
        _enter(ALICE, roundId, 10_000);

        require(pool.totalReservedUsdc() == 1_000_000, "reserved");
        require(pool.excessUsdc() == 0, "initial excess");

        VM.expectRevert(ExtremaPool.ExcessAmountUnavailable.selector);
        pool.rescueExcessUsdc(1);

        usdc.mint(address(pool), 2_000_000);

        require(pool.excessUsdc() == 2_000_000, "excess");

        uint256 beforeBalance = usdc.balanceOf(address(this));
        pool.rescueExcessUsdc(2_000_000);

        require(
            usdc.balanceOf(address(this)) - beforeBalance == 2_000_000,
            "rescued"
        );
        require(usdc.balanceOf(address(pool)) == 1_000_000, "escrow untouched");
        require(pool.totalReservedUsdc() == 1_000_000, "reserve untouched");
        require(pool.escrowInvariantHolds(), "rescue invariant");
    }

    function testTreasuryControllersCannotWithdrawPoolEscrow() public {
        uint256 roundId = _createRound();
        _enter(ALICE, roundId, 10_000);

        VM.expectRevert(ExtremaPool.NotOwner.selector);
        VM.prank(CONTROLLER_A);
        pool.rescueExcessUsdc(1);

        VM.expectRevert(ExtremaPool.NotOwner.selector);
        VM.prank(CONTROLLER_B);
        pool.rescueExcessUsdc(1);

        require(usdc.balanceOf(address(pool)) == 1_000_000, "escrow");
        require(pool.totalReservedUsdc() == 1_000_000, "reserved");
    }

    function _settleFour()
        internal
        returns (
            uint256 roundId,
            uint256 aliceTicket,
            uint256 bobTicket,
            uint256 carolTicket
        )
    {
        roundId = _createRound();
        aliceTicket = _enter(ALICE, roundId, 10_000);
        bobTicket = _enter(BOB, roundId, 11_000);
        carolTicket = _enter(CAROL, roundId, 9_000);
        _enter(DAVE, roundId, 20_000);

        _advanceToSettlement(roundId);

        VM.prank(RESOLVER);
        pool.settleRound(roundId, 10_400);
    }

    function _createRound() internal returns (uint256) {
        return pool.createRound(
            openAt,
            closeAt,
            observationStartAt,
            observationEndAt
        );
    }

    function _enter(
        address user,
        uint256 roundId,
        uint64 prediction
    ) internal returns (uint256 ticketId) {
        VM.prank(user);
        ticketId = pool.enterPrediction(roundId, prediction);
    }

    function _advanceToSettlement(uint256 roundId) internal {
        VM.warp(closeAt);
        pool.lockRound(roundId);
        VM.warp(observationEndAt);
    }

    function _fundAndApprove(address user) internal {
        usdc.mint(user, 100_000_000);
        VM.prank(user);
        usdc.approve(address(pool), type(uint256).max);
    }
}
