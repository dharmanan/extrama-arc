// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ExtremaFactory} from "./ExtremaFactory.sol";
import {ExtremaPool} from "./ExtremaPool.sol";
import {ExtremaTicket} from "./ExtremaTicket.sol";
import {IERC20} from "./interfaces/IERC20.sol";

/// @title ExtremaMarketplace
/// @notice Non-custodial, fixed-price secondary market for EXTREMA tickets.
///
/// Tickets remain in the seller's wallet until a successful purchase. A seller
/// authorises this contract for an individual token with `approve`; no escrow
/// or operator approval is used by the marketplace.
contract ExtremaMarketplace {
    error ZeroAddress();
    error InvalidAskPrice();
    error UnsupportedTicket();
    error TicketNotFound();
    error NotTicketOwner();
    error ActiveListingExists();
    error ListingNotFound();
    error ListingNotActive();
    error NotListingSeller();
    error SellerNotOwner();
    error BuyerIsSeller();
    error RoundNotTradable();
    error TradingWindowClosed();
    error TokenNotApproved();
    error TokenTransferFailed();
    error NftTransferFailed();
    error Reentrancy();

    uint256 internal constant TRADING_CUTOFF = 1 hours;

    enum ListingStatus {
        ACTIVE,
        SOLD,
        CANCELLED
    }

    struct Listing {
        address seller;
        address ticket;
        uint256 tokenId;
        uint256 askUsdc;
        uint256 roundId;
        ListingStatus status;
    }

    IERC20 public immutable USDC;
    ExtremaFactory public immutable FACTORY;

    uint256 public nextListingId = 1;
    mapping(uint256 => Listing) public listings;
    mapping(address => mapping(uint256 => uint256)) public activeListingId;

    uint256 private _reentrancyState = 1;

    event Listed(
        uint256 indexed listingId,
        address indexed seller,
        address indexed ticket,
        uint256 tokenId,
        uint256 askUsdc,
        uint256 roundId
    );
    event ListingPriceUpdated(uint256 indexed listingId, uint256 askUsdc);
    event Cancelled(uint256 indexed listingId);
    event Sold(
        uint256 indexed listingId,
        address indexed seller,
        address indexed buyer,
        address ticket,
        uint256 tokenId,
        uint256 askUsdc
    );

    constructor(address usdc_, address factory_) {
        if (usdc_ == address(0) || factory_ == address(0)) revert ZeroAddress();
        USDC = IERC20(usdc_);
        FACTORY = ExtremaFactory(factory_);
    }

    modifier nonReentrant() {
        if (_reentrancyState != 1) revert Reentrancy();
        _reentrancyState = 2;
        _;
        _reentrancyState = 1;
    }

    /// @notice Create a non-custodial listing for an existing EXTREMA ticket.
    function list(
        address ticket,
        uint256 tokenId,
        uint256 askUsdc
    ) external nonReentrant returns (uint256 listingId) {
        if (ticket == address(0)) revert ZeroAddress();
        if (askUsdc == 0) revert InvalidAskPrice();
        if (activeListingId[ticket][tokenId] != 0) revert ActiveListingExists();

        (, uint256 roundId, ExtremaPool.Round memory round) =
            _resolveTicketRound(ticket, tokenId);
        _requireTradable(round);

        address currentOwner = _ownerOf(ticket, tokenId);
        if (currentOwner != msg.sender) revert NotTicketOwner();

        listingId = nextListingId++;
        listings[listingId] = Listing({
            seller: msg.sender,
            ticket: ticket,
            tokenId: tokenId,
            askUsdc: askUsdc,
            roundId: roundId,
            status: ListingStatus.ACTIVE
        });
        activeListingId[ticket][tokenId] = listingId;

        emit Listed(listingId, msg.sender, ticket, tokenId, askUsdc, roundId);
    }

    /// @notice Update an active listing's fixed ask price.
    function updatePrice(uint256 listingId, uint256 newAskUsdc) external nonReentrant {
        if (newAskUsdc == 0) revert InvalidAskPrice();

        Listing storage listing = _activeListing(listingId);
        if (listing.seller != msg.sender) revert NotListingSeller();

        (, uint256 roundId, ExtremaPool.Round memory round) =
            _resolveTicketRound(listing.ticket, listing.tokenId);
        _requireTradable(round);

        if (_ownerOf(listing.ticket, listing.tokenId) != msg.sender) revert SellerNotOwner();

        listing.askUsdc = newAskUsdc;
        listing.roundId = roundId;
        emit ListingPriceUpdated(listingId, newAskUsdc);
    }

    /// @notice Cancel an active listing while its round is still tradable.
    function cancel(uint256 listingId) external nonReentrant {
        Listing storage listing = _activeListing(listingId);
        if (listing.seller != msg.sender) revert NotListingSeller();

        (, uint256 roundId, ExtremaPool.Round memory round) =
            _resolveTicketRound(listing.ticket, listing.tokenId);
        _requireTradable(round);

        listing.status = ListingStatus.CANCELLED;
        listing.roundId = roundId;
        delete activeListingId[listing.ticket][listing.tokenId];
        emit Cancelled(listingId);
    }

    /// @notice Atomically exchange exact USDC for the approved ticket NFT.
    function buy(uint256 listingId) external nonReentrant {
        Listing storage listing = _activeListing(listingId);
        if (msg.sender == listing.seller) revert BuyerIsSeller();

        (, , ExtremaPool.Round memory round) =
            _resolveTicketRound(listing.ticket, listing.tokenId);
        _requireTradable(round);

        if (_ownerOf(listing.ticket, listing.tokenId) != listing.seller) {
            revert SellerNotOwner();
        }
        if (_approvedForToken(listing.ticket, listing.tokenId) != address(this)) {
            revert TokenNotApproved();
        }

        // Effects precede both external calls. Any failed interaction reverts
        // the complete transaction, restoring these values atomically.
        listing.status = ListingStatus.SOLD;
        delete activeListingId[listing.ticket][listing.tokenId];

        _safeTransferFrom(msg.sender, listing.seller, listing.askUsdc);
        _safeNftTransfer(listing.ticket, listing.seller, msg.sender, listing.tokenId);

        emit Sold(
            listingId,
            listing.seller,
            msg.sender,
            listing.ticket,
            listing.tokenId,
            listing.askUsdc
        );
    }

    function getListing(uint256 listingId) external view returns (Listing memory) {
        Listing memory listing = listings[listingId];
        if (listing.seller == address(0)) revert ListingNotFound();
        return listing;
    }

    /// @notice Returns whether an active listing currently satisfies every buy gate.
    function isListingBuyable(uint256 listingId) external view returns (bool) {
        Listing memory listing = listings[listingId];
        if (listing.seller == address(0) || listing.status != ListingStatus.ACTIVE) return false;

        try ExtremaTicket(listing.ticket).ownerOf(listing.tokenId) returns (address owner_) {
            if (owner_ != listing.seller) return false;
        } catch {
            return false;
        }

        try ExtremaTicket(listing.ticket).getApproved(listing.tokenId) returns (address approved) {
            if (approved != address(this)) return false;
        } catch {
            return false;
        }

        try this._viewResolveTradable(listing.ticket, listing.tokenId) returns (bool tradable) {
            return tradable;
        } catch {
            return false;
        }
    }

    // External view adapter lets isListingBuyable convert canonical resolver
    // failures into a simple false without weakening state-changing gates.
    function _viewResolveTradable(address ticket, uint256 tokenId) external view returns (bool) {
        if (msg.sender != address(this)) revert UnsupportedTicket();
        (, , ExtremaPool.Round memory round) = _resolveTicketRound(ticket, tokenId);
        if (round.status != ExtremaPool.RoundStatus.ENTRY_OPEN
            && round.status != ExtremaPool.RoundStatus.LOCKED) return false;
        if (round.observationEndAt <= TRADING_CUTOFF) return false;
        return block.timestamp < uint256(round.observationEndAt) - TRADING_CUTOFF;
    }

    function _activeListing(uint256 listingId) internal view returns (Listing storage listing) {
        listing = listings[listingId];
        if (listing.seller == address(0)) revert ListingNotFound();
        if (listing.status != ListingStatus.ACTIVE) revert ListingNotActive();
    }

    function _resolveTicketRound(
        address ticket,
        uint256 tokenId
    ) internal view returns (ExtremaPool pool, uint256 roundId, ExtremaPool.Round memory round) {
        pool = _resolvePool(ticket);
        roundId = _entryRoundId(pool, tokenId);

        try pool.getRound(roundId) returns (ExtremaPool.Round memory loadedRound) {
            round = loadedRound;
        } catch {
            revert TicketNotFound();
        }
    }

    function _resolvePool(address ticket) internal view returns (ExtremaPool pool) {
        address poolAddress;
        try ExtremaTicket(ticket).MINTER() returns (address minter) {
            poolAddress = minter;
        } catch {
            revert UnsupportedTicket();
        }

        if (poolAddress == address(0) || !FACTORY.isRegisteredPool(poolAddress)) {
            revert UnsupportedTicket();
        }

        pool = ExtremaPool(poolAddress);
        try pool.TICKET() returns (ExtremaTicket pairedTicket) {
            if (address(pairedTicket) != ticket) revert UnsupportedTicket();
        } catch {
            revert UnsupportedTicket();
        }
        try pool.USDC() returns (IERC20 poolUsdc) {
            if (address(poolUsdc) != address(USDC)) revert UnsupportedTicket();
        } catch {
            revert UnsupportedTicket();
        }
    }

    function _entryRoundId(ExtremaPool pool, uint256 tokenId) internal view returns (uint256 roundId) {
        uint256 storedTicketId;
        try pool.entries(tokenId) returns (
            uint256 entryTicketId,
            uint256 entryRoundId,
            address originalEntrant,
            uint64 predictionPriceCents,
            uint64 entrySequence
        ) {
            storedTicketId = entryTicketId;
            roundId = entryRoundId;
        } catch {
            revert TicketNotFound();
        }
        if (storedTicketId == 0 || roundId == 0) revert TicketNotFound();
    }

    function _requireTradable(ExtremaPool.Round memory round) internal view {
        if (
            round.status != ExtremaPool.RoundStatus.ENTRY_OPEN
                && round.status != ExtremaPool.RoundStatus.LOCKED
        ) revert RoundNotTradable();
        if (round.observationEndAt <= TRADING_CUTOFF) revert TradingWindowClosed();
        if (block.timestamp >= uint256(round.observationEndAt) - TRADING_CUTOFF) {
            revert TradingWindowClosed();
        }
    }

    function _ownerOf(address ticket, uint256 tokenId) internal view returns (address owner_) {
        try ExtremaTicket(ticket).ownerOf(tokenId) returns (address currentOwner) {
            owner_ = currentOwner;
        } catch {
            revert TicketNotFound();
        }
    }

    function _approvedForToken(address ticket, uint256 tokenId) internal view returns (address approved) {
        try ExtremaTicket(ticket).getApproved(tokenId) returns (address currentApproval) {
            approved = currentApproval;
        } catch {
            revert TicketNotFound();
        }
    }

    function _safeTransferFrom(address from, address to, uint256 amount) internal {
        try USDC.transferFrom(from, to, amount) returns (bool success) {
            if (!success) revert TokenTransferFailed();
        } catch {
            revert TokenTransferFailed();
        }
    }

    function _safeNftTransfer(address ticket, address from, address to, uint256 tokenId) internal {
        try ExtremaTicket(ticket).transferFrom(from, to, tokenId) {
            // no-op
        } catch {
            revert NftTransferFailed();
        }
    }
}
