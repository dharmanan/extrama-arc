// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ExtremaPool} from "./ExtremaPool.sol";
import {ExtremaTicket} from "./ExtremaTicket.sol";

contract ExtremaFactory {
    error ZeroAddress();
    error NotOwner();
    error PoolAlreadyExists();
    error PoolNotFound();

    address public owner;

    address public immutable USDC;
    address public immutable TREASURY;
    address public immutable POOL_ADMIN;

    address public resolver;
    address public defaultRenderer;

    address[] private _pools;
    mapping(bytes32 => address) public poolByIdentity;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ResolverUpdated(address indexed previousResolver, address indexed newResolver);
    event DefaultRendererUpdated(address indexed previousRenderer, address indexed newRenderer);
    event PoolDeployed(
        address indexed pool,
        address indexed ticket,
        ExtremaPool.Asset asset,
        ExtremaPool.Direction direction,
        ExtremaPool.Cadence cadence
    );

    constructor(
        address usdc_,
        address treasury_,
        address poolAdmin_,
        address resolver_,
        address renderer_
    ) {
        if (
            usdc_ == address(0)
                || treasury_ == address(0)
                || poolAdmin_ == address(0)
                || resolver_ == address(0)
                || renderer_ == address(0)
        ) revert ZeroAddress();

        owner = msg.sender;
        USDC = usdc_;
        TREASURY = treasury_;
        POOL_ADMIN = poolAdmin_;
        resolver = resolver_;
        defaultRenderer = renderer_;

        emit OwnershipTransferred(address(0), msg.sender);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
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

        for (uint256 i = 0; i < _pools.length; ++i) {
            ExtremaPool(_pools[i]).setResolver(newResolver);
        }

        emit ResolverUpdated(previousResolver, newResolver);
    }

    function deployPool(
        ExtremaPool.Asset asset,
        ExtremaPool.Direction direction,
        ExtremaPool.Cadence cadence
    ) external onlyOwner returns (address poolAddress) {
        bytes32 key = identityKey(asset, direction, cadence);
        if (poolByIdentity[key] != address(0)) revert PoolAlreadyExists();

        ExtremaPool pool = new ExtremaPool(
            USDC,
            TREASURY,
            resolver,
            POOL_ADMIN,
            defaultRenderer,
            address(this),
            asset,
            direction,
            cadence
        );

        poolAddress = address(pool);
        poolByIdentity[key] = poolAddress;
        _pools.push(poolAddress);

        emit PoolDeployed(
            poolAddress,
            address(pool.TICKET()),
            asset,
            direction,
            cadence
        );
    }

    function setRendererForAll(address newRenderer) external onlyOwner {
        if (newRenderer == address(0)) revert ZeroAddress();

        address previousRenderer = defaultRenderer;
        defaultRenderer = newRenderer;

        for (uint256 i = 0; i < _pools.length; ++i) {
            ExtremaTicket(address(ExtremaPool(_pools[i]).TICKET())).setRenderer(newRenderer);
        }

        emit DefaultRendererUpdated(previousRenderer, newRenderer);
    }

    function setRendererForPool(address pool, address newRenderer) external onlyOwner {
        if (pool == address(0) || newRenderer == address(0)) revert ZeroAddress();
        if (!_isRegisteredPool(pool)) revert PoolNotFound();

        ExtremaTicket(address(ExtremaPool(pool).TICKET())).setRenderer(newRenderer);
    }

    function pools() external view returns (address[] memory) {
        return _pools;
    }

    function poolCount() external view returns (uint256) {
        return _pools.length;
    }

    function identityKey(
        ExtremaPool.Asset asset,
        ExtremaPool.Direction direction,
        ExtremaPool.Cadence cadence
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(asset, direction, cadence));
    }

    function poolFor(
        ExtremaPool.Asset asset,
        ExtremaPool.Direction direction,
        ExtremaPool.Cadence cadence
    ) external view returns (address) {
        return poolByIdentity[identityKey(asset, direction, cadence)];
    }

    function _isRegisteredPool(address pool) internal view returns (bool) {
        for (uint256 i = 0; i < _pools.length; ++i) {
            if (_pools[i] == pool) return true;
        }

        return false;
    }
}
