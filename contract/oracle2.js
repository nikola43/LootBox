/* eslint-disable no-undef */
// lootbox-oracle.js
// Oracle service for the LootBox contract

const { ethers } = require('ethers');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const contractABI = require('./abi/abi.json');
const helpers = require("@nomicfoundation/hardhat-network-helpers");

// Configuration from environment variables
const PROVIDER_URL = process.env.PROVIDER_URL || "http://127.0.0.1:8545";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const ORACLE_PRIVATE_KEY = process.env.PRIVATE_KEY_2;
const NODE_ID = process.env.NODE_ID || "oracle-2";
const LOG_LEVEL = process.env.LOG_LEVEL || "info"; // debug, info, warn, error

// Logging setup
const LOG_LEVELS = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3
};

function log(level, message, data = {}) {
    if (LOG_LEVELS[level] >= LOG_LEVELS[LOG_LEVEL]) {
        const timestamp = new Date().toISOString();
        const logEntry = {
            timestamp,
            level,
            node: NODE_ID,
            message,
            ...data
        };
        console.log(JSON.stringify(logEntry));
    }
}

// Database for request tracking
const dbPath = path.join(__dirname, `.oracle-db-${NODE_ID}.json`);
let requestsDB = {};

// Load existing DB if it exists
if (fs.existsSync(dbPath)) {
    try {
        requestsDB = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
        log('info', `Loaded existing request database with ${Object.keys(requestsDB).length} entries`);
    } catch (err) {
        log('error', `Error loading database: ${err.message}`);
        requestsDB = {};
        fs.writeFileSync(dbPath, JSON.stringify(requestsDB, null, 2));
    }
} else {
    fs.writeFileSync(dbPath, JSON.stringify(requestsDB, null, 2));
}

// Save DB periodically and on exit
function saveDB() {
    fs.writeFileSync(dbPath, JSON.stringify(requestsDB, null, 2));
}

setInterval(saveDB, 5 * 60 * 1000);
process.on('SIGINT', () => {
    log('info', 'Saving database and shutting down...');
    saveDB();
    process.exit();
});

// Blockchain connection
let provider, wallet, contract;

async function connectToBlockchain() {
    try {
        provider = new ethers.JsonRpcProvider(PROVIDER_URL);
        wallet = new ethers.Wallet(ORACLE_PRIVATE_KEY, provider);
        contract = new ethers.Contract(CONTRACT_ADDRESS, contractABI, wallet);

        const network = await provider.getNetwork();
        log('info', `Connected to network: ${network.name} (chainId: ${network.chainId})`);
        log('info', `Oracle address: ${wallet.address}`);

        // Check if this oracle is authorized - new contract uses a mapping instead of a single address
        const isAuthorized = await contract.oracles(wallet.address);

        if (!isAuthorized) {
            log('error', "THIS ORACLE IS NOT AUTHORIZED!", {
                currentWallet: wallet.address
            });
            log('error', "This wallet is not in the authorized oracles list.");
            log('error', "Please update the contract's oracle mapping or use an authorized wallet.");
            process.exit(1);
        }

        log('info', "Oracle authorization verified ✓");
        return true;
    } catch (error) {
        log('error', "Failed to connect to blockchain", { error: error.message });
        return false;
    }
}

// Generate cryptographically secure random words
function generateRandomWords(count) {
    const randomWords = [];

    for (let i = 0; i < count; i++) {
        // Generate 32 bytes of randomness for each word
        const randomBytes = crypto.randomBytes(32);
        // Convert to BigInt - ethers v6 uses BigInt instead of BigNumber
        const randomNum = BigInt("0x" + randomBytes.toString('hex'));
        randomWords.push(randomNum);
    }

    return randomWords;
}

