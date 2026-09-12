import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { GpuPool, partitionWork, selectDevices } from "../src/gpu-pool.mjs";
import { COUNTER_LIMIT } from "../src/gpu.mjs";
import { checkGpu, mine } from "../src/miner.mjs";
import { benchmark } from "../src/benchmark.mjs";
import { workHash, MAX_UINT256, GOLDEN_VECTORS } from "../src/protocol.mjs";

const available = [0, 1, 2].map((index) => ({
  index,
  name: `mock GPU ${index}`,
}));
function fixture(count = 3, batch) {
  const calls = [],
    workers = [];
  const pool = new GpuPool({
    discover: async () => available.slice(0, count),
    createWorker: (deviceIndex) => {
      const worker = {
        deviceIndex,
        ready: Promise.resolve({ deviceIndex, uuid: `mock-${deviceIndex}` }),
        hashCalls: 0,
        hash: async (vector) => {
          worker.hashCalls++;
          return workHash(
            vector.miner,
            vector.nonce,
            vector.prev,
            vector.anchor,
          );
        },
        batch: async (job, prefix, counter, size, options) => {
          calls.push({ deviceIndex, prefix, counter, size });
          return batch
            ? batch({ deviceIndex, job, prefix, counter, size, options })
            : { count: size, ms: 10, candidates: [] };
        },
        close() {
          this.closed = true;
        },
      };
      workers.push(worker);
      return worker;
    },
  });
  return { pool, calls, workers };
}

test("device selection defaults to all; explicit order, missing and duplicate indices", () => {
  assert.deepEqual(selectDevices(available), available);
  assert.deepEqual(selectDevices(available, "2,0"), [
    available[2],
    available[0],
  ]);
  for (const selection of ["", "0,", "-1", "01", "0,0", "4"])
    assert.throws(() => selectDevices(available, selection));
  assert.throws(() => selectDevices([]), /No CUDA-visible/);
});

test("partition assigns every nonce once, respects capacity, adapts weights without 32-bit truncation", () => {
  assert.deepEqual(partitionWork(1000, [1, 3]), [250, 750]);
  assert.deepEqual(partitionWork(1000, [1000, 1], 600), [600, 400]);
  assert.deepEqual(partitionWork(2, [1, 1, 1]), [1, 1, 0]);
  const counts = partitionWork(2 ** 32 + 7, Array(100).fill(1));
  assert.equal(
    counts.reduce((a, b) => a + b, 0),
    2 ** 32 + 7,
  );
  assert.ok(counts.every((count) => count > 0 && count <= 2 ** 26));
  for (const [count, weights, capacity] of [
    [0, [1], 10],
    [11, [1], 10],
    [1, [0], 10],
    [1, [1], 0],
  ])
    assert.throws(() => partitionWork(count, weights, capacity));
});

test("all GPUs receive golden vectors, not just the first device", async (t) => {
  const { pool, workers } = fixture();
  t.after(() => pool.close());
  assert.equal((await checkGpu(pool)).deviceCount, 3);
  assert.ok(
    workers.every((worker) => worker.hashCalls === GOLDEN_VECTORS.length),
  );
  workers[2].hash = async () => "bad hash";
  await assert.rejects(checkGpu(pool), /disagree/);
  assert.ok(workers.every((worker) => worker.closed));
});

test("concurrent dispatch uses disjoint contiguous ranges across carry and retains every device's candidates", async (t) => {
  let started = 0,
    release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const { pool, calls } = fixture(3, async ({ counter, size, deviceIndex }) => {
    if (++started === 3) release();
    await barrier;
    return {
      count: size,
      ms: 10 + deviceIndex,
      candidates: [{ counter: String(counter) }],
    };
  });
  t.after(() => pool.close());
  const prefix = 123n << 64n,
    start = (1n << 32n) - 5n;
  const result = await pool.batch({}, prefix, start, 30);
  assert.equal(started, 3);
  assert.deepEqual(
    calls.map((call) => call.counter),
    [start, start + 10n, start + 20n],
  );
  assert.ok(calls.every((call) => call.prefix === prefix && call.size === 10));
  assert.deepEqual(
    result.candidates.map((item) => item.deviceIndex),
    [0, 1, 2],
  );
  assert.equal(result.count, 30);
  assert.equal(result.ms, 12);
  assert.ok(pool.weights[0] > pool.weights[2]);
});

