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
    struct RoundTimes {
        uint64 entryCloseAt;
        uint64 observationStartAt;
        uint64 observationEndAt;
    }

    struct StandardPlan {
        RoundTimes daily;
        RoundTimes weekly;
        RoundTimes quarterly;
    }

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

        StandardPlan memory plan = _loadPlan();
        _validatePlan(plan);

        address[] memory pools = FACTORY.pools();
        if (pools.length != 24) revert UnexpectedPoolCount(pools.length);

        _requireFirstRounds(pools);

        uint64 entryOpenAt = uint64(block.timestamp);
        if (
            entryOpenAt >= plan.daily.entryCloseAt
                || entryOpenAt >= plan.weekly.entryCloseAt
                || entryOpenAt >= plan.quarterly.entryCloseAt
        ) revert InvalidPlan();

        VM.startBroadcast(deployerPrivateKey);

        for (uint256 i = 0; i < pools.length; ++i) {
            ExtremaPool pool = ExtremaPool(pools[i]);
            RoundTimes memory times = _timesForCadence(pool.CADENCE(), plan);

            uint256 roundId = pool.createRound(
                entryOpenAt,
                times.entryCloseAt,
                times.observationStartAt,
                times.observationEndAt
            );

            if (roundId != 1) revert RoundVerificationFailed(address(pool));
            ++createdRounds;
        }

        VM.stopBroadcast();

        _verifyCreatedRounds(pools, entryOpenAt, plan);
    }

    function _loadPlan() internal returns (StandardPlan memory plan) {
        plan.daily = RoundTimes({
            entryCloseAt: _envUint64("EXTREMA_DAILY_ENTRY_CLOSE_AT"),
            observationStartAt: _envUint64("EXTREMA_DAILY_OBSERVATION_START_AT"),
            observationEndAt: _envUint64("EXTREMA_DAILY_OBSERVATION_END_AT")
        });

        plan.weekly = RoundTimes({
            entryCloseAt: _envUint64("EXTREMA_WEEKLY_ENTRY_CLOSE_AT"),
            observationStartAt: _envUint64("EXTREMA_WEEKLY_OBSERVATION_START_AT"),
            observationEndAt: _envUint64("EXTREMA_WEEKLY_OBSERVATION_END_AT")
        });

        plan.quarterly = RoundTimes({
            entryCloseAt: _envUint64("EXTREMA_QUARTERLY_ENTRY_CLOSE_AT"),
            observationStartAt: _envUint64("EXTREMA_QUARTERLY_OBSERVATION_START_AT"),
            observationEndAt: _envUint64("EXTREMA_QUARTERLY_OBSERVATION_END_AT")
        });
    }

    function _validatePlan(StandardPlan memory plan) internal pure {
        _validateFixedPlan(plan.daily, 4 hours, 1 days);
        _validateFixedPlan(plan.weekly, 1 days, 7 days);
        _validateQuarterlyPlan(plan.quarterly);
    }

    function _requireFirstRounds(address[] memory pools) internal view {
        for (uint256 i = 0; i < pools.length; ++i) {
            uint256 nextRoundId = ExtremaPool(pools[i]).nextRoundId();
            if (nextRoundId != 1) revert ExistingRound(pools[i], nextRoundId);
        }
    }

    function _verifyCreatedRounds(
        address[] memory pools,
        uint64 entryOpenAt,
        StandardPlan memory plan
    ) internal view {
        for (uint256 i = 0; i < pools.length; ++i) {
            ExtremaPool pool = ExtremaPool(pools[i]);
            if (pool.nextRoundId() != 2) revert RoundVerificationFailed(address(pool));

            ExtremaPool.Round memory round = pool.getRound(1);
            RoundTimes memory expected = _timesForCadence(pool.CADENCE(), plan);

            if (
                round.entryOpenAt != entryOpenAt
                    || round.entryCloseAt != expected.entryCloseAt
                    || round.observationStartAt != expected.observationStartAt
                    || round.observationEndAt != expected.observationEndAt
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

    function _validateFixedPlan(
        RoundTimes memory times,
        uint256 requiredLead,
        uint256 requiredDuration
    ) internal pure {
        if (
            uint256(times.entryCloseAt) + requiredLead != uint256(times.observationStartAt)
                || uint256(times.observationStartAt) + requiredDuration
                    != uint256(times.observationEndAt)
        ) revert InvalidPlan();
    }

    function _validateQuarterlyPlan(RoundTimes memory times) internal pure {
        uint256 duration =
            uint256(times.observationEndAt) - uint256(times.observationStartAt);

        if (
            uint256(times.entryCloseAt) + 1 days != uint256(times.observationStartAt)
                || times.observationEndAt <= times.observationStartAt
                || duration < 89 days
                || duration > 92 days
        ) revert InvalidPlan();
    }

    function _timesForCadence(
        ExtremaPool.Cadence cadence,
        StandardPlan memory plan
    ) internal pure returns (RoundTimes memory times) {
        if (cadence == ExtremaPool.Cadence.DAILY) return plan.daily;
        if (cadence == ExtremaPool.Cadence.WEEKLY) return plan.weekly;
        return plan.quarterly;
    }
}
