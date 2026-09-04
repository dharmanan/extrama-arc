// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface ITestVm {
    function warp(uint256 newTimestamp) external;
    function prank(address msgSender) external;
    function expectRevert(bytes4 revertData) external;
}

abstract contract ExtremaTestBase {
    ITestVm internal constant VM =
        ITestVm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    function _startsWith(
        string memory value,
        string memory prefix
    ) internal pure returns (bool) {
        bytes memory a = bytes(value);
        bytes memory b = bytes(prefix);
        if (b.length > a.length) return false;

        for (uint256 i = 0; i < b.length; ++i) {
            if (a[i] != b[i]) return false;
        }

        return true;
    }
}