// Sign random words for the new contract format which includes the oracle address
async function signRandomWords(requestId, randomWords, boxId, requester) {
    // Create message hash according to the contract's updated verifySignature function
    // Note: We now include the oracle's address in the message hash
    const messageHash = ethers.solidityPackedKeccak256(
        ['bytes32', 'uint256[]', 'bytes32', 'address', 'address'],
        [requestId, randomWords, boxId, requester, wallet.address]
    );

    // Sign the hash with the oracle's private key
    const signature = await wallet.signMessage(ethers.getBytes(messageHash));
    return signature;
}

// Process a new randomness request
async function processRequest(requestId, requester, numberOfWords, boxId, event) {
    try {
        // Check if we've already processed this request
        if (requestsDB[requestId]) {
            log('info', `Request ${requestId} already processed, skipping`);
            return;
        }

        // Convert requestId to string if it's not already
        const requestIdStr = typeof requestId === 'string' ? requestId : requestId.toString();

        // Verify the request is still pending on-chain
        const isPending = await contract.pendingRequests(requestIdStr);
        if (!isPending) {
            log('info', `Request ${requestIdStr} is no longer pending, skipping`);
            return;
        }

        log('info', `Processing new random words request`, {
            requestId: requestIdStr,
            requester,
            numberOfWords: typeof numberOfWords === 'bigint' ? numberOfWords.toString() : numberOfWords,
            boxId,
            blockNumber: event?.blockNumber,
            transactionHash: event?.transactionHash
        });

        // Generate random words
        const count = typeof numberOfWords === 'bigint' ? Number(numberOfWords) :
            (typeof numberOfWords === 'string' ? parseInt(numberOfWords) : numberOfWords);

        const randomWords = generateRandomWords(count);

        log('debug', `Generated ${count} random words`, {
            requestId: requestIdStr,
            randomWords: randomWords.map(word => word.toString())
        });

        // Sign the random words with boxId and requester
        const signature = await signRandomWords(requestIdStr, randomWords, boxId, requester);
        log('debug', `Generated signature`, {
            requestId: requestIdStr,
            signature
        });

        // Optional delay for security (prevent race conditions)
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Check again that the request is still pending
        const isStillPending = await contract.pendingRequests(requestIdStr);
        if (!isStillPending) {
            log('warn', `Request ${requestIdStr} is no longer pending, aborting fulfillment`);
            return;
        }

        // Submit the fulfillment transaction
        log('info', `Submitting fulfillment transaction for ${requestIdStr}`);
        const tx = await contract.fulfillRandomWords(
            requestIdStr,
            randomWords,  // ethers v6 handles arrays of BigInts correctly
            boxId,
            requester,
            signature,
            {
                gasLimit: 500000
            }
        );

        log('info', `Fulfillment transaction submitted`, {
            requestId: requestIdStr,
            transactionHash: tx.hash
        });

        // Wait for transaction confirmation
        const receipt = await tx.wait();

        log('info', `Random words fulfilled successfully`, {
            requestId: requestIdStr,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed.toString()
        });

        // Record in our database
        requestsDB[requestIdStr] = {
            requester,
            boxId,
            numberOfWords: count,
            randomWords: randomWords.map(w => w.toString()),
            requestBlock: event?.blockNumber,
            fulfillmentTx: tx.hash,
            fulfillmentBlock: receipt.blockNumber,
            timestamp: new Date().toISOString()
        };

        // Save DB after each successful fulfillment
        saveDB();

    } catch (error) {
        log('error', `Error processing request ${requestId}`, {
            error: error.message,
            stack: error.stack
        });

        // Convert requestId to string if it's not already
        const requestIdStr = typeof requestId === 'string' ? requestId : requestId.toString();

        // Record the failed attempt
        if (!requestsDB[requestIdStr]) {
            requestsDB[requestIdStr] = {
                requester,
                boxId,
                status: 'failed',
                error: error.message,
                timestamp: new Date().toISOString()
            };
        }
    }
}

