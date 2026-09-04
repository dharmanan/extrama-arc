// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ExtremaTreasury} from "../src/ExtremaTreasury.sol";
import {MockUSDC} from "./MockUSDC.sol";
import {ExtremaTestBase} from "./TestBase.sol";

contract ExtremaTreasuryTest is ExtremaTestBase {
    address internal constant CONTROLLER_A =
        0xafbB6Cc5C0a9C0eB1BfF8dB2eD807e83aAB8e321;
    address internal constant CONTROLLER_B =
        0x99677aab4b168c274A34525D526346fC47Fab72c;
    address internal constant STRANGER = address(0xBAD);

    MockUSDC internal usdc;
    ExtremaTreasury internal treasury;

    function setUp() public {
        usdc = new MockUSDC();
        treasury = new ExtremaTreasury(
            address(usdc),
            CONTROLLER_A,
            CONTROLLER_B
        );
        usdc.mint(address(treasury), 10_000_000);
    }

    function testControllerAWithdrawsToItself() public {
        VM.prank(CONTROLLER_A);
        treasury.withdraw(3_000_000);

        require(usdc.balanceOf(CONTROLLER_A) == 3_000_000, "controller A");
        require(usdc.balanceOf(address(treasury)) == 7_000_000, "treasury");
    }

    function testControllerBCanRecoverAllTreasuryFunds() public {
        VM.prank(CONTROLLER_B);
        treasury.withdrawAll();

        require(usdc.balanceOf(CONTROLLER_B) == 10_000_000, "controller B");
        require(usdc.balanceOf(address(treasury)) == 0, "treasury");
    }

    function testUnauthorizedTreasuryWithdrawalRejected() public {
        VM.expectRevert(ExtremaTreasury.NotController.selector);
        VM.prank(STRANGER);
        treasury.withdraw(1_000_000);
    }
}
