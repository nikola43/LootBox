

// @ts-ignore
import { parseEther } from 'ethers';
import { ethers } from 'hardhat';

const main = async () => {
  const LootBox = await ethers.getContractAt('LootBox', "0x68d2Ecd85bDEbfFd075Fb6D87fFD829AD025DD5C");
  const totalBoxes = await LootBox.totalBoxes();
  console.log(`Total boxes: ${totalBoxes}`);

  const createBoxTx = await LootBox.createBox(1,0, "0x0000000000000000000000000000000000000000", parseEther("1000"), {
    value: parseEther("1000")
  });
  await createBoxTx.wait();
  console.log(`Create box transaction hash: ${createBoxTx.hash}`);

  const boxId = await LootBox.getBoxIdAt(totalBoxes);
  console.log(`Box ID: ${boxId}`);
  const box = await LootBox.getBox(boxId);
  console.log(`Box: ${box}`);

  const requestRandomWordsTx = await LootBox.requestRandomWords(1, boxId);
  console.log(`requestRandomWords transaction hash: ${requestRandomWordsTx.hash}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });







