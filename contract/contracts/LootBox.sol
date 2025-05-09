// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {console} from "hardhat/console.sol";

contract LootBox is
    Initializable,
    OwnableUpgradeable,
    ReentrancyGuardUpgradeable
{
    using EnumerableSet for EnumerableSet.Bytes32Set;
    uint256 private randNumber;
    uint256 private nonce;
    uint public freeBoxWinRate;
    uint public paidBoxWinRate;

    enum BoxType {
        FREE,
        PAID
    }

    enum BoxStatus {
        OPEN,
        CLOSED
    }

    enum BoxTier {
        BRONZE,
        SILVER,
        GOLD
    }

    struct Box {
        bytes32 id;
        BoxType boxType;
        BoxStatus status;
        BoxTier boxTier;
        address owner;
        address prizeToken;
        uint256 prizeAmount;
        bool won;
        uint256 payout;
    }

    mapping(bytes32 => bool) public pendingRequests;
    mapping(bytes32 => Box) public boxes;
    EnumerableSet.Bytes32Set private boxIds;
    mapping(address => bool) public oracles;
    mapping(address => uint256) public userNonces;
    uint256 public constant SIGNATURE_EXPIRY = 5 minutes;

    event RandomWordsRequested(
        bytes32 indexed requestId,
        address indexed requester,
        uint256 numberOfWords,
        bytes32 indexed boxId,
        uint256 timestamp
    );
    event RandomWordsFulfilled(
        bytes32 indexed requestId,
        uint256[] randomWords,
        bytes32 indexed boxId
    );
    event UpdateOracle(address indexed oracle, bool enabled);
    event BoxCreated(
        bytes32 indexed boxId,
        BoxType boxType,
        BoxStatus status,
        BoxTier boxTier,
        address indexed owner,
        address prizeToken,
        uint256 prizeAmount
    );
    event BoxDeleted(bytes32 indexed boxId);
    event BoxUpdated(
        bytes32 indexed boxId,
        BoxType boxType,
        BoxTier boxTier,
        address prizeToken,
        uint256 prizeAmount
    );
    event BoxOpened(bytes32 indexed boxId, address indexed owner);
    event UserWon(
        bytes32 indexed boxId,
        address indexed winner,
        address prizeToken,
        uint256 prizeAmount
    );
    event UserLost(bytes32 indexed boxId, address indexed loser);
    event Refunded(
        bytes32 indexed boxId,
        address prizeToken,
        uint256 prizeAmount
    );

    event UpdateWinRate(
        uint256 indexed newRate,
        uint256 indexed oldRate,
        BoxType boxType
    );

    error Unauthorized();
    error RequestNotFound();
    error InvalidSignature();

    modifier onlyOracle() {
        if (!oracles[msg.sender]) revert Unauthorized();
        _;
    }

    modifier validERC20(address token) {
        if (token != address(0)) {
            require(isContract(token), "Not a contract");
            (bool success, ) = token.call(
                abi.encodeWithSignature("balanceOf(address)", address(this))
            );
            require(success, "Not ERC20 compliant");
        }
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize() public initializer {
        __Ownable_init(msg.sender);
        __ReentrancyGuard_init();
        randNumber = uint256(
            keccak256(abi.encodePacked(msg.sender, block.timestamp))
        );
        freeBoxWinRate = 30; // 30% win rate for free boxes
        paidBoxWinRate = 50; // 50% win rate for paid boxes
        nonce = 0;
    }

    function totalBoxes() external view returns (uint256) {
        return boxIds.length();
    }

    function getBoxIdAt(uint256 index) external view returns (bytes32) {
        require(index < boxIds.length(), "Index out of bounds");
        return boxIds.at(index);
    }

    function getBox(bytes32 boxId) external view returns (Box memory) {
        require(boxIds.contains(boxId), "Box ID not found");
        return boxes[boxId];
    }

    function deleteBox(bytes32 boxId) external onlyOwner {
        require(boxIds.contains(boxId), "Box ID not found");
        _deleteBox(boxId);
    }

    function _deleteBox(bytes32 boxId) internal {
        delete boxes[boxId];
        boxIds.remove(boxId);
        emit BoxDeleted(boxId);
    }

    function createBox(
        BoxType boxType,
        BoxTier boxTier,
        address prizeToken,
        uint256 prizeAmount
    ) external payable onlyOwner validERC20(prizeToken) {
        require(prizeAmount > 0, "Prize amount must be greater than zero");

        bytes32 boxId;
        do {
            boxId = _generateBoxId();
        } while (boxIds.contains(boxId));

        // check if the box type is valid
        require(
            boxType == BoxType.FREE || boxType == BoxType.PAID,
            "Invalid box type"
        );

        // check if the box tier is valid
        require(
            boxTier == BoxTier.BRONZE ||
                boxTier == BoxTier.SILVER ||
                boxTier == BoxTier.GOLD,
            "Invalid box tier"
        );

        // check if the prize token is valid
        require(prizeAmount > 0, "Prize amount must be greater than zero");

        // check if the prize token is valid
        if (prizeToken != address(0)) {
            require(
                IERC20(prizeToken).allowance(msg.sender, address(this)) >=
                    prizeAmount,
                "Insufficient allowance"
            );
        }

        boxes[boxId] = Box({
            id: boxId,
            boxType: boxType,
            boxTier: boxTier,
            status: BoxStatus.CLOSED,
            owner: address(0),
            prizeToken: prizeToken,
            prizeAmount: prizeAmount,
            won: false,
            payout: 0
        });

        boxIds.add(boxId);

        if (prizeToken == address(0)) {
            require(msg.value == prizeAmount, "Incorrect ether value sent");
        } else {
            SafeERC20.safeTransferFrom(
                IERC20(prizeToken),
                msg.sender,
                address(this),
                prizeAmount
            );
        }

        emit BoxCreated(
            boxId,
            boxType,
            BoxStatus.CLOSED,
            boxTier,
            address(0),
            prizeToken,
            prizeAmount
        );
    }

    function updateBox(
        bytes32 boxId,
        BoxType boxType,
        BoxTier boxTier,
        address prizeToken,
        uint256 prizeAmount
    ) external onlyOwner validERC20(prizeToken) {
        require(boxIds.contains(boxId), "Box ID not found");
        require(prizeAmount > 0, "Prize amount must be greater than zero");
        require(
            boxType == BoxType.FREE || boxType == BoxType.PAID,
            "Invalid box type"
        );

        // check if the box tier is valid
        require(
            boxTier == BoxTier.BRONZE ||
                boxTier == BoxTier.SILVER ||
                boxTier == BoxTier.GOLD,
            "Invalid box tier"
        );

        Box storage box = boxes[boxId];
        box.boxType = boxType;
        box.boxTier = boxTier;
        box.prizeToken = prizeToken;
        box.prizeAmount = prizeAmount;

        emit BoxUpdated(boxId, boxType, boxTier, prizeToken, prizeAmount);
    }

    function setOracle(address oracle, bool enabled) external onlyOwner {
        require(oracle != address(0), "Invalid oracle address");
        emit UpdateOracle(oracle, enabled);
        oracles[oracle] = enabled;
    }

    function setWinRate(uint256 _newRate, BoxType boxType) external onlyOwner {
        // check if is valid box type
        require(
            boxType == BoxType.FREE || boxType == BoxType.PAID,
            "Invalid box type"
        );

        require(
            _newRate >= 1 && _newRate <= 100,
            "Win rate must be between 1 and 100"
        );
        if (boxType == BoxType.FREE) {
            emit UpdateWinRate(_newRate, freeBoxWinRate, boxType);
            freeBoxWinRate = _newRate;
        } else if (boxType == BoxType.PAID) {
            emit UpdateWinRate(_newRate, paidBoxWinRate, boxType);
            paidBoxWinRate = _newRate;
        } else {
            revert("Invalid box type");
        }
    }

    function requestRandomWords(
        uint256 numberOfWords,
        bytes32 boxId
    ) external returns (bytes32 requestId) {
        require(boxIds.contains(boxId), "Box ID not found");
        require(boxes[boxId].status == BoxStatus.CLOSED, "Box already opened");
        require(boxes[boxId].owner == address(0), "Box already has owner");
        require(numberOfWords == 1, "Only one word allowed");

        randNumber = uint256(
            keccak256(abi.encodePacked(msg.sender, block.timestamp, randNumber))
        );

        requestId = keccak256(
            abi.encodePacked(
                randNumber,
                block.timestamp,
                block.prevrandao,
                msg.sender,
                address(this),
                numberOfWords,
                boxId,
                nonce++
            )
        );

        require(!pendingRequests[requestId], "Request ID exists");

        pendingRequests[requestId] = true;
        emit RandomWordsRequested(
            requestId,
            msg.sender,
            numberOfWords,
            boxId,
            block.timestamp
        );
    }

    function fulfillRandomWords(
        bytes32 requestId,
        uint256[] memory _randomWords,
        bytes32 boxId,
        address requester,
        uint256 timestamp,
        bytes calldata signature
    ) external onlyOracle nonReentrant {
        if (!pendingRequests[requestId]) revert RequestNotFound();
        if (
            !verifySignature(
                requestId,
                _randomWords,
                boxId,
                requester,
                msg.sender,
                timestamp,
                signature
            )
        ) revert InvalidSignature();
        require(boxIds.contains(boxId), "Box ID not found");

        Box storage box = boxes[boxId];
        require(box.status == BoxStatus.CLOSED, "Already opened");
        require(box.owner == address(0), "Box has owner");

        box.owner = requester;

        // Calculate win chance based on box type
        bool won;
        if (box.boxType == BoxType.FREE) {
            won = _randomWords[0] % 100 < freeBoxWinRate;
        } else {
            won = _randomWords[0] % 100 < paidBoxWinRate;
        }

        console.log("Random number: ", _randomWords[0]);
        console.log("Requester: ", requester);
        console.log("Box Type: ", uint256(box.boxType));
        console.log("Prize Amount: ", box.prizeAmount);
        console.log("Won: ", won);
        console.log("Prize Token: ", box.prizeToken);

        if (won) {
            uint256 percent = box.boxType == BoxType.PAID
                ? (_randomWords[0] % 100) + 1
                : 100;
            uint256 payout = box.boxType == BoxType.PAID
                ? (box.prizeAmount * percent) / 100
                : box.prizeAmount;
            console.log("Percent: ", percent);

            uint256 remainingPrize = box.prizeAmount - payout;
            console.log(
                "Payout: ",
                payout,
                " Remaining Prize: ",
                remainingPrize
            );

            box.won = true;
            box.payout = payout;

            // if there is a remaining prize, transfer it to the owner
            if (remainingPrize > 0) {
                _transferPrize(box.prizeToken, owner(), remainingPrize);
                emit Refunded(boxId, box.prizeToken, remainingPrize);
            }
            emit UserWon(boxId, requester, box.prizeToken, payout);
        } else {
            // Refund the owner if they didn't win
            _transferPrize(box.prizeToken, owner(), box.prizeAmount);
            emit UserLost(boxId, requester);
            emit Refunded(boxId, box.prizeToken, box.prizeAmount);
        }
        delete pendingRequests[requestId];
        emit RandomWordsFulfilled(requestId, _randomWords, boxId);
    }

    function _transferPrize(
        address prizeToken,
        address recipient,
        uint256 amount
    ) internal {
        if (prizeToken == address(0)) {
            _transferEther(payable(recipient), amount);
        } else {
            _transferTokens(prizeToken, recipient, amount);
        }
    }

    function claimPrize(bytes32 boxId) external nonReentrant {
        require(boxIds.contains(boxId), "Box ID not found");
        Box storage box = boxes[boxId];
        require(box.owner == msg.sender, "Not the owner");
        require(box.status == BoxStatus.CLOSED, "Box already opened");
        require(box.won, "user did not win this box");

        box.status = BoxStatus.OPEN;
        // boxIds.remove(boxId);

        _transferPrize(box.prizeToken, msg.sender, box.payout);
        emit BoxOpened(boxId, msg.sender);
        // emit BoxDeleted(boxId);
    }

    function verifySignature(
        bytes32 requestId,
        uint256[] memory _randomWords,
        bytes32 boxId,
        address requester,
        address oracle,
        uint256 timestamp,
        bytes calldata signature
    ) internal returns (bool) {
        // Get current nonce and increment
        uint256 currentNonce = userNonces[requester];
        require(
            block.timestamp <= timestamp + SIGNATURE_EXPIRY,
            "Signature expired"
        );
        require(timestamp <= block.timestamp, "Invalid timestamp");

        bytes32 messageHash = keccak256(
            abi.encodePacked(
                requestId,
                _randomWords,
                boxId,
                requester,
                oracle,
                currentNonce,
                timestamp,
                address(this)
            )
        );
        bytes32 ethSignedMessageHash = ECDSA.toEthSignedMessageHash(
            messageHash
        );
        // Increment nonce for the user
        userNonces[requester] = currentNonce + 1;
        return ECDSA.recover(ethSignedMessageHash, signature) == oracle;
    }

    function _generateBoxId() internal returns (bytes32) {
        randNumber = uint256(
            keccak256(abi.encodePacked(msg.sender, block.timestamp, randNumber))
        );
        nonce = nonce + 1;
        return
            keccak256(
                abi.encodePacked(
                    block.timestamp,
                    block.prevrandao,
                    msg.sender,
                    address(this),
                    randNumber,
                    nonce
                )
            );
    }

    function _transferEther(
        address payable recipient,
        uint256 amount
    ) internal {
        require(address(this).balance >= amount, "Insufficient ETH");
        (bool success, ) = recipient.call{value: amount}("");
        require(success, "ETH transfer failed");
    }

    function _transferTokens(
        address token,
        address recipient,
        uint256 amount
    ) internal {
        SafeERC20.safeTransfer(IERC20(token), recipient, amount);
    }

    /**
     * @dev Allows the owner to set the fee recipient
     * @param token The ERC20 token to recover
     * @param to The address to send the recovered tokens to
     */
    function recoverERC20(
        address token,
        address to,
        uint256 amount
    ) external onlyOwner nonReentrant {
        require(to != address(0), "Invalid address");
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(balance > 0, "No tokens");
        require(amount <= balance, "Amount exceeds balance");
        SafeERC20.safeTransfer(IERC20(token), to, amount);
    }

    /**
     * @dev Allows the owner to set the fee recipient
     * @param to The address to send the recovered eth to
     * @param amount The amount of ETH to recover
     */
    function recoverEth(
        address to,
        uint256 amount
    ) external onlyOwner nonReentrant {
        uint256 balance = address(this).balance;
        require(balance > 0, "No ETH");
        require(amount <= balance, "Amount exceeds balance");
        (bool success, ) = to.call{value: amount}("");
        require(success, "Transfer failed");
    }

    function isContract(address _addr) private view returns (bool) {
        uint32 size;
        assembly {
            size := extcodesize(_addr)
        }
        return (size > 0);
    }

    receive() external payable {}
}
