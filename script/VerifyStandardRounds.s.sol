// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ExtremaFactory} from "../contracts/src/ExtremaFactory.sol";
import {ExtremaPool} from "../contracts/src/ExtremaPool.sol";

interface IVerifyRoundVm {
    function envUint(string calldata name) external returns (uint256 value);
}

contract VerifyStandardRounds {
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

    IVerifyRoundVm private constant VM =
        IVerifyRoundVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 public constant ARC_TESTNET_CHAIN_ID = 5_042_002;
    ExtremaFactory public constant FACTORY =
        ExtremaFactory(0xa7Bff22811Bb1BA9297DFaA611De58E3bc186D7A);

    error VerificationFailed(address pool);
    error WrongChain(uint256 actual);
    error InvalidEnv();

    function run() external view returns (uint256 verifiedRounds) {
        if (block.chainid != ARC_TESTNET_CHAIN_ID) revert WrongChain(block.chainid);

        StandardPlan memory plan = _loadPlan();
        address[] memory pools = FACTORY.pools();
        if (pools.length != 24) revert VerificationFailed(address(FACTORY));

        for (uint256 i = 0; i < pools.length; ++i) {
            ExtremaPool pool = ExtremaPool(pools[i]);

            if (pool.nextRoundId() != 2) revert VerificationFailed(address(pool));

            ExtremaPool.Round memory round = pool.getRound(1);
            RoundTimes memory expected = _timesForCadence(pool.CADENCE(), plan);

            if (
                round.entryOpenAt == 0
                    || round.entryOpenAt >= expected.entryCloseAt
                    || round.entryCloseAt != expected.entryCloseAt
                    || round.observationStartAt != expected.observationStartAt
                    || round.observationEndAt != expected.observationEndAt
                    || uint8(round.status) != uint8(ExtremaPool.RoundStatus.ENTRY_OPEN)
                    || round.entryCount != 0
                    || round.totalStake != 0
                    || round.escrowRemaining != 0
            ) revert VerificationFailed(address(pool));

            ++verifiedRounds;
        }
    }

    function _loadPlan() internal view returns (StandardPlan memory plan) {
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

    function _envUint64(string memory name) internal view returns (uint64 value) {
        uint256 raw = VM.envUint(name);
        if (raw > type(uint64).max) revert InvalidEnv();
        value = uint64(raw);
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