// Start listening for events
async function startListening() {
    try {
        log('info', 'Starting to listen for RandomWordsRequested events...');

        // Create a filter for the RandomWordsRequested event
        const filter = contract.filters.RandomWordsRequested();

        // Log that we've set up the filter
        log('debug', 'Created event filter', { filter: JSON.stringify(filter) });

        // Listen for RandomWordsRequested events
        contract.on("RandomWordsRequested", (requestId, requester, numberOfWords, boxId, event) => {
            log('info', `New randomness request detected`, {
                requestId: typeof requestId === 'object' ? requestId.toString() : requestId,
                requester,
                numberOfWords: typeof numberOfWords === 'bigint' ? numberOfWords.toString() : numberOfWords,
                boxId,
                blockNumber: event?.blockNumber
            });

            // Process the request
            processRequest(requestId, requester, numberOfWords, boxId, event)
                .catch(error => {
                    log('error', `Error processing event`, {
                        error: error.message,
                        stack: error.stack
                    });
                });
        });

        // Handle connection errors
        provider.on("error", (error) => {
            log('error', "Provider error, attempting to reconnect", { error: error.message });

            // Try to reconnect after a delay
            setTimeout(async () => {
                const success = await connectToBlockchain();
                if (success) {
                    await startListening();
                } else {
                    log('error', "Failed to reconnect, exiting");
                    process.exit(1);
                }
            }, 5000);
        });

        log('info', 'Event listener established successfully');

        // Try to find missed events
        try {
            // Get current block number
            const currentBlock = await provider.getBlockNumber();
            const fromBlock = Math.max(0, currentBlock - 1000); // Check last 1000 blocks

            log('info', `Checking for missed events from block ${fromBlock} to ${currentBlock}`);

            // Query for past events
            const pastEvents = await contract.queryFilter(filter, fromBlock, currentBlock);

            log('info', `Found ${pastEvents.length} past events to process`);

            // Process each past event
            for (const event of pastEvents) {
                try {
                    const requestId = event.args[0]; // requestId is the first arg
                    const requester = event.args[1]; // requester is the second arg
                    const numberOfWords = event.args[2]; // numberOfWords is the third arg
                    const boxId = event.args[3]; // boxId is the fourth arg

                    // Convert requestId to string for db lookup
                    const requestIdStr = typeof requestId === 'string' ? requestId : requestId.toString();

                    // Check if we need to process this event
                    const isPending = await contract.pendingRequests(requestIdStr);
                    if (isPending && !requestsDB[requestIdStr]) {
                        log('info', `Processing missed event from block ${event.blockNumber}`);
                        await processRequest(requestId, requester, numberOfWords, boxId, event);
                    }
                } catch (error) {
                    log('error', `Error processing past event: ${error.message}`);
                }
            }
        } catch (err) {
            log('error', 'Error checking for missed events', { error: err.message });
        }

    } catch (error) {
        log('error', "Error setting up event listeners", { error: error.message });
        process.exit(1);
    }
}

// Health check endpoint
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3001;

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        node: NODE_ID,
        address: wallet ? wallet.address : null,
        connectedToBlockchain: provider && wallet && contract ? true : false,
        pendingRequestsCount: Object.keys(requestsDB).length,
        timestamp: new Date().toISOString()
    });
});

// Main function
async function main() {
    try {
        log('info', `Starting LootBox Oracle Service (Node: ${NODE_ID})...`);

        // Only use helpers.mine() if in a hardhat environment
        if (typeof helpers.mine === 'function') {
            await helpers.mine();
        }

        // Connect to blockchain
        const connected = await connectToBlockchain();
        if (!connected) {
            log('error', "Failed to connect to blockchain, exiting");
            process.exit(1);
        }

        // Start listening for events
        await startListening();

        // Start health check server
        app.listen(PORT, () => {
            log('info', `Health check endpoint running on port ${PORT}`);
        });

        log('info', 'Oracle service is running');

    } catch (error) {
        log('error', "Critical error in main process", { error: error.message, stack: error.stack });
        process.exit(1);
    }
}

// Start the oracle service
main();