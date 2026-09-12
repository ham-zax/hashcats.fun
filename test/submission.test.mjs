import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ganache from "ganache";
import solc from "solc";
import {
  BrowserProvider,
  ContractFactory,
  Wallet,
  parseEther,
  keccak256,
} from "ethers";
import { Rpc } from "../src/rpc.mjs";
import { Journal } from "../src/journal.mjs";
import { Submitter, broadcastIdentical } from "../src/submitter.mjs";
import { workHash } from "../src/protocol.mjs";

const source = await readFile(
  new URL("./mining-fixture.sol", import.meta.url),
  "utf8",
);
const compiled = JSON.parse(
  solc.compile(
    JSON.stringify({
      language: "Solidity",
      sources: { "fixture.sol": { content: source } },
      settings: {
        evmVersion: "shanghai",
        outputSelection: { "*": { "*": ["abi", "evm.bytecode"] } },
      },
    }),
  ),
);
if (compiled.errors?.some((error) => error.severity === "error"))
  throw new Error(JSON.stringify(compiled.errors));
const artifact = compiled.contracts["fixture.sol"].MiningFixture;

async function setup(t) {
  const server = ganache.server({
    logging: { quiet: true },
    chain: { chainId: 4663, hardfork: "shanghai" },
    wallet: { totalAccounts: 3 },
  });
  await server.listen(0, "127.0.0.1");
  t.after(() => server.close());
  const provider = new BrowserProvider(server.provider);
  const deployer = await provider.getSigner(0);
  const factory = new ContractFactory(
    artifact.abi,
    artifact.evm.bytecode.object,
    deployer,
  );
  const contract = await factory.deploy();
  await contract.waitForDeployment();
  const wallet = new Wallet(
    Object.values(server.provider.getInitialAccounts())[1].secretKey,
  );
  const rpc = new Rpc(`http://127.0.0.1:${server.address().port}`, {
    collection: await contract.getAddress(),
  });
  const dir = await mkdtemp(join(tmpdir(), "hashcats-integration-"));
  const path = join(dir, "journal.jsonl");
  const identity = {
    address: wallet.address,
    chainId: 4663,
    collection: rpc.collection,
  };
  let journal = new Journal(path, identity);
  t.after(() => journal.close());
  const options = {
    rpc,
    wallet,
    maxPrice: parseEther("0.002"),
    budget: parseEther("0.01"),
    maxGasCost: parseEther("0.001"),
    confirmations: 1,
  };
  return {
    server,
    provider,
    contract,
    wallet,
    rpc,
    options,
    get journal() {
      return journal;
    },
    reopen() {
      journal.close();
      journal = new Journal(path, identity);
      return journal;
    },
    submitter() {
      return new Submitter({ ...options, journal });
    },
  };
}

async function candidateFor(rpc, address) {
  const job = await rpc.snapshot(address);
  for (let nonce = 0n; nonce < 10000n; nonce++) {
    const hash = workHash(address, nonce, job.prev, job.anchor);
    if (BigInt(hash) < job.target) return { ...job, nonce, hash };
  }
  throw new Error("No fixture proof");
}

test("local EVM accepts the real signed mint path and journal records ownership/cost", async (t) => {
  const context = await setup(t),
    submitter = context.submitter();
  await submitter.ready();
  const candidate = await candidateFor(context.rpc, context.wallet.address);
  const sent = await submitter.submit(candidate);
  assert.equal(sent.acknowledged, true);
  const result = await submitter.wait();
  assert.equal(result.state, "minted");
  assert.equal(
    await context.contract.ownerOf(result.tokenId),
    context.wallet.address,
  );
  assert.equal(context.journal.pending().length, 0);
  assert.ok(context.journal.spent() > parseEther("0.001"));
});

test("another mint/work change rejects a candidate before signing", async (t) => {
  const context = await setup(t),
    submitter = context.submitter();
  const candidate = await candidateFor(context.rpc, context.wallet.address);
  await (await context.contract.changeWork()).wait();
  await assert.rejects(submitter.submit(candidate), /Previous work changed/);
  assert.equal(
    context.journal.records.filter((record) => record.type === "signed").length,
    0,
  );
});

test("an accepted transaction with a lost RPC response recovers by its original hash after restart", async (t) => {
  const context = await setup(t);
  const original = context.rpc.call.bind(context.rpc);
  context.rpc.call = async (method, params) => {
    const result = await original(method, params);
    if (method === "eth_sendRawTransaction")
      throw new Error("Injected response loss after acceptance");
    return result;
  };
  const submitter = context.submitter();
  const sent = await submitter.submit(
    await candidateFor(context.rpc, context.wallet.address),
  );
  assert.equal(sent.acknowledged, false);
  const raw = context.journal.pending()[0].raw;
  assert.equal(keccak256(raw), sent.hash);
  context.reopen();
  context.rpc.call = original;
  const result = await context.submitter().reconcile();
  assert.equal(result.state, "minted");
  assert.equal(result.hash, sent.hash);
  assert.equal(await context.contract.totalMinted(), 1n);
});

