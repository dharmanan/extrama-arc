// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "./interfaces/IERC20.sol";

contract ExtremaTreasury {
    error ZeroAddress();
    error NotController();
    error InvalidAmount();
    error TokenTransferFailed();

    IERC20 public immutable USDC;
    address public immutable CONTROLLER_A;
    address public immutable CONTROLLER_B;

    event TreasuryWithdrawal(address indexed controller, uint256 amount);

    constructor(address usdc_, address controllerA_, address controllerB_) {
        if (usdc_ == address(0) || controllerA_ == address(0) || controllerB_ == address(0)) {
            revert ZeroAddress();
        }
        if (controllerA_ == controllerB_) revert ZeroAddress();

        USDC = IERC20(usdc_);
        CONTROLLER_A = controllerA_;
        CONTROLLER_B = controllerB_;
    }

    modifier onlyController() {
        if (msg.sender != CONTROLLER_A && msg.sender != CONTROLLER_B) revert NotController();
        _;
    }

    function balance() external view returns (uint256) {
        return _balance();
    }

    function withdraw(uint256 amount) external onlyController {
        uint256 available = _balance();
        if (amount == 0 || amount > available) revert InvalidAmount();

        if (!USDC.transfer(msg.sender, amount)) revert TokenTransferFailed();
        emit TreasuryWithdrawal(msg.sender, amount);
    }

    function withdrawAll() external onlyController {
        uint256 amount = _balance();
        if (amount == 0) revert InvalidAmount();

        if (!USDC.transfer(msg.sender, amount)) revert TokenTransferFailed();
        emit TreasuryWithdrawal(msg.sender, amount);
    }

    function _balance() internal view returns (uint256) {
        (bool success, bytes memory data) = address(USDC).staticcall(
            abi.encodeWithSignature("balanceOf(address)", address(this))
        );
        if (!success || data.length < 32) return 0;
        return abi.decode(data, (uint256));
    }
}
