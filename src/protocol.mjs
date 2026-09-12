import {
  Interface,
  getAddress,
  solidityPackedKeccak256,
  toBeHex,
} from "ethers";

export const CHAIN_ID = 4663;
export const COLLECTION = "0xCA75DF55Cc9C476DB27a7375D1fc8E794cf80721";
export const DEFAULT_RPC = "https://rpc.mainnet.chain.robinhood.com";
export const FALLBACK_RPC = "https://robinhood.drpc.org";
export const MAX_UINT256 = (1n << 256n) - 1n;
export const ABI = new Interface([
  "function workHash(address,uint256,uint256,bytes32) pure returns (uint256)",
  "function targetFor(address) view returns (uint256)",
  "function mine(uint256 nonce,uint256 anchorBlock) payable returns (uint256)",
  "function prevWork() view returns (uint256)",
  "function currentAnchor() view returns (uint256,bytes32)",
  "function mintPrice() view returns (uint256)",
  "function totalMinted() view returns (uint256)",
  "function currentEpoch() view returns (uint256)",
  "function ANCHOR_WINDOW() view returns (uint256)",
  "function ownerOf(uint256) view returns (address)",
  "event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)",
]);

export function uint256(value) {
  const number = BigInt(value);
  if (number < 0n || number > MAX_UINT256)
    throw new Error("Value outside uint256 range");
  return number;
}

export function workHash(miner, nonce, prev, anchor) {
  return solidityPackedKeccak256(
    ["address", "uint256", "uint256", "bytes32"],
    [getAddress(miner), uint256(nonce), uint256(prev), anchor],
  );
}

export function proofIsValid(job, nonce, reportedHash) {
  const hash = workHash(job.miner, nonce, job.prev, job.anchor);
  if (reportedHash && hash.toLowerCase() !== reportedHash.toLowerCase()) {
    throw new Error("GPU/CPU hash mismatch");
  }
  return { hash, valid: BigInt(hash) < uint256(job.target) };
}

export class StaleProofError extends Error {}

export function assertFresh(
  candidate,
  current,
  { margin = 30n, maxAgeMs = 2500 } = {},
) {
  if (Date.now() - current.observedAt > maxAgeMs)
    throw new StaleProofError("Chain state is stale");
  if (getAddress(candidate.miner) !== getAddress(current.miner))
    throw new Error("Miner changed");
  if (BigInt(candidate.prev) !== BigInt(current.prev))
    throw new StaleProofError("Previous work changed");
  const age = BigInt(current.blockNumber) - BigInt(candidate.anchorBlock);
  if (age < 0n || age + margin >= BigInt(current.anchorWindow))
    throw new StaleProofError("Anchor expiry margin reached");
  if (BigInt(candidate.hash) >= BigInt(current.target))
    throw new StaleProofError("Proof no longer meets target");
}

export const hex32 = (value) => toBeHex(uint256(value), 32);
export const json = (value) =>
  JSON.stringify(value, (_, item) =>
    typeof item === "bigint" ? item.toString() : item,
  );

export const GOLDEN_VECTORS = [
  [
    "00".repeat(20),
    0n,
    0n,
    "00".repeat(32),
    "3bdd562417b2b6c29b6c37a0fbf5c08139fe63f7baf013194f112d8319bf8b32",
  ],
  [
    "11".repeat(20),
    1n,
    0n,
    "22".repeat(32),
    "30cc5ea4c833dffdaa3c1f6b4a7581a1b13fd73c1cf4aefcdb4d0ada2b4c0aac",
  ],
  [
    "12".repeat(20),
    0x100000000n,
    1n,
    "ab".repeat(32),
    "a17ffa45319646808b08ddebd0483225badfb58cee06e57258f7033875fc95d8",
  ],
  [
    "ff".repeat(20),
    MAX_UINT256,
    MAX_UINT256,
    "ff".repeat(32),
    "674dddb39f7c9d47047974f64d264092511068452a7a1f662194fdd635606d53",
  ],
  [
    "000102030405060708090a0b0c0d0e0f10111213",
    0x0123456789abcdefn,
    0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1fn,
    "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f",
    "83c4d16de13fe0f5a4d513eecde45ee25e520541e63acaaf4b0e802d8b2df56a",
  ],
].map(([miner, nonce, prev, anchor, hash]) => ({
  miner: `0x${miner}`,
  nonce,
  prev,
  anchor: `0x${anchor}`,
  hash: `0x${hash}`,
}));

export function checkGoldenVectors() {
  for (const vector of GOLDEN_VECTORS) {
    if (
      workHash(vector.miner, vector.nonce, vector.prev, vector.anchor) !==
      vector.hash
    ) {
      throw new Error("Keccak golden vector mismatch");
    }
  }
}
