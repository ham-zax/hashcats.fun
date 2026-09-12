import test from "node:test";
import assert from "node:assert/strict";
import { Submitter } from "../src/submitter.mjs";
import {
  CHAIN_ID,
  COLLECTION,
  MAX_UINT256,
  workHash,
} from "../src/protocol.mjs";

// In-memory fixture: no files, real wallet keys, RPC connections or broadcasts.
function fixture() {
  const address = `0x${"11".repeat(20)}`;
  const job = {
    miner: address,
    nonce: 0n,
    prev: 0n,
    anchor: `0x${"22".repeat(32)}`,
    anchorBlock: 1n,
    blockNumber: 2n,
    anchorWindow: 250n,
    target: MAX_UINT256,
    price: 1n,
    observedAt: Date.now(),
  };
  const candidate = { ...job, hash: workHash(address, 0n, 0n, job.anchor) };
  const records = [];
  const journal = {
    append: (record) => records.push(record),
    pending: () => [],
    spent: () => 0n,
  };
  const wallet = {
    address,
    signTransaction: async () => {
      throw new Error("Unexpected signing");
    },
  };
  const account = { balance: 1000000n, latest: 0n, pending: 0n, gasPrice: 1n };
  const rpc = {
    chainId: CHAIN_ID,
    collection: COLLECTION,
    snapshot: async () => ({ ...job, observedAt: Date.now() }),
    account: async () => account,
    anchorHash: async () => job.anchor,
    call: async (method) => {
      if (method === "eth_estimateGas") return "0x5208";
      if (method === "eth_getTransactionCount") return "0x0";
      throw new Error(`Unexpected RPC method: ${method}`);
    },
  };
  const submitter = new Submitter({
    rpc,
    wallet,
    journal,
    maxPrice: 10n,
    budget: 1000000n,
    maxGasCost: 100000n,
  });
  return { candidate, records, rpc, wallet, submitter };
}

test("final nonce reads cannot bypass snapshot freshness before signing", async () => {
  const context = fixture();
  const originalCall = context.rpc.call;
  const originalSnapshot = context.rpc.snapshot;
  let snapshots = 0,
    finalSnapshot;
  context.rpc.snapshot = async () => {
    const snapshot = await originalSnapshot();
    if (++snapshots === 2) finalSnapshot = snapshot;
    return snapshot;
  };
  context.rpc.call = async (method, params) => {
    if (method === "eth_getTransactionCount") {
      // Cross an asynchronous boundary, then model four seconds of RPC latency
      // without sleeping or changing the process-wide clock.
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(finalSnapshot);
      finalSnapshot.observedAt = Date.now() - 4000;
    }
    return originalCall(method, params);
  };
  await assert.rejects(
    context.submitter.submit(context.candidate),
    /Chain state is stale/,
  );
  assert.equal(
    context.records.some((record) => record.type === "signed"),
    false,
  );
});

test("final nonce validation still rejects external wallet use", async () => {
  const context = fixture();
  const originalCall = context.rpc.call;
  context.rpc.call = async (method, params) =>
    method === "eth_getTransactionCount" ? "0x1" : originalCall(method, params);
  await assert.rejects(
    context.submitter.submit(context.candidate),
    /Account nonce changed/,
  );
  assert.equal(
    context.records.some((record) => record.type === "signed"),
    false,
  );
});

test("fresh final reads still reach local signing", async () => {
  const context = fixture();
  let signed = false;
  context.wallet.signTransaction = async () => {
    signed = true;
    throw new Error("Signing reached");
  };
  await assert.rejects(
    context.submitter.submit(context.candidate),
    /Signing reached/,
  );
  assert.equal(signed, true);
});
