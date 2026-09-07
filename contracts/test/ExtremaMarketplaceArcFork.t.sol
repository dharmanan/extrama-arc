// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ExtremaFactory} from "../src/ExtremaFactory.sol";
import {ExtremaMarketplace} from "../src/ExtremaMarketplace.sol";
import {ExtremaPool} from "../src/ExtremaPool.sol";
import {ExtremaTicket} from "../src/ExtremaTicket.sol";

interface Vm {
    function createSelectFork(string calldata url) external returns (uint256 forkId);
    function prank(address msgSender) external;
    function expectRevert(bytes4 revertData) external;
}

contract ExtremaMarketplaceArcForkTest {
    Vm internal constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    string internal constant ARC_RPC = "https://rpc.testnet.arc.network";
    uint256 internal constant ARC_CHAIN_ID = 5_042_002;
    address internal constant USDC = 0x3600000000000000000000000000000000000000;
    address internal constant FACTORY = 0xa7Bff22811Bb1BA9297DFaA611De58E3bc186D7A;

    // This pool currently has an ENTRY_OPEN round with token 4 on Arc Testnet.
    address internal constant LIVE_POOL = 0xA5467fDCDAA0afaE379Fd8Ab0F9761944211725f;
    uint256 internal constant LIVE_TOKEN_ID = 4;

    function testArcDeploymentAbiAndMarketplaceCompatibility() public {
        vm.createSelectFork(ARC_RPC);
        require(block.chainid == ARC_CHAIN_ID, "wrong chain");

        ExtremaFactory factory = ExtremaFactory(FACTORY);
        ExtremaPool pool = ExtremaPool(LIVE_POOL);
        ExtremaTicket ticket = pool.TICKET();
        ExtremaMarketplace marketplace = new ExtremaMarketplace(USDC, FACTORY);

        // Canonical registry and immutable pool/ticket pair checks.
        require(factory.isRegisteredPool(LIVE_POOL), "pool not registered");
        require(address(pool.TICKET()) == address(ticket), "ticket getter mismatch");
        require(address(pool.USDC()) == USDC, "pool usdc mismatch");
        require(ticket.MINTER() == LIVE_POOL, "ticket minter mismatch");
        require(address(marketplace.USDC()) == USDC, "market usdc mismatch");
        require(address(marketplace.FACTORY()) == FACTORY, "market factory mismatch");

        // The deployed V2 entry and round getters decode using the marketplace ABI.
        (
            uint256 storedTicketId,
            uint256 roundId,
            address originalEntrant,
            uint64 predictionPriceCents,
            uint64 entrySequence
        ) = pool.entries(LIVE_TOKEN_ID);
        require(storedTicketId == LIVE_TOKEN_ID, "entry ticket mismatch");
        require(roundId != 0 && originalEntrant != address(0), "entry missing");
        require(predictionPriceCents != 0 && entrySequence != 0, "entry fields missing");

        ExtremaPool.Round memory round = pool.getRound(roundId);
        require(round.entryCloseAt > round.entryOpenAt, "round timestamps mismatch");
        require(round.observationEndAt > round.observationStartAt, "observation timestamps mismatch");

        // ownerOf/getApproved and the three-argument safeTransferFrom ABI are live-compatible.
        address liveOwner = ticket.ownerOf(LIVE_TOKEN_ID);
        require(liveOwner != address(0), "live owner missing");
        ticket.getApproved(LIVE_TOKEN_ID);

        // A fake local ticket is not in the canonical Factory registry.
        ExtremaTicket fakeTicket = new ExtremaTicket(
            address(this),
            address(this),
            address(1),
            "Fake",
            "FAKE"
        );
        vm.expectRevert(ExtremaMarketplace.UnsupportedTicket.selector);
        marketplace.list(address(fakeTicket), 1, 1_000_000);

        // All state-changing compatibility checks below affect only this local fork.
        vm.prank(liveOwner);
        ticket.approve(address(marketplace), LIVE_TOKEN_ID);
        vm.prank(liveOwner);
        uint256 listingId = marketplace.list(address(ticket), LIVE_TOKEN_ID, 1_000_000);

        ExtremaMarketplace.Listing memory listing = marketplace.getListing(listingId);
        require(listing.ticket == address(ticket), "listing ticket mismatch");
        require(listing.roundId == roundId, "listing round mismatch");
        require(listing.createdAt > 0, "listing timestamp missing");

        vm.prank(liveOwner);
        marketplace.updatePrice(listingId, 1_500_000);
        require(marketplace.getListing(listingId).askUsdc == 1_500_000, "price update mismatch");

        vm.prank(liveOwner);
        marketplace.cancel(listingId);
        require(
            marketplace.getListing(listingId).status == ExtremaMarketplace.ListingStatus.CANCELLED,
            "cancel mismatch"
        );

        // Exercise the deployed ticket's safeTransferFrom selector locally after cancellation.
        address localRecipient = address(0xBEEF);
        vm.prank(liveOwner);
        ticket.safeTransferFrom(liveOwner, localRecipient, LIVE_TOKEN_ID);
        require(ticket.ownerOf(LIVE_TOKEN_ID) == localRecipient, "safe transfer mismatch");
    }
}
