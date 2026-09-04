// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ExtremaTicket} from "./ExtremaTicket.sol";

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
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
        Asset asset;
        Direction direction;
        Cadence cadence;
        uint64 entryOpenAt;
        uint64 entryCloseAt;
        uint64 observationStartAt;
        uint64 observationEndAt;
        RoundStatus status;
        uint64 entryCount;
        uint64 nextEntrySequence;
        uint256 totalStake;
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

    IERC20 public immutable usdc;
    address public immutable treasury;
    ExtremaTicket public immutable ticket;

    address public owner;
    address public resolver;

    uint256 public nextRoundId = 1;
    uint256 public nextTicketId = 1;

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
        Asset asset,
        Direction direction,
        Cadence cadence,
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

    constructor(address usdc_, address treasury_, address resolver_) {
        if (usdc_ == address(0) || treasury_ == address(0) || resolver_ == address(0)) {
            revert ZeroAddress();
        }

        usdc = IERC20(usdc_);
        treasury = treasury_;
        resolver = resolver_;
        owner = msg.sender;
        ticket = new ExtremaTicket(address(this));

        emit OwnershipTransferred(address(0), msg.sender);
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
        Asset asset,
        Direction direction,
        Cadence cadence,
        uint64 entryOpenAt,
        uint64 entryCloseAt,
        uint64 observationStartAt,
        uint64 observationEndAt
    ) external onlyOwner returns (uint256 roundId) {
        if (
            entryOpenAt >= entryCloseAt ||
            entryCloseAt > observationStartAt ||
            observationStartAt >= observationEndAt
        ) {
            revert InvalidTimestamps();
        }

        roundId = nextRoundId++;
        Round storage round = _rounds[roundId];

        round.asset = asset;
        round.direction = direction;
        round.cadence = cadence;
        round.entryOpenAt = entryOpenAt;
        round.entryCloseAt = entryCloseAt;
        round.observationStartAt = observationStartAt;
        round.observationEndAt = observationEndAt;
        round.status = RoundStatus.ENTRY_OPEN;
        round.nextEntrySequence = 1;

        emit RoundCreated(
            roundId,
            asset,
            direction,
            cadence,
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

        entries[ticketId] = Entry({
            ticketId: ticketId,
            roundId: roundId,
            originalEntrant: msg.sender,
            predictionPriceCents: predictionPriceCents,
            entrySequence: entrySequence
        });
        _roundTicketIds[roundId].push(ticketId);

        _safeTransferFrom(msg.sender, address(this), STAKE_AMOUNT);
        ticket.mint(msg.sender, ticketId);

        emit PredictionEntered(
            roundId,
            ticketId,
            msg.sender,
            predictionPriceCents,
            entrySequence
        );
    }

    function lockRound(uint256 roundId) external {
        Round storage round = _requireRound(roundId);
        if (
            round.status != RoundStatus.ENTRY_OPEN ||
            block.timestamp < round.entryCloseAt
        ) {
            revert RoundNotLockable();
        }

        round.status = RoundStatus.LOCKED;
        emit RoundLocked(roundId);
    }

    function settleRound(
        uint256 roundId,
        uint64 resolvedPriceCents
    ) external onlyResolver nonReentrant {
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

        round.resolvedPriceCents = resolvedPriceCents;
        round.winnerTicketIds = winners;
        round.status = RoundStatus.SETTLED;

        claimableByTicket[winners[0]] = firstAmount;
        claimableByTicket[winners[1]] = secondAmount;
        claimableByTicket[winners[2]] = thirdAmount;

        _safeTransfer(treasury, treasuryAmount);

        emit TreasuryAllocated(roundId, treasury, treasuryAmount);
        emit RoundSettled(
            roundId,
            resolvedPriceCents,
            winners[0],
            winners[1],
            winners[2]
        );
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

        address currentOwner = ticket.ownerOf(ticketId);
        if (msg.sender != currentOwner) revert NotTicketOwner();

        claimed[ticketId] = true;
        claimableByTicket[ticketId] = 0;

        _safeTransfer(currentOwner, amount);

        emit RewardClaimed(entry.roundId, ticketId, currentOwner, amount);
    }

    function refund(uint256 ticketId) external nonReentrant {
        Entry memory entry = _requireEntry(ticketId);
        Round storage round = _rounds[entry.roundId];

        if (round.status != RoundStatus.CANCELLED) revert RoundNotCancelled();
        if (refunded[ticketId]) revert AlreadyRefunded();

        address currentOwner = ticket.ownerOf(ticketId);
        if (msg.sender != currentOwner) revert NotTicketOwner();

        refunded[ticketId] = true;
        _safeTransfer(currentOwner, STAKE_AMOUNT);

        emit RefundClaimed(entry.roundId, ticketId, currentOwner, STAKE_AMOUNT);
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

        uint256 candidateDistance = _distance(candidate.predictionPriceCents, resolvedPriceCents);
        uint256 incumbentDistance = _distance(incumbent.predictionPriceCents, resolvedPriceCents);

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

    function _safeTransfer(address to, uint256 amount) internal {
        (bool success, bytes memory data) = address(usdc).call(
            abi.encodeCall(IERC20.transfer, (to, amount))
        );
        if (!success || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert TokenTransferFailed();
        }
    }

    function _safeTransferFrom(address from, address to, uint256 amount) internal {
        (bool success, bytes memory data) = address(usdc).call(
            abi.encodeCall(IERC20.transferFrom, (from, to, amount))
        );
        if (!success || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert TokenTransferFailed();
        }
    }
}