test("diagnostic digests preserve nonce order despite out-of-order completion", async (t) => {
  const { pool } = fixture(3, async ({ counter, size, deviceIndex }) => {
    await sleep((2 - deviceIndex) * 2);
    return {
      count: size,
      ms: 10,
      candidates: [],
      digests: Array.from({ length: size }, (_, i) =>
        String(counter + BigInt(i)),
      ),
    };
  });
  t.after(() => pool.close());
  const result = await pool.batch({}, 0n, 100n, 17, { diagnostic: true });
  assert.deepEqual(
    result.digests,
    Array.from({ length: 17 }, (_, i) => String(100 + i)),
  );
  await assert.rejects(
    pool.batch({}, 0n, COUNTER_LIMIT - 1n, 2),
    /nonce range/,
  );
});

test("one GPU cannot report a candidate from another GPU's range", async () => {
  const { pool, workers } = fixture(2, async ({ size }) => ({
    count: size,
    ms: 10,
    candidates: [{ counter: "0" }],
  }));
  await assert.rejects(pool.batch({}, 0n, 0n, 20), /GPU 1.*outside/);
  assert.ok(workers.every((worker) => worker.closed));
});

test("worker failure stops the entire pool, including partial startup", async () => {
  const { pool, workers } = fixture(3, async () => {
    throw new Error("injected worker failure");
  });
  await assert.rejects(pool.batch({}, 0n, 0n, 100), /injected/);
  assert.ok(workers.every((worker) => worker.closed));
  const first = {
    ready: Promise.resolve({}),
    close() {
      this.closed = true;
    },
  };
  const broken = new GpuPool({
    discover: async () => available,
    createWorker: (index) => {
      if (index) throw new Error("startup failure");
      return first;
    },
  });
  await assert.rejects(broken.ready, /startup failure/);
  assert.equal(first.closed, true);
});

test("overlapping dispatch is rejected and closing drops in-flight results", async () => {
  let release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const { pool } = fixture(2, async ({ size }) => {
    await barrier;
    return { count: size, ms: 10, candidates: [] };
  });
  await pool.ready;
  const running = pool.batch({}, 0n, 0n, 20);
  const rejected = assert.rejects(running, /closed during batch/);
  await assert.rejects(pool.batch({}, 0n, 20n, 20), /already running/);
  pool.close();
  release();
  await rejected;
});

test("simultaneous valid GPU candidates use one shared submission path", async () => {
  const address = `0x${"11".repeat(20)}`;
  const controller = new AbortController();
  let submissions = 0;
  const { pool, calls, workers } = fixture(
    3,
    async ({ job, prefix, counter, size }) => ({
      count: size,
      ms: 10,
      candidates: [
        {
          counter: String(counter),
          hash: workHash(job.miner, prefix + counter, job.prev, job.anchor),
        },
      ],
    }),
  );
  await mine({
    gpu: pool,
    address,
    signal: controller.signal,
    pollMs: 1,
    seconds: 1,
    onEvent: () => {},
    rpc: {
      verify: async () => {},
      account: async () => ({}),
      snapshot: async () => ({
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
      }),
    },
    submitter: {
      journal: { pending: () => [] },
      assertFunds: () => {},
      submit: async () => {
        submissions++;
        controller.abort();
        return { state: "test-only" };
      },
    },
  });
  assert.equal(calls.length, 3);
  assert.equal(submissions, 1);
  assert.ok(workers.every((worker) => worker.closed));
});

test("benchmark reports aggregate and per-device hashes and samples every device", async () => {
  const { pool } = fixture(2, async ({ size }) => {
    await sleep(1);
    return { count: size, ms: 1, candidates: [] };
  });
  const sampled = [];
  const report = await benchmark({
    gpu: pool,
    seconds: 0.02,
    runs: 1,
    warmupSeconds: 0,
    sampleGpu: async (device) => {
      sampled.push(device.uuid);
      return { available: false, deviceIndex: device.deviceIndex };
    },
  });
  assert.equal(report.device.deviceCount, 2);
  assert.deepEqual(sampled, ["mock-0", "mock-1"]);
  const run = report.results[0];
  assert.equal(run.devices.length, 2);
  assert.equal(
    run.devices.reduce((sum, device) => sum + device.hashes, 0),
    run.hashes,
  );
  assert.ok(
    Math.abs(
      run.devices.reduce((sum, device) => sum + device.wallMHs, 0) -
        run.wallMHs,
    ) < 1e-6,
  );
  assert.equal(pool.closed, true);
});
