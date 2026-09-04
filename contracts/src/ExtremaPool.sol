// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ExtremaTicket} from "./ExtremaTicket.sol";
import {IERC20} from "./interfaces/IERC20.sol";

interface IERC20Balance is IERC20 {
    function balanceOf(address account) external view returns (uint256);
}

contract ExtremaPool {
    error ZeroAddress();
    error NotOwner();
    error NotResolver();
    error InvalidTimestamps();
    error RoundNotFound();
    error RoundNotOpen();
    error EntryNotStarted();
    error EntryClosed();
    error AlreadyEntered();
    error PriceAlreadyTaken();
    error InvalidPredictionPrice();
    error RoundNotLockable();
    error RoundNotLocked();
    error ObservationNotEnded();
    error NotEnoughEntries();
    error TooManyEntriesForCancellation();
    error TokenTransferFailed();
    error NotTicketOwner();
    error NothingToClaim();
    error AlreadyClaimed();
    error AlreadyRefunded();
    error RoundNotSettled();
    error RoundNotCancelled();
    error Reentrancy();
    error ExcessAmountUnavailable();

    uint256 public constant STAKE_AMOUNT = 1_000_000;
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant FIRST_BPS = 5_400;
    uint256 public constant SECOND_BPS = 2_250;
    uint256 public constant THIRD_BPS = 1_350;
    uint256 public constant MIN_ENTRIES = 3;

    enum Asset { BTC, ETH, SOL, HYPE }
    enum Direction { HIGH, LOW }
    enum Cadence { DAILY, WEEKLY, QUARTERLY }
    enum RoundStatus { ENTRY_OPEN, LOCKED, SETTLED, CANCELLED }

    struct Round {
        uint64 entryOpenAt;
        uint64 entryCloseAt;
        uint64 observationStartAt;
        uint64 observationEndAt;
        RoundStatus status;
        uint64 entryCount;
        uint64 nextEntrySequence;
        uint256 totalStake;
        uint256 escrowRemaining;
        uint64 resolvedPriceCents;
        uint256[3] winnerTicketIds;
    }

    struct Entry {
        uint256 ticketId;
        uint256 roundId;
        address originalEntrant;
        uint64 predictionPriceCents;
        uint64 entrySequence;
    }

    IERC20Balance public immutable USDC;
    address public immutable TREASURY;
    ExtremaTicket public immutable TICKET;

    Asset public immutable ASSET;
    Direction public immutable DIRECTION;
    Cadence public immutable CADENCE;

    address public owner;
    address public resolver;

    uint256 public nextRoundId = 1;
    uint256 public nextTicketId = 1;
    uint256 public totalReservedUSDC;

    mapping(uint256 => Round) private _rounds;
    mapping(uint256 => Entry) public entries;
    mapping(uint256 => uint256[]) private _roundTicketIds;
    mapping(uint256 => mapping(address => bool)) public hasEntered;
    mapping(uint256 => mapping(uint64 => bool)) public predictionTaken;
    mapping(uint256 => uint256) public claimableByTicket;
    mapping(uint256 => bool) public claimed;
    mapping(uint256 => bool) public refunded;

    uint256 private _reentrancyState = 1;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ResolverUpdated(address indexed previousResolver, address indexed newResolver);
    event RoundCreated(
        uint256 indexed roundId,
        uint64 entryOpenAt,
        uint64 entryCloseAt,
        uint64 observationStartAt,
        uint64 observationEndAt
    );
    event RoundLocked(uint256 indexed roundId);
    event PredictionEntered(
        uint256 indexed roundId,
        uint256 indexed ticketId,
        address indexed entrant,
        uint64 predictionPriceCents,
        uint64 entrySequence
    );
    event RoundSettled(
        uint256 indexed roundId,
        uint64 resolvedPriceCents,
        uint256 firstTicketId,
        uint256 secondTicketId,
        uint256 thirdTicketId
    );
    event RoundCancelled(uint256 indexed roundId);
    event RewardClaimed(
        uint256 indexed roundId,
        uint256 indexed ticketId,
        address indexed owner,
        uint256 amount
    );
    event RefundClaimed(
        uint256 indexed roundId,
        uint256 indexed ticketId,
        address indexed owner,
        uint256 amount
    );
    event TreasuryAllocated(uint256 indexed roundId, address indexed treasury, uint256 amount);
    event ExcessUSDCRescued(address indexed owner, uint256 amount);

    constructor(
        address usdc_,
        address treasury_,
        address resolver_,
        address owner_,
        address renderer_,
        address rendererAdmin_,
        Asset asset_,
        Direction direction_,
        Cadence cadence_
    ) {
        if (
            usdc_ == address(0)
                || treasury_ == address(0)
                || resolver_ == address(0)
                || owner_ == address(0)
                || renderer_ == address(0)
                || rendererAdmin_ == address(0)
        ) revert ZeroAddress();

        USDC = IERC20Balance(usdc_);
        TREASURY = treasury_;
        resolver = resolver_;
        owner = owner_;

        ASSET = asset_;
        DIRECTION = direction_;
        CADENCE = cadence_;

        TICKET = new ExtremaTicket(
            address(this),
            rendererAdmin_,
            renderer_,
            _collectionName(asset_, direction_, cadence_),
            _collectionSymbol(asset_, direction_, cadence_)
        );

        emit OwnershipTransferred(address(0), owner_);
        emit ResolverUpdated(address(0), resolver_);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyResolver() {
        if (msg.sender != resolver) revert NotResolver();
        _;
    }

    modifier nonReentrant() {
        if (_reentrancyState != 1) revert Reentrancy();
        _reentrancyState = 2;
        _;
        _reentrancyState = 1;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();

        address previousOwner = owner;
        owner = newOwner;

        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function setResolver(address newResolver) external onlyOwner {
        if (newResolver == address(0)) revert ZeroAddress();

        address previousResolver = resolver;
        resolver = newResolver;

        emit ResolverUpdated(previousResolver, newResolver);
    }

    function createRound(
        uint64 entryOpenAt,
        uint64 entryCloseAt,
        uint64 observationStartAt,
        uint64 observationEndAt
    ) external onlyOwner returns (uint256 roundId) {
        if (
            entryOpenAt >= entryCloseAt
                || entryCloseAt > observationStartAt
                || observationStartAt >= observationEndAt
        ) revert InvalidTimestamps();

        roundId = nextRoundId++;

        Round storage round = _rounds[roundId];
        round.entryOpenAt = entryOpenAt;
        round.entryCloseAt = entryCloseAt;
        round.observationStartAt = observationStartAt;
        round.observationEndAt = observationEndAt;
        round.status = RoundStatus.ENTRY_OPEN;
        round.nextEntrySequence = 1;

        emit RoundCreated(
            roundId,
            entryOpenAt,
            entryCloseAt,
            observationStartAt,
            observationEndAt
        );
    }

    function enterPrediction(
        uint256 roundId,
        uint64 predictionPriceCents
    ) external nonReentrant returns (uint256 ticketId) {
        Round storage round = _requireRound(roundId);

        if (round.status != RoundStatus.ENTRY_OPEN) revert RoundNotOpen();
        if (block.timestamp < round.entryOpenAt) revert EntryNotStarted();
        if (block.timestamp >= round.entryCloseAt) revert EntryClosed();
        if (predictionPriceCents == 0) revert InvalidPredictionPrice();
        if (hasEntered[roundId][msg.sender]) revert AlreadyEntered();
        if (predictionTaken[roundId][predictionPriceCents]) revert PriceAlreadyTaken();

        ticketId = nextTicketId++;
        uint64 entrySequence = round.nextEntrySequence++;

        hasEntered[roundId][msg.sender] = true;
        predictionTaken[roundId][predictionPriceCents] = true;

        round.entryCount += 1;
        round.totalStake += STAKE_AMOUNT;
        round.escrowRemaining += STAKE_AMOUNT;
        totalReservedUSDC += STAKE_AMOUNT;

        entries[ticketId] = Entry({
            ticketId: ticketId,
            roundId: roundId,
            originalEntrant: msg.sender,
            predictionPriceCents: predictionPriceCents,
            entrySequence: entrySequence
        });

        _roundTicketIds[roundId].push(ticketId);

        emit PredictionEntered(
            roundId,
            ticketId,
            msg.sender,
            predictionPriceCents,
            entrySequence
        );

        if (!USDC.transferFrom(msg.sender, address(this), STAKE_AMOUNT)) {
            revert TokenTransferFailed();
        }

        TICKET.mint(msg.sender, ticketId);
    }

    function lockRound(uint256 roundId) external {
        Round storage round = _requireRound(roundId);

        if (
            round.status != RoundStatus.ENTRY_OPEN
                || block.timestamp < round.entryCloseAt
        ) revert RoundNotLockable();

        round.status = RoundStatus.LOCKED;
        emit RoundLocked(roundId);
    }

    function settleRound(
        uint256 roundId,
        uint64 resolvedPriceCents
    ) external nonReentrant onlyResolver {
        Round storage round = _requireRound(roundId);

        if (round.status != RoundStatus.LOCKED) revert RoundNotLocked();
        if (block.timestamp < round.observationEndAt) revert ObservationNotEnded();
        if (round.entryCount < MIN_ENTRIES) revert NotEnoughEntries();
        if (resolvedPriceCents == 0) revert InvalidPredictionPrice();

        uint256[3] memory winners = _selectWinners(roundId, resolvedPriceCents);

        uint256 grossPool = round.totalStake;
        uint256 firstAmount = (grossPool * FIRST_BPS) / BPS_DENOMINATOR;
        uint256 secondAmount = (grossPool * SECOND_BPS) / BPS_DENOMINATOR;
        uint256 thirdAmount = (grossPool * THIRD_BPS) / BPS_DENOMINATOR;
        uint256 treasuryAmount = grossPool - firstAmount - secondAmount - thirdAmount;
        uint256 winnerReserve = firstAmount + secondAmount + thirdAmount;

        round.resolvedPriceCents = resolvedPriceCents;
        round.winnerTicketIds = winners;
        round.status = RoundStatus.SETTLED;

        claimableByTicket[winners[0]] = firstAmount;
        claimableByTicket[winners[1]] = secondAmount;
        claimableByTicket[winners[2]] = thirdAmount;

        round.escrowRemaining = winnerReserve;
        totalReservedUSDC -= treasuryAmount;

        emit TreasuryAllocated(roundId, TREASURY, treasuryAmount);
        emit RoundSettled(
            roundId,
            resolvedPriceCents,
            winners[0],
            winners[1],
            winners[2]
        );

        if (!USDC.transfer(TREASURY, treasuryAmount)) revert TokenTransferFailed();
    }

    function cancelRound(uint256 roundId) external onlyResolver {
        Round storage round = _requireRound(roundId);

        if (round.status != RoundStatus.LOCKED) revert RoundNotLocked();
        if (block.timestamp < round.observationEndAt) revert ObservationNotEnded();
        if (round.entryCount >= MIN_ENTRIES) revert TooManyEntriesForCancellation();

        round.status = RoundStatus.CANCELLED;

        emit RoundCancelled(roundId);
    }

    function claim(uint256 ticketId) external nonReentrant {
        Entry memory entry = _requireEntry(ticketId);
        Round storage round = _rounds[entry.roundId];

        if (round.status != RoundStatus.SETTLED) revert RoundNotSettled();
        if (claimed[ticketId]) revert AlreadyClaimed();

        uint256 amount = claimableByTicket[ticketId];
        if (amount == 0) revert NothingToClaim();

        address currentOwner = TICKET.ownerOf(ticketId);
        if (msg.sender != currentOwner) revert NotTicketOwner();

        claimed[ticketId] = true;
        claimableByTicket[ticketId] = 0;
        round.escrowRemaining -= amount;
        totalReservedUSDC -= amount;

        emit RewardClaimed(entry.roundId, ticketId, currentOwner, amount);

        if (!USDC.transfer(currentOwner, amount)) revert TokenTransferFailed();
    }

    function refund(uint256 ticketId) external nonReentrant {
        Entry memory entry = _requireEntry(ticketId);
        Round storage round = _rounds[entry.roundId];

        if (round.status != RoundStatus.CANCELLED) revert RoundNotCancelled();
        if (refunded[ticketId]) revert AlreadyRefunded();

        address currentOwner = TICKET.ownerOf(ticketId);
        if (msg.sender != currentOwner) revert NotTicketOwner();

        refunded[ticketId] = true;
        round.escrowRemaining -= STAKE_AMOUNT;
        totalReservedUSDC -= STAKE_AMOUNT;

        emit RefundClaimed(entry.roundId, ticketId, currentOwner, STAKE_AMOUNT);

        if (!USDC.transfer(currentOwner, STAKE_AMOUNT)) revert TokenTransferFailed();
    }

    function rescueExcessUSDC(uint256 amount) external onlyOwner nonReentrant {
        uint256 balance = USDC.balanceOf(address(this));

        if (balance < totalReservedUSDC) revert ExcessAmountUnavailable();

        uint256 excess = balance - totalReservedUSDC;
        if (amount == 0 || amount > excess) revert ExcessAmountUnavailable();

        emit ExcessUSDCRescued(owner, amount);

        if (!USDC.transfer(owner, amount)) revert TokenTransferFailed();
    }

    function excessUSDC() external view returns (uint256) {
        uint256 balance = USDC.balanceOf(address(this));
        return balance > totalReservedUSDC ? balance - totalReservedUSDC : 0;
    }

    function escrowInvariantHolds() external view returns (bool) {
        return USDC.balanceOf(address(this)) >= totalReservedUSDC;
    }

    function getRound(uint256 roundId) external view returns (Round memory) {
        Round storage round = _requireRound(roundId);
        return round;
    }

    function getRoundTicketIds(uint256 roundId) external view returns (uint256[] memory) {
        _requireRound(roundId);
        return _roundTicketIds[roundId];
    }

    function getWinners(uint256 roundId) external view returns (uint256[3] memory) {
        Round storage round = _requireRound(roundId);
        return round.winnerTicketIds;
    }

    function getTicketMetadata(
        uint256 ticketId
    )
        external
        view
        returns (
            uint256 roundId,
            uint64 predictionPriceCents,
            uint64 entrySequence,
            uint8 roundStatus,
            uint8 placement,
            bool isClaimed,
            bool isRefunded
        )
    {
        Entry memory entry = _requireEntry(ticketId);
        Round storage round = _rounds[entry.roundId];

        return (
            entry.roundId,
            entry.predictionPriceCents,
            entry.entrySequence,
            uint8(round.status),
            _placement(round, ticketId),
            claimed[ticketId],
            refunded[ticketId]
        );
    }

    function _placement(Round storage round, uint256 ticketId) internal view returns (uint8) {
        if (round.status != RoundStatus.SETTLED) return 0;
        if (round.winnerTicketIds[0] == ticketId) return 1;
        if (round.winnerTicketIds[1] == ticketId) return 2;
        if (round.winnerTicketIds[2] == ticketId) return 3;
        return 0;
    }

    function _selectWinners(
        uint256 roundId,
        uint64 resolvedPriceCents
    ) internal view returns (uint256[3] memory winners) {
        uint256[] storage ticketIds = _roundTicketIds[roundId];

        for (uint256 i = 0; i < ticketIds.length; ++i) {
            uint256 candidate = ticketIds[i];

            if (_isBetter(candidate, winners[0], resolvedPriceCents)) {
                winners[2] = winners[1];
                winners[1] = winners[0];
                winners[0] = candidate;
            } else if (_isBetter(candidate, winners[1], resolvedPriceCents)) {
                winners[2] = winners[1];
                winners[1] = candidate;
            } else if (_isBetter(candidate, winners[2], resolvedPriceCents)) {
                winners[2] = candidate;
            }
        }
    }

    function _isBetter(
        uint256 candidateTicketId,
        uint256 incumbentTicketId,
        uint64 resolvedPriceCents
    ) internal view returns (bool) {
        if (incumbentTicketId == 0) return true;

        Entry storage candidate = entries[candidateTicketId];
        Entry storage incumbent = entries[incumbentTicketId];

        uint256 candidateDistance = _distance(
            candidate.predictionPriceCents,
            resolvedPriceCents
        );
        uint256 incumbentDistance = _distance(
            incumbent.predictionPriceCents,
            resolvedPriceCents
        );

        if (candidateDistance != incumbentDistance) {
            return candidateDistance < incumbentDistance;
        }

        if (candidate.entrySequence != incumbent.entrySequence) {
            return candidate.entrySequence < incumbent.entrySequence;
        }

        return candidateTicketId < incumbentTicketId;
    }

    function _distance(uint64 a, uint64 b) internal pure returns (uint256) {
        return a >= b ? uint256(a - b) : uint256(b - a);
    }

    function _requireRound(uint256 roundId) internal view returns (Round storage round) {
        round = _rounds[roundId];
        if (round.entryCloseAt == 0) revert RoundNotFound();
    }

    function _requireEntry(uint256 ticketId) internal view returns (Entry memory entry) {
        entry = entries[ticketId];
        if (entry.ticketId == 0) revert RoundNotFound();
    }

    function _collectionName(
        Asset asset_,
        Direction direction_,
        Cadence cadence_
    ) internal pure returns (string memory) {
        return string.concat(
            "EXTREMA ",
            _assetName(asset_),
            " ",
            _cadenceName(cadence_),
            " ",
            _directionName(direction_)
        );
    }

    function _collectionSymbol(
        Asset asset_,
        Direction direction_,
        Cadence cadence_
    ) internal pure returns (string memory) {
        return string.concat(
            "X",
            _assetName(asset_),
            "-",
            _cadenceShort(cadence_),
            "-",
            direction_ == Direction.HIGH ? "H" : "L"
        );
    }

    function _assetName(Asset value) internal pure returns (string memory) {
        if (value == Asset.BTC) return "BTC";
        if (value == Asset.ETH) return "ETH";
        if (value == Asset.SOL) return "SOL";
        return "HYPE";
    }

    function _directionName(Direction value) internal pure returns (string memory) {
        return value == Direction.HIGH ? "HIGH" : "LOW";
    }

    function _cadenceName(Cadence value) internal pure returns (string memory) {
        if (value == Cadence.DAILY) return "DAILY";
        if (value == Cadence.WEEKLY) return "WEEKLY";
        return "QUARTERLY";
    }

    function _cadenceShort(Cadence value) internal pure returns (string memory) {
        if (value == Cadence.DAILY) return "D";
        if (value == Cadence.WEEKLY) return "W";
        return "Q";
    }
}
