// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ExtremaFactory} from "../contracts/src/ExtremaFactory.sol";
import {ExtremaPool} from "../contracts/src/ExtremaPool.sol";

interface IRoundVm {
    function envUint(string calldata name) external returns (uint256 value);
    function addr(uint256 privateKey) external returns (address keyAddr);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

contract CreateStandardRounds {
    IRoundVm private constant VM =
        IRoundVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 public constant ARC_TESTNET_CHAIN_ID = 5_042_002;
    ExtremaFactory public constant FACTORY =
        ExtremaFactory(0xa7Bff22811Bb1BA9297DFaA611De58E3bc186D7A);

    error WrongChain(uint256 actual);
    error WrongDeployer(address actual, address expected);
    error ExistingRound(address pool, uint256 nextRoundId);
    error InvalidPlan();
    error UnexpectedPoolCount(uint256 count);
    error RoundVerificationFailed(address pool);

    function run() external returns (uint256 createdRounds) {
        if (block.chainid != ARC_TESTNET_CHAIN_ID) revert WrongChain(block.chainid);

        uint256 deployerPrivateKey = VM.envUint("EXTREMA_DEPLOYER_PRIVATE_KEY");
        address deployer = VM.addr(deployerPrivateKey);

        if (FACTORY.owner() != deployer || FACTORY.POOL_ADMIN() != deployer) {
            revert WrongDeployer(deployer, FACTORY.owner());
        }

        uint64 dailyClose = _envUint64("EXTREMA_DAILY_ENTRY_CLOSE_AT");
        uint64 dailyStart = _envUint64("EXTREMA_DAILY_OBSERVATION_START_AT");
        uint64 dailyEnd = _envUint64("EXTREMA_DAILY_OBSERVATION_END_AT");

        uint64 weeklyClose = _envUint64("EXTREMA_WEEKLY_ENTRY_CLOSE_AT");
        uint64 weeklyStart = _envUint64("EXTREMA_WEEKLY_OBSERVATION_START_AT");
        uint64 weeklyEnd = _envUint64("EXTREMA_WEEKLY_OBSERVATION_END_AT");

        uint64 quarterlyClose = _envUint64("EXTREMA_QUARTERLY_ENTRY_CLOSE_AT");
        uint64 quarterlyStart = _envUint64("EXTREMA_QUARTERLY_OBSERVATION_START_AT");
        uint64 quarterlyEnd = _envUint64("EXTREMA_QUARTERLY_OBSERVATION_END_AT");

        _validatePlan(dailyClose, dailyStart, dailyEnd, 4 hours, 1 days);
        _validatePlan(weeklyClose, weeklyStart, weeklyEnd, 1 days, 7 days);
        _validateQuarterlyPlan(quarterlyClose, quarterlyStart, quarterlyEnd);

        address[] memory pools = FACTORY.pools();
        if (pools.length != 24) revert UnexpectedPoolCount(pools.length);

        // Safety gate: this script is only for the first standard Round #1.
        for (uint256 i = 0; i < pools.length; ++i) {
            uint256 nextRoundId = ExtremaPool(pools[i]).nextRoundId();
            if (nextRoundId != 1) revert ExistingRound(pools[i], nextRoundId);
        }

        uint64 entryOpenAt = uint64(block.timestamp);
        if (
            entryOpenAt >= dailyClose
                || entryOpenAt >= weeklyClose
                || entryOpenAt >= quarterlyClose
        ) revert InvalidPlan();

        VM.startBroadcast(deployerPrivateKey);

        for (uint256 i = 0; i < pools.length; ++i) {
            ExtremaPool pool = ExtremaPool(pools[i]);

            (
                uint64 entryCloseAt,
                uint64 observationStartAt,
                uint64 observationEndAt
            ) = _timesForCadence(
                pool.CADENCE(),
                dailyClose,
                dailyStart,
                dailyEnd,
                weeklyClose,
                weeklyStart,
                weeklyEnd,
                quarterlyClose,
                quarterlyStart,
                quarterlyEnd
            );

            uint256 roundId = pool.createRound(
                entryOpenAt,
                entryCloseAt,
                observationStartAt,
                observationEndAt
            );

            if (roundId != 1) revert RoundVerificationFailed(address(pool));
            ++createdRounds;
        }

        VM.stopBroadcast();

        // Verify the simulated/broadcast state of every pool.
        for (uint256 i = 0; i < pools.length; ++i) {
            ExtremaPool pool = ExtremaPool(pools[i]);
            if (pool.nextRoundId() != 2) revert RoundVerificationFailed(address(pool));

            ExtremaPool.Round memory round = pool.getRound(1);
            (
                uint64 expectedClose,
                uint64 expectedStart,
                uint64 expectedEnd
            ) = _timesForCadence(
                pool.CADENCE(),
                dailyClose,
                dailyStart,
                dailyEnd,
                weeklyClose,
                weeklyStart,
                weeklyEnd,
                quarterlyClose,
                quarterlyStart,
                quarterlyEnd
            );

            if (
                round.entryOpenAt != entryOpenAt
                    || round.entryCloseAt != expectedClose
                    || round.observationStartAt != expectedStart
                    || round.observationEndAt != expectedEnd
                    || uint8(round.status) != uint8(ExtremaPool.RoundStatus.ENTRY_OPEN)
                    || round.entryCount != 0
            ) revert RoundVerificationFailed(address(pool));
        }
    }

    function _envUint64(string memory name) internal returns (uint64 value) {
        uint256 raw = VM.envUint(name);
        if (raw > type(uint64).max) revert InvalidPlan();
        value = uint64(raw);
    }

    function _validatePlan(
        uint64 closeAt,
        uint64 startAt,
        uint64 endAt,
        uint256 requiredLead,
        uint256 requiredDuration
    ) internal pure {
        if (
            uint256(closeAt) + requiredLead != uint256(startAt)
                || uint256(startAt) + requiredDuration != uint256(endAt)
        ) revert InvalidPlan();
    }

    function _validateQuarterlyPlan(
        uint64 closeAt,
        uint64 startAt,
        uint64 endAt
    ) internal pure {
        if (
            uint256(closeAt) + 1 days != uint256(startAt)
                || endAt <= startAt
                || uint256(endAt) - uint256(startAt) < 89 days
                || uint256(endAt) - uint256(startAt) > 92 days
        ) revert InvalidPlan();
    }

    function _timesForCadence(
        ExtremaPool.Cadence cadence,
        uint64 dailyClose,
        uint64 dailyStart,
        uint64 dailyEnd,
        uint64 weeklyClose,
        uint64 weeklyStart,
        uint64 weeklyEnd,
        uint64 quarterlyClose,
        uint64 quarterlyStart,
        uint64 quarterlyEnd
    )
        internal
        pure
        returns (uint64 closeAt, uint64 startAt, uint64 endAt)
    {
        if (cadence == ExtremaPool.Cadence.DAILY) {
            return (dailyClose, dailyStart, dailyEnd);
        }
        if (cadence == ExtremaPool.Cadence.WEEKLY) {
            return (weeklyClose, weeklyStart, weeklyEnd);
        }
        return (quarterlyClose, quarterlyStart, quarterlyEnd);
    }
}