test("broadcast reaches the fast endpoint without waiting for a slow one", async () => {
  const wallet = Wallet.createRandom();
  const raw = await wallet.signTransaction({
    type: 0,
    chainId: 4663,
    to: wallet.address,
    value: 0n,
    nonce: 0,
    gasLimit: 21000n,
    gasPrice: 1n,
  });
  const hash = keccak256(raw);
  let slowFinished = false;
  const slow = {
    call: async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      slowFinished = true;
      return hash;
    },
  };
  const fast = { call: async () => hash };
  assert.equal(
    (await broadcastIdentical([slow, fast], raw)).acknowledged,
    true,
  );
  assert.equal(slowFinished, false);
});

test("price/funding/budget gate runs before the worker is armed", async (t) => {
  const context = await setup(t);
  await assert.rejects(
    new Submitter({
      ...context.options,
      journal: context.journal,
      maxPrice: 1n,
    }).ready(),
    /price exceeds/,
  );
  await assert.rejects(
    new Submitter({
      ...context.options,
      journal: context.journal,
      budget: 1n,
    }).ready(),
    /budget exhausted/,
  );
  const snapshot = await context.rpc.snapshot(context.wallet.address);
  assert.throws(
    () =>
      context
        .submitter()
        .assertFunds(snapshot, { balance: 0n, pending: 0n, latest: 0n }),
    /Insufficient/,
  );
});

test("expiry, anchor reorg and external nonce conflicts reject before signing", async (t) => {
  const context = await setup(t),
    candidate = await candidateFor(context.rpc, context.wallet.address);
  const originalSnapshot = context.rpc.snapshot.bind(context.rpc);
  context.rpc.snapshot = async (address) => ({
    ...(await originalSnapshot(address)),
    blockNumber: candidate.anchorBlock + 220n,
  });
  await assert.rejects(context.submitter().submit(candidate), /expiry/);
  context.rpc.snapshot = originalSnapshot;
  const originalAnchor = context.rpc.anchorHash.bind(context.rpc);
  context.rpc.anchorHash = async () => `0x${"ff".repeat(32)}`;
  await assert.rejects(context.submitter().submit(candidate), /reorg/);
  context.rpc.anchorHash = originalAnchor;
  const originalAccount = context.rpc.account.bind(context.rpc);
  context.rpc.account = async (address) => ({
    ...(await originalAccount(address)),
    pending: 1n,
  });
  await assert.rejects(
    context.submitter().submit(candidate),
    /untracked pending/,
  );
  assert.equal(context.journal.pending().length, 0);
});

test("a reverted transaction charges gas only and releases the journal transaction", async (t) => {
  const context = await setup(t);
  const original = context.rpc.call.bind(context.rpc);
  context.rpc.call = async (method, params) => {
    // Simulate a competitor winning after our estimate/sign but before inclusion.
    if (method === "eth_sendRawTransaction")
      await (await context.contract.setTarget(0n)).wait();
    return original(method, params);
  };
  await context
    .submitter()
    .submit(await candidateFor(context.rpc, context.wallet.address));
  const result = await context.submitter().wait();
  assert.equal(result.state, "reverted");
  assert.ok(result.cost > 0n && result.cost < parseEther("0.001"));
  assert.equal(context.journal.pending().length, 0);
  assert.equal(await context.contract.totalMinted(), 0n);
});

test("stale signed bytes are not rebroadcast and an unknown consumed nonce never gets reused", async (t) => {
  const context = await setup(t);
  const original = context.rpc.call.bind(context.rpc);
  let broadcasts = 0;
  context.rpc.call = async (method, params) => {
    if (method === "eth_sendRawTransaction") {
      broadcasts++;
      throw new Error("Injected outage before acceptance");
    }
    return original(method, params);
  };
  await context
    .submitter()
    .submit(await candidateFor(context.rpc, context.wallet.address));
  await (await context.contract.changeWork()).wait();
  assert.equal(
    (await context.submitter().reconcile({ rebroadcast: true })).state,
    "stale_pending",
  );
  assert.equal(broadcasts, 1);
  const account = context.rpc.account.bind(context.rpc);
  context.rpc.account = async (address) => ({
    ...(await account(address)),
    latest: 1n,
    pending: 1n,
  });
  await assert.rejects(context.submitter().reconcile(), /nonce was consumed/);
  assert.equal(context.journal.pending().length, 1);
});

test("a previously recorded receipt reorg prevents rearming", async (t) => {
  const context = await setup(t),
    submitter = context.submitter();
  await submitter.submit(
    await candidateFor(context.rpc, context.wallet.address),
  );
  await submitter.wait();
  const original = context.rpc.call.bind(context.rpc);
  context.rpc.call = async (method, params) => {
    const result = await original(method, params);
    return method === "eth_getBlockByNumber"
      ? { ...result, hash: `0x${"ff".repeat(32)}` }
      : result;
  };
  await assert.rejects(submitter.ready(), /receipt reorged/);
});

test("cancellation before signing cannot create a transaction", async (t) => {
  const context = await setup(t),
    controller = new AbortController();
  const candidate = await candidateFor(context.rpc, context.wallet.address);
  controller.abort();
  await assert.rejects(
    new Submitter({
      ...context.options,
      journal: context.journal,
      signal: controller.signal,
    }).submit(candidate),
    /aborted/,
  );
  assert.equal(context.journal.pending().length, 0);
});
