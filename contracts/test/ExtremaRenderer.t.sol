// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ExtremaPool} from "../src/ExtremaPool.sol";
import {ExtremaTicket} from "../src/ExtremaTicket.sol";
import {ExtremaRenderer} from "../src/ExtremaRenderer.sol";
import {MockUSDC} from "./MockUSDC.sol";
import {ExtremaTestBase} from "./TestBase.sol";

contract ExtremaRendererTest is ExtremaTestBase {
    address internal constant RESOLVER = address(0xB0B);
    address internal constant TREASURY = address(0xA11CE);
    address internal constant ALICE = address(0x1001);
    address internal constant BOB = address(0x1002);
    address internal constant CAROL = address(0x1003);

    MockUSDC internal usdc;
    ExtremaRenderer internal renderer;
    ExtremaPool internal pool;
    ExtremaTicket internal ticket;

    uint64 internal openAt;
    uint64 internal closeAt;
    uint64 internal observationEndAt;

    function setUp() public {
        VM.warp(1_000_000);

        usdc = new MockUSDC();
        renderer = new ExtremaRenderer();

        pool = new ExtremaPool(
            address(usdc),
            TREASURY,
            RESOLVER,
            address(this),
            address(renderer),
            address(this),
            ExtremaPool.Asset.BTC,
            ExtremaPool.Direction.HIGH,
            ExtremaPool.Cadence.DAILY
        );

        ticket = pool.TICKET();

        openAt = uint64(block.timestamp);
        closeAt = openAt + 100;
        observationEndAt = closeAt + 100;

        _fund(ALICE);
        _fund(BOB);
        _fund(CAROL);
    }

    function testTokenUriIsFullyOnchainAndChangesWithState() public {
        uint256 roundId = pool.createRound(
            openAt,
            closeAt,
            closeAt,
            observationEndAt
        );

        uint256 aliceTicket = _enter(ALICE, roundId, 73_421_00);
        _enter(BOB, roundId, 73_500_00);
        _enter(CAROL, roundId, 73_600_00);

        string memory liveUri = ticket.tokenURI(aliceTicket);

        require(
            _startsWith(liveUri, "data:application/json;base64,"),
            "not onchain data uri"
        );

        VM.warp(closeAt);
        pool.lockRound(roundId);
        VM.warp(observationEndAt);

        VM.prank(RESOLVER);
        pool.settleRound(roundId, 73_430_00);

        string memory settledUri = ticket.tokenURI(aliceTicket);

        require(
            keccak256(bytes(liveUri)) != keccak256(bytes(settledUri)),
            "status did not change"
        );

        VM.prank(ALICE);
        pool.claim(aliceTicket);

        string memory claimedUri = ticket.tokenURI(aliceTicket);

        require(
            keccak256(bytes(settledUri)) != keccak256(bytes(claimedUri)),
            "claim did not change metadata"
        );
    }

    function testHighAndLowPoolArtworkDiffers() public {
        ExtremaPool lowPool = new ExtremaPool(
            address(usdc),
            TREASURY,
            RESOLVER,
            address(this),
            address(renderer),
            address(this),
            ExtremaPool.Asset.BTC,
            ExtremaPool.Direction.LOW,
            ExtremaPool.Cadence.DAILY
        );

        usdc.mint(ALICE, 10_000_000);
        VM.prank(ALICE);
        usdc.approve(address(lowPool), type(uint256).max);

        uint256 highRound = pool.createRound(
            openAt,
            closeAt,
            closeAt,
            observationEndAt
        );
        uint256 lowRound = lowPool.createRound(
            openAt,
            closeAt,
            closeAt,
            observationEndAt
        );

        uint256 highTicket = _enter(ALICE, highRound, 73_421_00);

        VM.prank(ALICE);
        uint256 lowTicket = lowPool.enterPrediction(lowRound, 73_421_00);

        string memory highUri = ticket.tokenURI(highTicket);
        string memory lowUri = lowPool.TICKET().tokenURI(lowTicket);

        require(
            keccak256(bytes(highUri)) != keccak256(bytes(lowUri)),
            "high low art identical"
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

    function _fund(address user) internal {
        usdc.mint(user, 100_000_000);
        VM.prank(user);
        usdc.approve(address(pool), type(uint256).max);
    }
}
