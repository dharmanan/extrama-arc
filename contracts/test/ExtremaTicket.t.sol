// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ExtremaPool} from "../src/ExtremaPool.sol";
import {ExtremaTicket} from "../src/ExtremaTicket.sol";
import {ExtremaRenderer} from "../src/ExtremaRenderer.sol";
import {IERC721Receiver} from "../src/interfaces/IERC721Receiver.sol";
import {MockUSDC} from "./MockUSDC.sol";
import {ExtremaTestBase} from "./TestBase.sol";

contract ValidReceiver is IERC721Receiver {
    function onERC721Received(
        address,
        address,
        uint256,
        bytes calldata
    ) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}

contract InvalidReceiver {}

contract ExtremaTicketTest is ExtremaTestBase {
    address internal constant TREASURY = address(0xA11CE);
    address internal constant RESOLVER = address(0xB0B);
    address internal constant ALICE = address(0x1001);
    address internal constant BOB = address(0x1002);
    address internal constant CAROL = address(0x1003);
    address internal constant OPERATOR = address(0x1004);

    MockUSDC internal usdc;
    ExtremaRenderer internal renderer;
    ExtremaPool internal pool;
    ExtremaTicket internal ticket;

    uint64 internal openAt;
    uint64 internal closeAt;
    uint64 internal observationEndAt;
    uint256 internal roundId;

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
            ExtremaPool.Asset.SOL,
            ExtremaPool.Direction.HIGH,
            ExtremaPool.Cadence.DAILY
        );

        ticket = pool.TICKET();

        openAt = uint64(block.timestamp);
        closeAt = openAt + 100;
        observationEndAt = closeAt + 100;

        roundId = pool.createRound(
            openAt,
            closeAt,
            closeAt,
            observationEndAt
        );

        _fund(ALICE);
        _fund(BOB);
        _fund(CAROL);
    }

    function testOnlyPoolCanMint() public {
        VM.expectRevert(ExtremaTicket.NotMinter.selector);
        ticket.mint(ALICE, 999);
    }

    function testUnauthorizedTransferRejected() public {
        uint256 tokenId = _enter(ALICE, 10_000);

        VM.expectRevert(ExtremaTicket.NotAuthorized.selector);
        VM.prank(BOB);
        ticket.transferFrom(ALICE, BOB, tokenId);
    }

    function testApprovedAddressCanTransferAndApprovalClears() public {
        uint256 tokenId = _enter(ALICE, 10_000);

        VM.prank(ALICE);
        ticket.approve(BOB, tokenId);

        require(ticket.getApproved(tokenId) == BOB, "approval missing");

        VM.prank(BOB);
        ticket.transferFrom(ALICE, CAROL, tokenId);

        require(ticket.ownerOf(tokenId) == CAROL, "owner");
        require(ticket.getApproved(tokenId) == address(0), "approval not cleared");
    }

    function testOperatorApprovalCanTransfer() public {
        uint256 tokenId = _enter(ALICE, 10_000);

        VM.prank(ALICE);
        ticket.setApprovalForAll(OPERATOR, true);

        require(ticket.isApprovedForAll(ALICE, OPERATOR), "operator");

        VM.prank(OPERATOR);
        ticket.transferFrom(ALICE, BOB, tokenId);

        require(ticket.ownerOf(tokenId) == BOB, "operator transfer");
    }

    function testSafeTransferToValidReceiverWorks() public {
        uint256 tokenId = _enter(ALICE, 10_000);
        ValidReceiver receiver = new ValidReceiver();

        VM.prank(ALICE);
        ticket.safeTransferFrom(ALICE, address(receiver), tokenId);

        require(ticket.ownerOf(tokenId) == address(receiver), "receiver owner");
    }

    function testSafeTransferToInvalidReceiverReverts() public {
        uint256 tokenId = _enter(ALICE, 10_000);
        InvalidReceiver receiver = new InvalidReceiver();

        VM.expectRevert(ExtremaTicket.InvalidReceiver.selector);
        VM.prank(ALICE);
        ticket.safeTransferFrom(ALICE, address(receiver), tokenId);

        require(ticket.ownerOf(tokenId) == ALICE, "ownership changed");
    }

    function testNonexistentTokenUriReverts() public {
        VM.expectRevert(ExtremaTicket.TokenDoesNotExist.selector);
        ticket.tokenURI(999);
    }

    function testOnlyRendererAdminCanUpdateRenderer() public {
        ExtremaRenderer nextRenderer = new ExtremaRenderer();

        VM.expectRevert(ExtremaTicket.NotRendererAdmin.selector);
        VM.prank(ALICE);
        ticket.setRenderer(address(nextRenderer));

        ticket.setRenderer(address(nextRenderer));
        require(ticket.renderer() == address(nextRenderer), "renderer");
    }

    function _enter(
        address user,
        uint64 prediction
    ) internal returns (uint256 tokenId) {
        VM.prank(user);
        tokenId = pool.enterPrediction(roundId, prediction);
    }

    function _fund(address user) internal {
        usdc.mint(user, 100_000_000);
        VM.prank(user);
        usdc.approve(address(pool), type(uint256).max);
    }
}
