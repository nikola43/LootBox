

// @ts-ignore
import { ethers, upgrades } from "hardhat";
import { getImplementationAddress } from "@openzeppelin/upgrades-core";


const main = async () => {
  const signers = await ethers.getSigners();
  const deployer = signers[0];

  console.log(`Deploying contracts with the account: ${deployer.address}`);

  const LootBoxFactory = await ethers.getContractFactory('LootBox');
  const oracle1 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
  const oracle2 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"

  const LootBox = await upgrades.deployProxy(LootBoxFactory, {
    initializer: "initialize",
  });
  await LootBox.waitForDeployment();
  await LootBox.setOracle(oracle1, true);
  await LootBox.setOracle(oracle2, true);

  const implAddress = await getImplementationAddress(
    ethers.provider,
    LootBox.target.toString()
  );

  console.log(`LootBox deployed to: ${LootBox.target}`);
  console.log(`LootBox implementation deployed to: ${implAddress}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });







