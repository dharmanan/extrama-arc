// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC721Receiver} from "./interfaces/IERC721Receiver.sol";
import {IExtremaRenderer} from "./interfaces/IExtremaRenderer.sol";

contract ExtremaTicket {
    error ZeroAddress();
    error NotMinter();
    error NotRendererAdmin();
    error TokenDoesNotExist();
    error TokenAlreadyExists();
    error NotAuthorized();
    error InvalidReceiver();

    string public name;
    string public symbol;

    address public immutable MINTER;
    address public immutable RENDERER_ADMIN;
    address public renderer;

    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
    mapping(uint256 => address) private _tokenApprovals;
    mapping(address => mapping(address => bool)) private _operatorApprovals;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event RendererUpdated(address indexed previousRenderer, address indexed newRenderer);

    constructor(
        address minter_,
        address rendererAdmin_,
        address renderer_,
        string memory name_,
        string memory symbol_
    ) {
        if (minter_ == address(0) || rendererAdmin_ == address(0) || renderer_ == address(0)) {
            revert ZeroAddress();
        }

        MINTER = minter_;
        RENDERER_ADMIN = rendererAdmin_;
        renderer = renderer_;
        name = name_;
        symbol = symbol_;
    }

    modifier onlyMinter() {
        _checkMinter();
        _;
    }

    modifier onlyRendererAdmin() {
        _checkRendererAdmin();
        _;
    }

    function _checkMinter() internal view {
        if (msg.sender != MINTER) revert NotMinter();
    }

    function _checkRendererAdmin() internal view {
        if (msg.sender != RENDERER_ADMIN) revert NotRendererAdmin();
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7
            || interfaceId == 0x80ac58cd
            || interfaceId == 0x5b5e139f;
    }

    function balanceOf(address owner_) external view returns (uint256) {
        if (owner_ == address(0)) revert ZeroAddress();
        return _balances[owner_];
    }

    function ownerOf(uint256 tokenId) public view returns (address) {
        address owner_ = _owners[tokenId];
        if (owner_ == address(0)) revert TokenDoesNotExist();
        return owner_;
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        ownerOf(tokenId);
        return IExtremaRenderer(renderer).tokenURI(MINTER, tokenId);
    }

    function setRenderer(address newRenderer) external onlyRendererAdmin {
        if (newRenderer == address(0)) revert ZeroAddress();
        address previousRenderer = renderer;
        renderer = newRenderer;
        emit RendererUpdated(previousRenderer, newRenderer);
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        ownerOf(tokenId);
        return _tokenApprovals[tokenId];
    }

    function isApprovedForAll(address owner_, address operator) external view returns (bool) {
        return _operatorApprovals[owner_][operator];
    }

    function approve(address approved, uint256 tokenId) external {
        address owner_ = ownerOf(tokenId);
        if (msg.sender != owner_ && !_operatorApprovals[owner_][msg.sender]) {
            revert NotAuthorized();
        }

        _tokenApprovals[tokenId] = approved;
        emit Approval(owner_, approved, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        if (operator == msg.sender) revert NotAuthorized();

        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        if (to == address(0)) revert ZeroAddress();

        address owner_ = ownerOf(tokenId);
        if (owner_ != from || !_isAuthorized(owner_, msg.sender, tokenId)) {
            revert NotAuthorized();
        }

        delete _tokenApprovals[tokenId];

        unchecked {
            _balances[from] -= 1;
            _balances[to] += 1;
        }

        _owners[tokenId] = to;

        emit Transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        safeTransferFrom(from, to, tokenId, "");
    }

    function safeTransferFrom(
        address from,
        address to,
        uint256 tokenId,
        bytes memory data
    ) public {
        transferFrom(from, to, tokenId);

        if (to.code.length != 0) {
            try IERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, data) returns (
                bytes4 retval
            ) {
                if (retval != IERC721Receiver.onERC721Received.selector) {
                    revert InvalidReceiver();
                }
            } catch {
                revert InvalidReceiver();
            }
        }
    }

    function mint(address to, uint256 tokenId) external onlyMinter {
        if (to == address(0)) revert ZeroAddress();
        if (_owners[tokenId] != address(0)) revert TokenAlreadyExists();

        _owners[tokenId] = to;
        _balances[to] += 1;

        emit Transfer(address(0), to, tokenId);
    }

    function _isAuthorized(
        address owner_,
        address operator,
        uint256 tokenId
    ) internal view returns (bool) {
        return operator == owner_
            || _tokenApprovals[tokenId] == operator
            || _operatorApprovals[owner_][operator];
    }
}
