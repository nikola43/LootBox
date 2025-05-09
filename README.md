# 🎁 LootBox Smart Contract & Oracle Service

A decentralized lootbox system built on Ethereum, featuring verifiable randomness through a secure oracle service.

## 📋 Overview

The LootBox project consists of two main components:

1. **LootBox Smart Contract**: An upgradeable Solidity contract that manages lootboxes with different tiers, types, and prize distributions.
2. **Oracle Service**: A Node.js service that provides secure randomness for lootbox outcomes.

## ⚙️ Features

- **Verifiable Randomness**: Cryptographically secure random number generation with signatures
- **Multiple Box Types**: FREE and PAID boxes with configurable win rates
- **Tiered System**: BRONZE, SILVER, and GOLD box tiers
- **Prize Variations**: Support for ETH and ERC20 token prizes
- **Transparent Odds**: Configurable win rates (default: 30% for free boxes, 50% for paid boxes)
- **Dynamic Payouts**: Paid boxes award random percentage (1-100%) of the prize pool
- **Admin Controls**: Box creation, deletion, and oracle management

## 🔧 Technical Architecture

### Smart Contract

The LootBox contract is built with:
- Solidity 0.8.20
- OpenZeppelin upgradeable contracts
- ECDSA signature verification
- Reentrancy protection
- Role-based access control

### Oracle Service

The oracle service provides:
- Cryptographically secure random number generation
- Transaction signing for on-chain verification
- Event monitoring for randomness requests
- Automatic fulfillment of pending requests
- Health check API endpoint

## 🚀 Getting Started

### Prerequisites

- Node.js v14+
- Hardhat
- Ethereum development environment

### Environment Setup

Create a `.env` file with the following variables:

```
PROVIDER_URL=http://127.0.0.1:8545
CONTRACT_ADDRESS=0x...
PRIVATE_KEY_1=0x...
NODE_ID=oracle-1
LOG_LEVEL=info
PORT=3000
```

### Installation

1. Clone the repository
```bash
git clone https://github.com/yourusername/lootbox-project.git
cd lootbox-project
```

2. Install dependencies
```bash
npm install
```

3. Compile the smart contract
```bash
npx hardhat compile
```

4. Deploy the contract
```bash
npx hardhat run scripts/deploy.js --network YOUR_NETWORK
```

5. Start the oracle service
```bash
node lootbox-oracle.js
```

## 📊 Box Types & Win Rates

| Box Type | Default Win Rate | Prize Distribution |
|----------|------------------|-------------------|
| FREE     | 30%              | 100% of prize pool |
| PAID     | 50%              | Random 1-100% of prize pool |

## 🔐 Security Considerations

- Oracle authorization via on-chain mapping
- ECDSA signature verification for random number submissions
- Cryptographically secure random generation via crypto module
- Non-predictable request IDs
- Database tracking to prevent duplicate fulfillments

## 📝 API Reference

### Smart Contract Methods

**Admin Functions:**
- `createBox(BoxType, BoxTier, address, uint256)`: Create a new lootbox
- `updateBox(bytes32, BoxType, BoxTier, address, uint256)`: Update box parameters
- `deleteBox(bytes32)`: Remove a box
- `setOracle(address, bool)`: Add or remove an oracle
- `setWinRate(uint256, BoxType)`: Update win rate for a box type

**User Functions:**
- `requestRandomWords(uint256, bytes32)`: Open a lootbox

**Oracle Functions:**
- `fulfillRandomWords(bytes32, uint256[], bytes32, address, bytes)`: Fulfill randomness request

### Oracle API Endpoints

- `GET /health`: Check oracle service status

## 👥 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.