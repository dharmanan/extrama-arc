// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface IERC721Receiver {
    function onERC721Received(
        address operator,
        address from,
        uint256 tokenId,
        bytes calldata data
    ) external returns (bytes4);
}

contract ExtremaTicket {
    error ZeroAddress();
    error NotMinter();
    error TokenDoesNotExist();
    error TokenAlreadyExists();
    error NotAuthorized();
    error InvalidReceiver();

    string public constant name = "EXTREMA Prediction Ticket";
    string public constant symbol = "EXTICKET";

    address public immutable minter;

    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
    mapping(uint256 => address) private _tokenApprovals;
    mapping(address => mapping(address => bool)) private _operatorApprovals;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    constructor(address minter_) {
        if (minter_ == address(0)) revert ZeroAddress();
        minter = minter_;
    }

    modifier onlyMinter() {
        if (msg.sender != minter) revert NotMinter();
        _;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == 0x80ac58cd;
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
        if (owner_ != from) revert NotAuthorized();
        if (!_isAuthorized(owner_, msg.sender, tokenId)) revert NotAuthorized();

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

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public {
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
