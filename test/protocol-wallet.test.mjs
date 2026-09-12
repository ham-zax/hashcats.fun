import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  Wallet,
  HDNodeWallet,
  Transaction,
  parseEther,
  ZeroAddress,
} from "ethers";
import {
  ABI,
  assertFresh,
  checkGoldenVectors,
  MAX_UINT256,
  proofIsValid,
  workHash,
} from "../src/protocol.mjs";
import {
  importMnemonic,
  saveWallet,
  unlockWallet,
  walletAddress,
  checkSigner,
  assertSigned,
} from "../src/wallet.mjs";
import { Journal } from "../src/journal.mjs";
import { appendFileSync, existsSync } from "node:fs";

test("Keccak vectors and ABI selectors match the observed contract", () => {
  checkGoldenVectors();
  assert.equal(ABI.getFunction("mine").selector, "0x071e9503");
  assert.equal(ABI.getFunction("targetFor").selector, "0x16ccc8c0");
  assert.equal(ABI.getFunction("workHash").selector, "0xc1343e45");
});

test("full target is strict and job validity uses the original anchor", () => {
  const job = {
    miner: ZeroAddress,
    prev: 0n,
    anchor: `0x${"00".repeat(32)}`,
    target: MAX_UINT256,
    anchorBlock: 10n,
    blockNumber: 20n,
    anchorWindow: 250n,
    observedAt: Date.now(),
  };
  const hash = workHash(job.miner, 0n, job.prev, job.anchor);
  assert.equal(proofIsValid({ ...job, target: BigInt(hash) }, 0n).valid, false);
  assert.equal(
    proofIsValid({ ...job, target: BigInt(hash) + 1n }, 0n).valid,
    true,
  );
  assert.throws(
    () => proofIsValid(job, 0n, `0x${"ff".repeat(32)}`),
    /mismatch/,
  );
  assertFresh({ ...job, hash }, job);
  assert.throws(
    () => assertFresh({ ...job, hash }, { ...job, prev: 1n }),
    /Previous work/,
  );
  assert.throws(
    () => assertFresh({ ...job, hash }, { ...job, blockNumber: 230n }),
    /expiry/,
  );
  assert.throws(
    () =>
      assertFresh({ ...job, hash }, { ...job, observedAt: Date.now() - 5000 }),
    /stale/,
  );
});

test("mnemonic import must match the expected address; keystore contains only the account", async () => {
  const generated = HDNodeWallet.createRandom();
  assert.throws(
    () => importMnemonic(generated.mnemonic.phrase, ZeroAddress),
    /Derived/,
  );
  const wallet = importMnemonic(generated.mnemonic.phrase, generated.address);
  const dir = await mkdtemp(join(tmpdir(), "hashcats-wallet-test-"));
  const file = join(dir, "wallet.json");
  await saveWallet(wallet, file, "test-password");
  const raw = await readFile(file, "utf8");
  assert.equal(raw.includes(generated.mnemonic.phrase), false);
  assert.equal(raw.includes(wallet.privateKey), false);
  assert.equal(raw.includes("x-ethers"), false);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(await walletAddress(file), wallet.address);
  assert.equal(
    (await unlockWallet(file, "test-password")).address,
    wallet.address,
  );
  await assert.rejects(unlockWallet(file, "wrong"), /Cannot unlock/);
  await assert.rejects(saveWallet(wallet, file, "test-password"), /EEXIST/);
  await checkSigner(wallet);
});

test("signer rejects altered transaction fields", async () => {
  const wallet = Wallet.createRandom();
  const request = {
    type: 0,
    chainId: 4663,
    to: wallet.address,
    nonce: 0,
    value: parseEther("0.001"),
    gasLimit: 21000n,
    gasPrice: 1n,
    data: "0x",
  };
  const signed = await wallet.signTransaction(request);
  assert.equal(Transaction.from(signed).from, wallet.address);
  assert.throws(
    () => assertSigned(signed, wallet.address, { ...request, value: 0n }),
    /does not match/,
  );
});

test("journal locks nonce ownership, recovers a partial tail, and preserves pending signed bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hashcats-journal-test-"));
  const path = join(dir, "journal.jsonl");
  const identity = {
    address: Wallet.createRandom().address,
    chainId: 4663,
    collection: ZeroAddress,
  };
  const first = new Journal(path, identity);
  assert.throws(() => new Journal(path, identity), /locked/);
  first.append({ type: "signed", id: "a", hash: "0x123", raw: "0x456" });
  first.close();
  appendFileSync(path, '{"type":"broken');
  const second = new Journal(path, identity);
  assert.equal(second.pending()[0].raw, "0x456");
  second.append({ type: "receipt", hash: "0x123", cost: "100" });
  assert.equal(second.pending().length, 0);
  assert.equal(second.spent(), 100n);
  second.close();
  assert.equal(existsSync(`${path}.lock`), false);
  assert.throws(
    () => new Journal(path, { ...identity, chainId: 1 }),
    /another wallet/,
  );
});
