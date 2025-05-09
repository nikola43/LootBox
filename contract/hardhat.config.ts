import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@openzeppelin/hardhat-upgrades"
import * as dotenv from 'dotenv'
dotenv.config()

const mnemonic = process.env.PRIVATE_KEY;

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: '0.8.20',
        settings: {
          optimizer: {
            enabled: true,
            runs: 10,
          },
        },
      },
    ]
  },
  typechain: {
    outDir: 'typechain-types',
    target: 'ethers-v6',
  },
  networks: {
    hardhat: {
      forking: {
        url: "https://rpc.v4.testnet.pulsechain.com",
        blockNumber: 21537181,
      },
      accounts: {
        accountsBalance: '1000000000000000000000000000000000000000'
      },
    },
    localhost: {
      forking: {
        url: `https://rpc.pulsechain.com`,
      },
    },
    pulsechainmainnet: {
      url: "https://rpc-pulsechain.g4mm4.io",
      accounts: [`${mnemonic}`],
      chainId: 0x171,
    },
    pulsechaintestnet: {
      url: "https://rpc.v4.testnet.pulsechain.com",
      accounts: [`${mnemonic}`],
      chainId: 0x3AF
    }
  },
  etherscan: {
    apiKey: {
      pulsechainmainnet: 'pulsechainmainnet',
      pulsechaintestnet: 'pulsechaintestnet',
    },
    customChains: [
      {
        network: "pulsechaintestnet",
        chainId: 943,
        urls: {
          apiURL: "https://api.scan.v4.testnet.pulsechain.com/api/v1",
          browserURL: "https://scan.v4.testnet.pulsechain.com"
        }
      },
      {
        network: "pulsechainmainnet",
        chainId: 369,
        urls: {
          apiURL: "https://api.scan.pulsechain.com/api/v1",
          browserURL: "https://scan.pulsechain.com"
        }
      }
    ]
  },
};

export default config;