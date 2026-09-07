import { encodeFunctionData, isAddress } from "viem";

// approve(address,uint256) has the same selector on both ERC721 (approve a
// single tokenId) and ERC20 (approve a spend amount) -- one encoder covers
// the per-token NFT approval and the exact-amount USDC approval alike.
const APPROVE_ABI = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amountOrTokenId", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export function encodeApproveCalldata(spender: string, amountOrTokenId: string) {
  if (!isAddress(spender)) {
    throw new Error("Invalid approval target address.");
  }

  return encodeFunctionData({
    abi: APPROVE_ABI,
    functionName: "approve",
    args: [spender, BigInt(amountOrTokenId)],
  });
}
