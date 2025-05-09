// test/MixerMerkleRoot.test.js
import { expect } from "chai";
import { ethers } from "hardhat";
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { MerkleTree } = require('merkletreejs');
const keccak256 = require('keccak256');

// Helper function to create a Merkle tree and generate proofs
function createMerkleTree(recipients) {
  // Create leaves from recipient data (address, amount, releaseTime)
  const leaves = recipients.map(recipient =>
    keccak256(
      Buffer.concat([
        Buffer.from(recipient.address.slice(2), 'hex'),
        Buffer.from(recipient.amount.toString(16).padStart(64, '0'), 'hex'),
        Buffer.from(recipient.releaseTime.toString(16).padStart(64, '0'), 'hex')
      ])
    )
  );

  // Create Merkle tree
  const tree = new MerkleTree(leaves, keccak256, { sortPairs: true });
  const root = tree.getHexRoot();

  // Generate proofs for each recipient
  const proofs = recipients.map((recipient, index) => ({
    ...recipient,
    proof: tree.getHexProof(leaves[index])
  }));

  return { root, proofs, tree };
}

describe("MixerMerkleRoot Contract", function () {
  // This fixture deploys the contract and returns all necessary objects
  async function deployMixerFixture() {
    // Get signers
    const [owner, admin, user1, user2, user3, newFeeRecipient] = await ethers.getSigners();

    // Deploy the contract
    const MixerMerkleRoot = await ethers.getContractFactory("MixerMerkleRoot");
    const mixer = await MixerMerkleRoot.deploy(admin.address);
    await mixer.waitForDeployment();

    // Initial deposit amount and fee
    const depositAmount = ethers.parseEther("10000");
    const initialFee = 100; // 1%

    // Create sample recipient data for Merkle tree
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const releaseTime = currentTimestamp + 1; // 1 second from now

    const recipients = [
      {
        address: user2.address,
        amount: ethers.parseEther("0.5"),
        releaseTime: releaseTime
      },
      {
        address: user3.address,
        amount: ethers.parseEther("0.3"),
        releaseTime: releaseTime + 1 // 1 second from now
      }
    ];

    // Create Merkle tree and proofs
    const { root, proofs } = createMerkleTree(recipients);

    return {
      mixer,
      owner,
      admin,
      user1,
      user2,
      user3,
      newFeeRecipient,
      depositAmount,
      initialFee,
      merkleRoot: root,
      recipients,
      proofs
    };
  }

  describe("Deployment", function () {
    it("Should set the right owner and admin roles", async function () {
      const { mixer, owner, admin } = await loadFixture(deployMixerFixture);

      // Check roles
      const OWNER_ROLE = await mixer.OWNER_ROLE();
      const ADMIN_ROLE = await mixer.ADMIN_ROLE();
      const DEFAULT_ADMIN_ROLE = await mixer.DEFAULT_ADMIN_ROLE();

      expect(await mixer.hasRole(OWNER_ROLE, owner.address)).to.equal(true);
      expect(await mixer.hasRole(ADMIN_ROLE, admin.address)).to.equal(true);
      expect(await mixer.hasRole(DEFAULT_ADMIN_ROLE, owner.address)).to.equal(true);
    });

    it("Should set the correct initial fee and recipient", async function () {
      const { mixer, owner, initialFee } = await loadFixture(deployMixerFixture);

      expect(await mixer.getFee()).to.equal(initialFee);
      expect(await mixer.feeRecipient()).to.equal(owner.address);
    });
  });

  describe("Deposits", function () {
    it("Should allow users to deposit ETH with Merkle root", async function () {
      const { mixer, user1, depositAmount, merkleRoot } = await loadFixture(deployMixerFixture);

      // Deposit ETH with Merkle root
      const tx = await mixer.connect(user1).deposit(merkleRoot, { value: depositAmount });
      const receipt = await tx.wait();

      // Find DepositCreated event
      const events = receipt.logs.filter(log => {
        try {
          return mixer.interface.parseLog(log).name === "DepositCreated";
        } catch (e) {
          return false;
        }
      });

      expect(events.length).to.equal(1);

      // Verify deposit is recorded
      const event = mixer.interface.parseLog(events[0]);
      const depositId = event.args[0];

      // Verify depositId is the Merkle root
      expect(depositId).to.equal(merkleRoot);

      const deposit = await mixer.getDeposit(depositId);
      expect(deposit.user).to.equal(user1.address);

      // Verify correct fee calculation
      const fee = await mixer.getFee();
      const feeAmount = depositAmount * BigInt(fee) / BigInt(10000);
      const expectedNetAmount = depositAmount - feeAmount;

      expect(deposit.amount).to.equal(expectedNetAmount);
    });

    it("Should reject zero deposits", async function () {
      const { mixer, user1, merkleRoot } = await loadFixture(deployMixerFixture);

      await expect(mixer.connect(user1).deposit(merkleRoot, { value: 0 }))
        .to.be.revertedWith("Deposit amount must be greater than zero");
    });

    it("Should reject invalid Merkle root", async function () {
      const { mixer, user1, depositAmount } = await loadFixture(deployMixerFixture);

      await expect(mixer.connect(user1).deposit(ethers.ZeroHash, { value: depositAmount }))
        .to.be.revertedWith("Invalid Merkle root");
    });

    it("Should transfer fee to fee recipient", async function () {
      const { mixer, user1, owner, depositAmount, initialFee, merkleRoot } = await loadFixture(deployMixerFixture);

      const feeAmount = depositAmount * BigInt(initialFee) / BigInt(10000);
      const initialOwnerBalance = await ethers.provider.getBalance(owner.address);

      // Make deposit
      await mixer.connect(user1).deposit(merkleRoot, { value: depositAmount });

      // Check owner's balance increased by fee amount
      const newOwnerBalance = await ethers.provider.getBalance(owner.address);
      expect(newOwnerBalance).to.be.greaterThanOrEqual(initialOwnerBalance + feeAmount);
    });
  });

  describe("Transfers with Merkle Proofs", function () {

    it("Should allow admin to transfer ETH using valid Merkle proof", async function () {
      const { mixer, admin, user1, user2, depositAmount, merkleRoot, proofs } = await loadFixture(deployMixerFixture);

      // User1 makes a deposit with merkleRoot
      await mixer.connect(user1).deposit(merkleRoot, { value: depositAmount });

      // Find user2's proof
      const user2Proof = proofs.find(p => p.address === user2.address);

      // Check user2's balance before transfer
      const initialUser2Balance = await ethers.provider.getBalance(user2.address);

      // Get current block timestamp
      const currentBlock = await ethers.provider.getBlock("latest");
      const currentTimestamp = currentBlock!.timestamp;

      // console.log("Current block timestamp:", currentTimestamp);
      // console.log("Release time in proof:", user2Proof.releaseTime);

      // Make sure time has advanced sufficiently
      // If the releaseTime is in the future, advance time beyond it
      if (user2Proof.releaseTime > currentTimestamp) {
        const timeToAdvance = user2Proof.releaseTime - currentTimestamp + 10; // Add 10 seconds buffer
        // console.log("Advancing time by:", timeToAdvance, "seconds");
        await ethers.provider.send("evm_increaseTime", [timeToAdvance]);
        await ethers.provider.send("evm_mine");

        // Verify time has advanced
        const newBlock = await ethers.provider.getBlock("latest");
        // console.log("New block timestamp:", newBlock!.timestamp);
      }

      // Admin transfers ETH to user2 using Merkle proof
      await mixer.connect(admin).transferEther(
        merkleRoot,
        user2.address,
        user2Proof.amount,
        user2Proof.releaseTime,
        user2Proof.proof
      );

      // Check user2's balance after transfer
      const newUser2Balance = await ethers.provider.getBalance(user2.address);
      expect(newUser2Balance).to.equal(initialUser2Balance + user2Proof.amount);
    });


    it("Should prevent transfer before release time", async function () {
      const { mixer, admin, user1, user3, depositAmount, merkleRoot, proofs } = await loadFixture(deployMixerFixture);

      // User1 makes a deposit with merkleRoot
      await mixer.connect(user1).deposit(merkleRoot, { value: depositAmount });

      // Find user3's proof (has a later release time)
      const user3Proof = proofs.find(p => p.address === user3.address);

      // Admin tries to transfer ETH before release time
      await expect(
        mixer.connect(admin).transferEther(
          merkleRoot,
          user3.address,
          user3Proof.amount,
          user3Proof.releaseTime,
          user3Proof.proof
        )
      ).to.be.revertedWith("Funds not yet available");
    });

    it("Should prevent double withdrawals", async function () {
      const { mixer, admin, user1, user2, depositAmount, merkleRoot, proofs } = await loadFixture(deployMixerFixture);

      // User1 makes a deposit with merkleRoot
      await mixer.connect(user1).deposit(merkleRoot, { value: depositAmount });

      // Find user2's proof
      const user2Proof = proofs.find(p => p.address === user2.address);



      // Get current block timestamp
      const currentBlock = await ethers.provider.getBlock("latest");
      const currentTimestamp = currentBlock!.timestamp;

      // console.log("Current block timestamp:", currentTimestamp);
      // console.log("Release time in proof:", user2Proof.releaseTime);

      const timeToAdvance = user2Proof.releaseTime - currentTimestamp + 10; // Add 10 seconds buffer
      // console.log("Advancing time by:", timeToAdvance, "seconds");
      await ethers.provider.send("evm_increaseTime", [timeToAdvance]);
      await ethers.provider.send("evm_mine");

      // Verify time has advanced
      const newBlock = await ethers.provider.getBlock("latest");
      // console.log("New block timestamp:", newBlock!.timestamp);

      // Admin transfers ETH to user2 first time
      await mixer.connect(admin).transferEther(
        merkleRoot,
        user2.address,
        user2Proof.amount,
        user2Proof.releaseTime,
        user2Proof.proof
      );

      // Admin tries to transfer ETH to user2 again (should fail)
      await expect(
        mixer.connect(admin).transferEther(
          merkleRoot,
          user2.address,
          user2Proof.amount,
          user2Proof.releaseTime,
          user2Proof.proof
        )
      ).to.be.revertedWith("Already withdrawn");
    });

    it("Should verify withdrawal status correctly", async function () {
      const { mixer, admin, user1, user2, depositAmount, merkleRoot, proofs } = await loadFixture(deployMixerFixture);

      // User1 makes a deposit with merkleRoot
      await mixer.connect(user1).deposit(merkleRoot, { value: depositAmount });

      // Find user2's proof
      const user2Proof = proofs.find(p => p.address === user2.address);

      // Check initial withdrawal status
      expect(await mixer.hasUserWithdrawn(merkleRoot, user2.address, user2Proof.releaseTime)).to.equal(false);

      // Get current block timestamp
      const currentBlock = await ethers.provider.getBlock("latest");
      const currentTimestamp = currentBlock!.timestamp;

      // console.log("Current block timestamp:", currentTimestamp);
      // console.log("Release time in proof:", user2Proof.releaseTime);

      // Make sure time has advanced sufficiently
      // If the releaseTime is in the future, advance time beyond it
      if (user2Proof.releaseTime > currentTimestamp) {
        const timeToAdvance = user2Proof.releaseTime - currentTimestamp + 10; // Add 10 seconds buffer
        // console.log("Advancing time by:", timeToAdvance, "seconds");
        await ethers.provider.send("evm_increaseTime", [timeToAdvance]);
        await ethers.provider.send("evm_mine");

        // Verify time has advanced
        const newBlock = await ethers.provider.getBlock("latest");
        // console.log("New block timestamp:", newBlock!.timestamp);
      }

      // Admin transfers ETH to user2
      await mixer.connect(admin).transferEther(
        merkleRoot,
        user2.address,
        user2Proof.amount,
        user2Proof.releaseTime,
        user2Proof.proof
      );

      // Check withdrawal status after transfer
      expect(await mixer.hasUserWithdrawn(merkleRoot, user2.address, user2Proof.releaseTime)).to.equal(true);
    });

    it("Should reject transfer with invalid Merkle proof", async function () {
      const { mixer, admin, user1, user2, user3, depositAmount, merkleRoot, proofs } = await loadFixture(deployMixerFixture);

      // User1 makes a deposit with merkleRoot
      await mixer.connect(user1).deposit(merkleRoot, { value: depositAmount });

      // Find user2's proof
      const user2Proof = proofs.find(p => p.address === user2.address);
      // Find user3's proof
      const user3Proof = proofs.find(p => p.address === user3.address);

      // Get current block timestamp
      const currentBlock = await ethers.provider.getBlock("latest");
      const currentTimestamp = currentBlock!.timestamp;

      // console.log("Current block timestamp:", currentTimestamp);
      // console.log("Release time in proof:", user2Proof.releaseTime);

      // Make sure time has advanced sufficiently
      // If the releaseTime is in the future, advance time beyond it
      if (user3Proof.releaseTime > currentTimestamp) {
        const timeToAdvance = user2Proof.releaseTime - currentTimestamp + 10; // Add 10 seconds buffer
        // console.log("Advancing time by:", timeToAdvance, "seconds");
        await ethers.provider.send("evm_increaseTime", [timeToAdvance]);
        await ethers.provider.send("evm_mine");

        // Verify time has advanced
        const newBlock = await ethers.provider.getBlock("latest");
        // console.log("New block timestamp:", newBlock!.timestamp);
      }

      // Admin tries to transfer ETH to user2 but with user3's proof (should fail)
      await expect(
        mixer.connect(admin).transferEther(
          merkleRoot,
          user2.address,
          user2Proof.amount,
          user2Proof.releaseTime,
          user3Proof.proof
        )
      ).to.be.revertedWith("Invalid merkle proof");
    });
  });

  describe("Emergency Withdraw", function () {
    it("Should allow owner to emergency withdraw", async function () {
      const { mixer, owner, user1, depositAmount, merkleRoot } = await loadFixture(deployMixerFixture);

      // User1 makes a deposit with merkleRoot
      await mixer.connect(user1).deposit(merkleRoot, { value: depositAmount });

      // Calculate net deposit amount
      const fee = await mixer.getFee();
      const feeAmount = depositAmount * BigInt(fee) / BigInt(10000);
      const netAmount = depositAmount - feeAmount;

      // Check user1's balance before emergency withdraw
      const initialUser1Balance = await ethers.provider.getBalance(user1.address);

      // Owner performs emergency withdraw
      await mixer.connect(owner).emergencyWithdraw(merkleRoot);

      // Check user1's balance after emergency withdraw
      const newUser1Balance = await ethers.provider.getBalance(user1.address);
      expect(newUser1Balance).to.equal(initialUser1Balance + netAmount);

      // Check deposit is removed
      await expect(mixer.getDeposit(merkleRoot))
        .to.be.revertedWith("Query for nonexistent deposit");
    });
  });

  describe("Fee Management", function () {
    it("Should allow owner to update fee", async function () {
      const { mixer, owner, initialFee } = await loadFixture(deployMixerFixture);

      const newFee = 200; // 2%

      await expect(mixer.connect(owner).setFee(newFee))
        .to.emit(mixer, "FeeUpdated")
        .withArgs(initialFee, newFee);

      // Check fee is updated
      expect(await mixer.getFee()).to.equal(newFee);
    });

    it("Should not allow fee above MAX_FEE", async function () {
      const { mixer, owner } = await loadFixture(deployMixerFixture);

      const maxFee = await mixer.MAX_FEE();
      const invalidFee = maxFee + BigInt(1);

      await expect(mixer.connect(owner).setFee(invalidFee))
        .to.be.revertedWith("Fee cannot exceed maximum (10%)");
    });

    it("Should allow owner to update fee recipient", async function () {
      const { mixer, owner, newFeeRecipient } = await loadFixture(deployMixerFixture);

      const currentFeeRecipient = await mixer.feeRecipient();

      await expect(mixer.connect(owner).setFeeRecipient(newFeeRecipient.address))
        .to.emit(mixer, "FeeRecipientUpdated")
        .withArgs(currentFeeRecipient, newFeeRecipient.address);

      // Check fee recipient is updated
      expect(await mixer.feeRecipient()).to.equal(newFeeRecipient.address);
    });
  });

  describe("Pause Functionality", function () {
    it("Should allow owner to pause the contract", async function () {
      const { mixer, owner } = await loadFixture(deployMixerFixture);

      // Initially contract should not be paused
      expect(await mixer.paused()).to.equal(false);

      // Owner pauses the contract
      await mixer.connect(owner).setPaused(true);

      // Check contract is paused
      expect(await mixer.paused()).to.equal(true);
    });

    it("Should prevent deposits when paused", async function () {
      const { mixer, owner, user1, depositAmount, merkleRoot } = await loadFixture(deployMixerFixture);

      // Owner pauses the contract
      await mixer.connect(owner).setPaused(true);

      // Try to make a deposit
      await expect(mixer.connect(user1).deposit(merkleRoot, { value: depositAmount }))
        .to.be.revertedWith("Contract is paused");
    });

    it("Should prevent transfers when paused", async function () {
      const { mixer, owner, admin, user1, user2, depositAmount, merkleRoot, proofs } = await loadFixture(deployMixerFixture);

      // User1 makes a deposit with merkleRoot
      await mixer.connect(user1).deposit(merkleRoot, { value: depositAmount });

      // Find user2's proof
      const user2Proof = proofs.find(p => p.address === user2.address);

      // Increase time to allow withdrawal
      await ethers.provider.send("evm_increaseTime", [3600]);
      await ethers.provider.send("evm_mine");

      // Owner pauses the contract
      await mixer.connect(owner).setPaused(true);

      // Try to transfer ETH
      await expect(
        mixer.connect(admin).transferEther(
          merkleRoot,
          user2.address,
          user2Proof.amount,
          user2Proof.releaseTime,
          user2Proof.proof
        )
      ).to.be.revertedWith("Contract is paused");
    });
  });
});