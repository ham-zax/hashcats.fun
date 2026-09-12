import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Rpc, RpcUnavailableError, selectRpcs } from "../src/rpc.mjs";
import {
  ABI,
  MAX_UINT256,
  workHash,
  StaleProofError,
} from "../src/protocol.mjs";
import { mine } from "../src/miner.mjs";

async function mockRpc(t, handler) {
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    handler(JSON.parse(body), response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return new Rpc(`http://127.0.0.1:${server.address().port}`);
}

function respond(response, payload, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

test("RPC matches out-of-order response IDs and falls back from rejected read batches", async (t) => {
  let batches = 0,
    singles = 0;
  const rpc = await mockRpc(t, (payload, response) => {
    if (Array.isArray(payload)) {
      batches++;
      return respond(response, {}, 500);
    }
    singles++;
    respond(response, {
      jsonrpc: "2.0",
      id: payload.id,
      result: payload.method,
    });
  });
  const calls = ["eth_chainId", "eth_blockNumber", "eth_gasPrice"].map(
    (method) => [method, []],
  );
  assert.deepEqual(
    await rpc.batch(calls),
    calls.map(([method]) => method),
  );
  assert.deepEqual(
    await rpc.batch(calls),
    calls.map(([method]) => method),
  );
  assert.equal(batches, 1);
  assert.equal(singles, 6);
  const ordered = await mockRpc(t, (payload, response) =>
    respond(
      response,
      [...payload]
        .reverse()
        .map((item) => ({ jsonrpc: "2.0", id: item.id, result: item.method })),
    ),
  );
  assert.deepEqual(
    await ordered.batch(calls),
    calls.map(([method]) => method),
  );
});

test("RPC rate limiting backs off and never blindly retries a write batch", async (t) => {
  let requests = 0;
  const rpc = await mockRpc(t, (_, response) => {
    requests++;
    response.setHeader("retry-after", "60");
    respond(response, {}, 429);
  });
  await assert.rejects(rpc.call("eth_blockNumber"), RpcUnavailableError);
  await assert.rejects(
    rpc.call("eth_blockNumber"),
    (error) => error.retryAfterMs > 59000,
  );
  assert.equal(requests, 1);
  let writes = 0;
  const failing = await mockRpc(t, (_, response) => {
    writes++;
    respond(response, {}, 500);
  });
  await assert.rejects(
    failing.batch([
      ["eth_sendRawTransaction", ["0x"]],
      ["eth_blockNumber", []],
    ]),
  );
  assert.equal(writes, 1);
});

test("RPC selection retains configured preference but excludes failed verification", async () => {
  const failed = {
    verify: async () => {
      throw new Error("Wrong chain");
    },
  };
  const healthy = { verify: async () => {} };
  assert.deepEqual(await selectRpcs([failed, healthy]), [healthy]);
  await assert.rejects(selectRpcs([failed]), /No configured RPC/);
});

test("snapshot pins contract reads to one block and rejects a block reorg", async (t) => {
  let blockReads = 0;
  const rpc = await mockRpc(t, (payload, response) => {
    const result = (item) => {
      if (item.method === "eth_getBlockByNumber") {
        return {
          hash: `0x${(++blockReads === 1 ? "11" : "22").repeat(32)}`,
          number: "0x10",
          timestamp: "0x1000",
        };
      }
      assert.equal(item.params[1], "0x10");
      const fragment = ABI.getFunction(item.params[0].data.slice(0, 10));
      const values =
        fragment.name === "currentAnchor"
          ? [15n, `0x${"33".repeat(32)}`]
          : [1n];
      return ABI.encodeFunctionResult(fragment, values);
    };
    const answer = (item) => ({
      jsonrpc: "2.0",
      id: item.id,
      result: result(item),
    });
    respond(
      response,
      Array.isArray(payload) ? payload.map(answer) : answer(payload),
    );
  });
  await assert.rejects(
    rpc.snapshot(`0x${"11".repeat(20)}`),
    /reorged during reads/,
  );
});

const address = `0x${"11".repeat(20)}`;
const freshJob = () => ({
  miner: address,
  prev: 0n,
  anchor: `0x${"22".repeat(32)}`,
  target: MAX_UINT256,
  anchorBlock: 10n,
  blockNumber: 11n,
  anchorWindow: 250n,
  observedAt: Date.now(),
  totalMinted: 1n,
  epoch: 0n,
  price: 1n,
});

function fakeGpu(batch) {
  return {
    ready: Promise.resolve({ device: "test only" }),
    hash: async (vector) =>
      workHash(vector.miner, vector.nonce, vector.prev, vector.anchor),
    batch,
    close() {
      this.closed = true;
    },
  };
}

test("miner issues no GPU work from expired snapshots and closes on cancellation", async () => {
  let batches = 0;
  const gpu = fakeGpu(async () => {
    batches++;
    throw new Error("Should not run");
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 80);
  try {
    await mine({
      gpu,
      address,
      rpc: {
        verify: async () => {},
        snapshot: async () => ({
          ...freshJob(),
          observedAt: Date.now() - 5000,
        }),
      },
      signal: controller.signal,
      pollMs: 10,
      onEvent: () => {},
    });
    assert.equal(batches, 0);
    assert.equal(gpu.closed, true);
  } finally {
    clearTimeout(timeout);
  }
});

test("miner resumes after a transient RPC outage and discards a stale candidate without exiting", async () => {
  let reads = 0,
    batches = 0,
    submissions = 0;
  const events = [],
    controller = new AbortController();
  const rpc = {
    verify: async () => {},
    account: async () => ({}),
    snapshot: async () => {
      if (++reads === 1) throw new RpcUnavailableError("Injected outage");
      return freshJob();
    },
  };
  const gpu = fakeGpu(async (job, prefix, counter, count) => {
    batches++;
    if (batches === 2) {
      controller.abort();
      return { ms: 10, candidates: [] };
    }
    return {
      ms: 10,
      candidates: [
        {
          counter: counter.toString(),
          hash: workHash(job.miner, prefix + counter, job.prev, job.anchor),
        },
      ],
    };
  });
  const submitter = {
    journal: { pending: () => [] },
    assertFunds: () => {},
    submit: async () => {
      submissions++;
      throw new StaleProofError("Previous work changed");
    },
  };
  await mine({
    gpu,
    rpc,
    address,
    submitter,
    signal: controller.signal,
    pollMs: 10,
    seconds: 2,
    onEvent: (event) => events.push(JSON.parse(event)),
  });
  assert.equal(batches, 2);
  assert.equal(submissions, 1);
  assert.ok(events.some((event) => event.type === "paused"));
  assert.ok(events.some((event) => event.type === "discarded"));
});
