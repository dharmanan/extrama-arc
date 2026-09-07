// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ExtremaFactory} from "../src/ExtremaFactory.sol";
import {ExtremaMarketplace} from "../src/ExtremaMarketplace.sol";
import {ExtremaPool} from "../src/ExtremaPool.sol";
import {ExtremaRenderer} from "../src/ExtremaRenderer.sol";
import {ExtremaTicket} from "../src/ExtremaTicket.sol";
import {ExtremaTreasury} from "../src/ExtremaTreasury.sol";
import {MockUSDC} from "./MockUSDC.sol";

interface Vm {
    function warp(uint256) external;
    function prank(address) external;
    function expectRevert(bytes4) external;
}

contract ExtremaMarketplaceTest {
    Vm internal constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    address internal constant CONTROLLER_A = 0xafbB6Cc5C0a9C0eB1BfF8dB2eD807e83aAB8e321;
    address internal constant CONTROLLER_B = 0x99677aab4b168c274A34525D526346fC47Fab72c;
    address internal constant RESOLVER = address(0xB0B);
    address internal constant ALICE = address(0x1001);
    address internal constant BOB = address(0x1002);
    address internal constant CAROL = address(0x1003);
    address internal constant DAVE = address(0x1004);

    MockUSDC internal usdc;
    ExtremaTreasury internal treasury;
    ExtremaRenderer internal renderer;
    ExtremaFactory internal factory;
    ExtremaPool internal pool;
    ExtremaTicket internal ticket;
    ExtremaMarketplace internal marketplace;

    uint64 internal openAt;
    uint64 internal closeAt;
    uint64 internal observationStartAt;
    uint64 internal observationEndAt;

    function setUp() public {
        vm.warp(1_000_000);

        usdc = new MockUSDC();
        treasury = new ExtremaTreasury(address(usdc), CONTROLLER_A, CONTROLLER_B);
        renderer = new ExtremaRenderer();
        factory = new ExtremaFactory(
            address(usdc),
            address(treasury),
            address(this),
            RESOLVER,
            address(renderer)
        );
        factory.deployPool(
            ExtremaPool.Asset.ETH,
            ExtremaPool.Direction.LOW,
            ExtremaPool.Cadence.DAILY
        );
        pool = ExtremaPool(
            factory.poolByIdentity(
                factory.identityKey(
                    ExtremaPool.Asset.ETH,
                    ExtremaPool.Direction.LOW,
                    ExtremaPool.Cadence.DAILY
                )
            )
        );
        ticket = pool.TICKET();
        marketplace = new ExtremaMarketplace(address(usdc), address(factory));

        openAt = uint64(block.timestamp);
        closeAt = openAt + 100;
        observationStartAt = closeAt;
        observationEndAt = observationStartAt + 10_000;

        _fund(ALICE);
        _fund(BOB);
        _fund(CAROL);
        _fund(DAVE);
    }

    function testListImmediatelyAfterMintAndArbitraryAsk() public {
        uint256 roundId = _createRound();
        uint256 tokenId = _enter(ALICE, roundId, 10_000);

        _approveTicket(ALICE, tokenId);
        uint256 listingId = _list(ALICE, tokenId, 123_456_789);

        ExtremaMarketplace.Listing memory listing = marketplace.getListing(listingId);
        require(listing.seller == ALICE, "seller");
        require(listing.ticket == address(ticket), "ticket");
        require(listing.tokenId == tokenId, "token id");
        require(listing.askUsdc == 123_456_789, "ask");
        require(listing.roundId == roundId, "round");
        require(listing.status == ExtremaMarketplace.ListingStatus.ACTIVE, "active");
        require(ticket.ownerOf(tokenId) == ALICE, "non custodial");
    }

    function testZeroAskRejected() public {
        uint256 tokenId = _enter(ALICE, _createRound(), 10_000);
        vm.expectRevert(ExtremaMarketplace.InvalidAskPrice.selector);
        vm.prank(ALICE);
        marketplace.list(address(ticket), tokenId, 0);
    }

    function testNonOwnerRejected() public {
        uint256 tokenId = _enter(ALICE, _createRound(), 10_000);
        vm.expectRevert(ExtremaMarketplace.NotTicketOwner.selector);
        vm.prank(BOB);
        marketplace.list(address(ticket), tokenId, 1_000_000);
    }

    function testUnregisteredTicketRejected() public {
        ExtremaTicket fake = new ExtremaTicket(
            address(this),
            address(this),
            address(renderer),
            "Fake",
            "FAKE"
        );

        vm.expectRevert(ExtremaMarketplace.UnsupportedTicket.selector);
        marketplace.list(address(fake), 1, 1_000_000);
    }

    function testDuplicateActiveListingRejected() public {
        uint256 tokenId = _enter(ALICE, _createRound(), 10_000);
        _approveTicket(ALICE, tokenId);
        _list(ALICE, tokenId, 1_000_000);

        vm.expectRevert(ExtremaMarketplace.ActiveListingExists.selector);
        vm.prank(ALICE);
        marketplace.list(address(ticket), tokenId, 2_000_000);
    }

    function testUpdatePriceOnlySellerAndCurrentOwner() public {
        uint256 tokenId = _enter(ALICE, _createRound(), 10_000);
        _approveTicket(ALICE, tokenId);
        uint256 listingId = _list(ALICE, tokenId, 1_000_000);

        vm.expectRevert(ExtremaMarketplace.NotListingSeller.selector);
        vm.prank(BOB);
        marketplace.updatePrice(listingId, 2_000_000);

        vm.prank(ALICE);
        marketplace.updatePrice(listingId, 2_000_000);
        require(marketplace.getListing(listingId).askUsdc == 2_000_000, "price updated");

        vm.prank(ALICE);
        ticket.transferFrom(ALICE, BOB, tokenId);
        vm.expectRevert(ExtremaMarketplace.SellerNotOwner.selector);
        vm.prank(ALICE);
        marketplace.updatePrice(listingId, 3_000_000);
    }

    function testCancelRelistGetsNewListingId() public {
        uint256 tokenId = _enter(ALICE, _createRound(), 10_000);
        _approveTicket(ALICE, tokenId);
        uint256 firstListing = _list(ALICE, tokenId, 1_000_000);

        vm.prank(ALICE);
        marketplace.cancel(firstListing);
        require(
            marketplace.getListing(firstListing).status == ExtremaMarketplace.ListingStatus.CANCELLED,
            "cancelled"
        );
        require(marketplace.activeListingId(address(ticket), tokenId) == 0, "active cleared");

        _approveTicket(ALICE, tokenId);
        uint256 secondListing = _list(ALICE, tokenId, 2_000_000);
        require(secondListing != firstListing, "new id");
    }

    function testManualTransferMakesListingUnbuyable() public {
        uint256 tokenId = _enter(ALICE, _createRound(), 10_000);
        _approveTicket(ALICE, tokenId);
        uint256 listingId = _list(ALICE, tokenId, 1_000_000);

        vm.prank(ALICE);
        ticket.transferFrom(ALICE, BOB, tokenId);

        vm.expectRevert(ExtremaMarketplace.SellerNotOwner.selector);
        vm.prank(CAROL);
        marketplace.buy(listingId);
        require(marketplace.isListingBuyable(listingId) == false, "not buyable");
        require(marketplace.getListing(listingId).status == ExtremaMarketplace.ListingStatus.ACTIVE, "active");
    }

    function testPerTokenApprovalIsRequiredButApprovalForAllIsNot() public {
        uint256 tokenId = _enter(ALICE, _createRound(), 10_000);
        uint256 listingId = _list(ALICE, tokenId, 1_000_000);

        vm.prank(ALICE);
        ticket.setApprovalForAll(address(marketplace), true);
        vm.prank(BOB);
        usdc.approve(address(marketplace), 1_000_000);
        vm.expectRevert(ExtremaMarketplace.TokenNotApproved.selector);
        vm.prank(BOB);
        marketplace.buy(listingId);

        _approveTicket(ALICE, tokenId);
        vm.prank(BOB);
        marketplace.buy(listingId);
        require(ticket.ownerOf(tokenId) == BOB, "buyer owns nft");
    }

    function testApprovalRemovalMakesListingUnbuyable() public {
        uint256 tokenId = _enter(ALICE, _createRound(), 10_000);
        _approveTicket(ALICE, tokenId);
        uint256 listingId = _list(ALICE, tokenId, 1_000_000);

        vm.prank(ALICE);
        ticket.approve(address(0), tokenId);
        vm.expectRevert(ExtremaMarketplace.TokenNotApproved.selector);
        vm.prank(BOB);
        marketplace.buy(listingId);
        require(ticket.ownerOf(tokenId) == ALICE, "nft unchanged");
        require(marketplace.getListing(listingId).status == ExtremaMarketplace.ListingStatus.ACTIVE, "listing unchanged");
    }

    function testBuyTransfersExactUsdcAndNftAtomically() public {
        uint256 tokenId = _enter(ALICE, _createRound(), 10_000);
        _approveTicket(ALICE, tokenId);
        uint256 listingId = _list(ALICE, tokenId, 1_234_567);
        vm.prank(BOB);
        usdc.approve(address(marketplace), 1_234_567);

        uint256 sellerBefore = usdc.balanceOf(ALICE);
        uint256 buyerBefore = usdc.balanceOf(BOB);
        vm.prank(BOB);
        marketplace.buy(listingId);

        require(usdc.balanceOf(ALICE) - sellerBefore == 1_234_567, "seller exact");
        require(buyerBefore - usdc.balanceOf(BOB) == 1_234_567, "buyer exact");
        require(ticket.ownerOf(tokenId) == BOB, "nft transferred");
        require(marketplace.activeListingId(address(ticket), tokenId) == 0, "active cleared");
        require(marketplace.getListing(listingId).status == ExtremaMarketplace.ListingStatus.SOLD, "sold");
    }

    function testSellerCannotBuyOwnListing() public {
        uint256 tokenId = _enter(ALICE, _createRound(), 10_000);
        _approveTicket(ALICE, tokenId);
        uint256 listingId = _list(ALICE, tokenId, 1_000_000);
        vm.expectRevert(ExtremaMarketplace.BuyerIsSeller.selector);
        vm.prank(ALICE);
        marketplace.buy(listingId);
    }

    function testBuyRejectedAtOneHourCutoff() public {
        uint256 tokenId = _enter(ALICE, _createRound(), 10_000);
        _approveTicket(ALICE, tokenId);
        uint256 listingId = _list(ALICE, tokenId, 1_000_000);
        vm.prank(BOB);
        usdc.approve(address(marketplace), 1_000_000);

        vm.warp(observationEndAt - 1 hours);
        vm.expectRevert(ExtremaMarketplace.TradingWindowClosed.selector);
        vm.prank(BOB);
        marketplace.buy(listingId);
    }

    function testLockedRoundRemainsTradableBeforeCutoff() public {
        uint256 roundId = _createRound();
        uint256 tokenId = _enter(ALICE, roundId, 10_000);
        vm.warp(closeAt);
        pool.lockRound(roundId);
        _approveTicket(ALICE, tokenId);
        uint256 listingId = _list(ALICE, tokenId, 1_000_000);
        vm.prank(BOB);
        usdc.approve(address(marketplace), 1_000_000);
        vm.prank(BOB);
        marketplace.buy(listingId);
        require(ticket.ownerOf(tokenId) == BOB, "locked sale");
    }

    function testSettledRoundCannotBeListedOrBought() public {
        uint256 roundId = _createRound();
        uint256 aliceTicket = _enter(ALICE, roundId, 10_000);
        uint256 bobTicket = _enter(BOB, roundId, 11_000);
        _enter(CAROL, roundId, 12_000);
        _approveTicket(ALICE, aliceTicket);
        uint256 listingId = _list(ALICE, aliceTicket, 1_000_000);

        _settle(roundId);
        vm.expectRevert(ExtremaMarketplace.RoundNotTradable.selector);
        vm.prank(BOB);
        marketplace.buy(listingId);

        vm.expectRevert(ExtremaMarketplace.RoundNotTradable.selector);
        vm.prank(ALICE);
        marketplace.list(address(ticket), bobTicket, 2_000_000);
    }

    function testCancelledRoundCannotBeListedOrBought() public {
        uint256 roundId = _createRound();
        uint256 aliceTicket = _enter(ALICE, roundId, 10_000);
        _enter(BOB, roundId, 11_000);
        _approveTicket(ALICE, aliceTicket);
        uint256 listingId = _list(ALICE, aliceTicket, 1_000_000);

        _cancel(roundId);
        vm.expectRevert(ExtremaMarketplace.RoundNotTradable.selector);
        vm.prank(BOB);
        marketplace.buy(listingId);

        vm.expectRevert(ExtremaMarketplace.RoundNotTradable.selector);
        vm.prank(ALICE);
        marketplace.list(address(ticket), aliceTicket, 2_000_000);
    }

    function testUnsoldWinningTicketKeepsSellerClaimRight() public {
        uint256 roundId = _createRound();
        uint256 aliceTicket = _enter(ALICE, roundId, 10_000);
        _enter(BOB, roundId, 11_000);
        _enter(CAROL, roundId, 12_000);
        _approveTicket(ALICE, aliceTicket);
        _list(ALICE, aliceTicket, 1_000_000);
        _settle(roundId);

        uint256 beforeBalance = usdc.balanceOf(ALICE);
        vm.prank(ALICE);
        pool.claim(aliceTicket);
        require(usdc.balanceOf(ALICE) - beforeBalance == 1_620_000, "seller claim");
    }

    function testSoldWinningTicketBuyerClaimsAndEntrantAttributionUnchanged() public {
        uint256 roundId = _createRound();
        uint256 aliceTicket = _enter(ALICE, roundId, 10_000);
        _enter(BOB, roundId, 11_000);
        _enter(CAROL, roundId, 12_000);
        _approveTicket(ALICE, aliceTicket);
        uint256 listingId = _list(ALICE, aliceTicket, 1_000_000);
        vm.prank(BOB);
        usdc.approve(address(marketplace), 1_000_000);
        vm.prank(BOB);
        marketplace.buy(listingId);

        _settle(roundId);
        (uint256 storedTicketId, uint256 storedRoundId, address originalEntrant, uint64 prediction, uint64 sequence) =
            pool.entries(aliceTicket);
        require(originalEntrant == ALICE, "entrant unchanged");
        require(storedTicketId == aliceTicket && storedRoundId == roundId, "entry identity");
        require(prediction == 10_000 && sequence == 1, "entry data");
        uint256 beforeBalance = usdc.balanceOf(BOB);
        vm.prank(BOB);
        pool.claim(aliceTicket);
        require(usdc.balanceOf(BOB) - beforeBalance == 1_620_000, "buyer claim");
    }

    function testUnsoldAndSoldCancelledTicketsRefundCurrentOwner() public {
        uint256 firstRound = _createRound();
        uint256 unsoldTicket = _enter(ALICE, firstRound, 10_000);
        _enter(BOB, firstRound, 11_000);
        _cancel(firstRound);
        uint256 aliceBefore = usdc.balanceOf(ALICE);
        vm.prank(ALICE);
        pool.refund(unsoldTicket);
        require(usdc.balanceOf(ALICE) - aliceBefore == 1_000_000, "unsold refund");

        vm.warp(openAt);
        uint256 secondRound = _createRound();
        uint256 soldTicket = _enter(ALICE, secondRound, 20_000);
        _enter(BOB, secondRound, 21_000);
        _approveTicket(ALICE, soldTicket);
        uint256 listingId = _list(ALICE, soldTicket, 1_000_000);
        vm.prank(BOB);
        usdc.approve(address(marketplace), 1_000_000);
        vm.prank(BOB);
        marketplace.buy(listingId);
        _cancel(secondRound);
        uint256 bobBefore = usdc.balanceOf(BOB);
        vm.prank(BOB);
        pool.refund(soldTicket);
        require(usdc.balanceOf(BOB) - bobBefore == 1_000_000, "sold refund");
    }

    function testFailedUsdcTransferRevertsEntirePurchase() public {
        uint256 tokenId = _enter(ALICE, _createRound(), 10_000);
        _approveTicket(ALICE, tokenId);
        uint256 listingId = _list(ALICE, tokenId, 1_000_000);
        vm.prank(BOB);
        usdc.approve(address(marketplace), 0);

        vm.expectRevert(ExtremaMarketplace.TokenTransferFailed.selector);
        vm.prank(BOB);
        marketplace.buy(listingId);
        require(ticket.ownerOf(tokenId) == ALICE, "nft unchanged");
        require(marketplace.getListing(listingId).status == ExtremaMarketplace.ListingStatus.ACTIVE, "listing unchanged");
    }

    function testReentrantUsdcCannotReenterBuy() public {
        ReentrantUSDC attackUsdc = new ReentrantUSDC();
        ExtremaTreasury attackTreasury = new ExtremaTreasury(
            address(attackUsdc),
            CONTROLLER_A,
            CONTROLLER_B
        );
        ExtremaFactory attackFactory = new ExtremaFactory(
            address(attackUsdc),
            address(attackTreasury),
            address(this),
            RESOLVER,
            address(renderer)
        );
        attackFactory.deployPool(
            ExtremaPool.Asset.ETH,
            ExtremaPool.Direction.LOW,
            ExtremaPool.Cadence.DAILY
        );
        address[] memory deployedPools = attackFactory.pools();
        ExtremaPool attackPool = ExtremaPool(deployedPools[0]);
        ExtremaTicket attackTicket = attackPool.TICKET();
        ExtremaMarketplace attackMarketplace = new ExtremaMarketplace(
            address(attackUsdc),
            address(attackFactory)
        );

        uint64 start = uint64(block.timestamp);
        uint64 entryClose = start + 100;
        uint64 observationEnd = entryClose + 10_000;
        uint256 roundId = attackPool.createRound(start, entryClose, entryClose, observationEnd);
        attackUsdc.mint(ALICE, 10_000_000);
        attackUsdc.mint(BOB, 10_000_000);
        vm.prank(ALICE);
        attackUsdc.approve(address(attackPool), type(uint256).max);
        vm.prank(BOB);
        attackUsdc.approve(address(attackMarketplace), type(uint256).max);
        vm.prank(ALICE);
        uint256 tokenId = attackPool.enterPrediction(roundId, 10_000);
        vm.prank(ALICE);
        attackTicket.approve(address(attackMarketplace), tokenId);
        vm.prank(ALICE);
        uint256 listingId = attackMarketplace.list(address(attackTicket), tokenId, 1_000_000);

        attackUsdc.configureAttack(address(attackMarketplace), listingId);
        vm.expectRevert(ExtremaMarketplace.TokenTransferFailed.selector);
        vm.prank(BOB);
        attackMarketplace.buy(listingId);
        require(attackTicket.ownerOf(tokenId) == ALICE, "reentrant nft unchanged");
        require(
            attackMarketplace.getListing(listingId).status == ExtremaMarketplace.ListingStatus.ACTIVE,
            "reentrant listing unchanged"
        );
    }

    function testReadFunctionsExposeActiveListingAndBuyability() public {
        uint256 tokenId = _enter(ALICE, _createRound(), 10_000);
        _approveTicket(ALICE, tokenId);
        uint256 listingId = _list(ALICE, tokenId, 1_000_000);
        require(marketplace.activeListingId(address(ticket), tokenId) == listingId, "active id");
        require(marketplace.isListingBuyable(listingId), "buyable");
        vm.prank(ALICE);
        marketplace.cancel(listingId);
        require(!marketplace.isListingBuyable(listingId), "cancel not buyable");
    }

    function testMissingListingRejectedByReadsAndActions() public {
        vm.expectRevert(ExtremaMarketplace.ListingNotFound.selector);
        marketplace.getListing(999);
        vm.expectRevert(ExtremaMarketplace.ListingNotFound.selector);
        marketplace.cancel(999);
        vm.expectRevert(ExtremaMarketplace.ListingNotFound.selector);
        marketplace.buy(999);
    }

    function testSoldListingCannotBeUpdatedOrCancelled() public {
        uint256 tokenId = _enter(ALICE, _createRound(), 10_000);
        _approveTicket(ALICE, tokenId);
        uint256 listingId = _list(ALICE, tokenId, 1_000_000);
        vm.prank(BOB);
        usdc.approve(address(marketplace), 1_000_000);
        vm.prank(BOB);
        marketplace.buy(listingId);

        vm.expectRevert(ExtremaMarketplace.ListingNotActive.selector);
        vm.prank(ALICE);
        marketplace.updatePrice(listingId, 2_000_000);
        vm.expectRevert(ExtremaMarketplace.ListingNotActive.selector);
        vm.prank(ALICE);
        marketplace.cancel(listingId);
    }

    function testUpdatePriceRejectedAtCutoff() public {
        uint256 tokenId = _enter(ALICE, _createRound(), 10_000);
        _approveTicket(ALICE, tokenId);
        uint256 listingId = _list(ALICE, tokenId, 1_000_000);
        vm.warp(observationEndAt - 1 hours);
        vm.expectRevert(ExtremaMarketplace.TradingWindowClosed.selector);
        vm.prank(ALICE);
        marketplace.updatePrice(listingId, 2_000_000);
    }

    function testCancelRejectedAtCutoff() public {
        uint256 tokenId = _enter(ALICE, _createRound(), 10_000);
        _approveTicket(ALICE, tokenId);
        uint256 listingId = _list(ALICE, tokenId, 1_000_000);
        vm.warp(observationEndAt - 1 hours);
        vm.expectRevert(ExtremaMarketplace.TradingWindowClosed.selector);
        vm.prank(ALICE);
        marketplace.cancel(listingId);
    }

    function testListingAfterCutoffRejected() public {
        uint256 tokenId = _enter(ALICE, _createRound(), 10_000);
        vm.warp(observationEndAt - 1 hours);
        vm.expectRevert(ExtremaMarketplace.TradingWindowClosed.selector);
        vm.prank(ALICE);
        marketplace.list(address(ticket), tokenId, 1_000_000);
    }

    function testActiveListingCannotBeRelistedUntilCancelled() public {
        uint256 tokenId = _enter(ALICE, _createRound(), 10_000);
        _approveTicket(ALICE, tokenId);
        uint256 listingId = _list(ALICE, tokenId, 1_000_000);
        vm.expectRevert(ExtremaMarketplace.ActiveListingExists.selector);
        vm.prank(ALICE);
        marketplace.list(address(ticket), tokenId, 3_000_000);
        require(marketplace.activeListingId(address(ticket), tokenId) == listingId, "active remains");
    }

    function _createRound() internal returns (uint256) {
        return pool.createRound(openAt, closeAt, observationStartAt, observationEndAt);
    }

    function _enter(address user, uint256 roundId, uint64 prediction) internal returns (uint256 ticketId) {
        vm.prank(user);
        ticketId = pool.enterPrediction(roundId, prediction);
    }

    function _list(address seller, uint256 tokenId, uint256 ask) internal returns (uint256 listingId) {
        vm.prank(seller);
        listingId = marketplace.list(address(ticket), tokenId, ask);
    }

    function _approveTicket(address owner_, uint256 tokenId) internal {
        vm.prank(owner_);
        ticket.approve(address(marketplace), tokenId);
    }

    function _settle(uint256 roundId) internal {
        vm.warp(closeAt);
        pool.lockRound(roundId);
        vm.warp(observationEndAt);
        vm.prank(RESOLVER);
        pool.settleRound(roundId, 10_000);
    }

    function _cancel(uint256 roundId) internal {
        vm.warp(closeAt);
        pool.lockRound(roundId);
        vm.warp(observationEndAt);
        vm.prank(RESOLVER);
        pool.cancelRound(roundId);
    }

    function _fund(address user) internal {
        usdc.mint(user, 100_000_000);
        vm.prank(user);
        usdc.approve(address(pool), type(uint256).max);
    }
}

contract ReentrantUSDC {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    address public attackMarketplace;
    uint256 public attackListingId;
    bool public attack;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function configureAttack(address marketplace, uint256 listingId) external {
        attackMarketplace = marketplace;
        attackListingId = listingId;
        attack = true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 currentAllowance = allowance[from][msg.sender];
        if (currentAllowance != type(uint256).max) {
            require(currentAllowance >= amount, "allowance");
            allowance[from][msg.sender] = currentAllowance - amount;
        }

        if (attack && msg.sender == attackMarketplace) {
            attack = false;
            ExtremaMarketplace(attackMarketplace).buy(attackListingId);
        }

        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}
