// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface IExtremaPoolMetadata {
    struct TicketMetadata {
        uint256 roundId;
        uint64 predictionPriceCents;
        uint64 entrySequence;
        uint8 roundStatus;
        uint8 placement;
        bool isClaimed;
        bool isRefunded;
    }

    function ASSET() external view returns (uint8);
    function DIRECTION() external view returns (uint8);
    function CADENCE() external view returns (uint8);
    function getTicketMetadata(uint256 ticketId) external view returns (TicketMetadata memory);
}
