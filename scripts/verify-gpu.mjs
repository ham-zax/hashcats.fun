import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Gpu } from "../src/gpu.mjs";
import { checkGpu } from "../src/miner.mjs";
import { workHash, MAX_UINT256 } from "../src/protocol.mjs";

const total = Number(process.argv[2] ?? 1000000);
if (!Number.isSafeInteger(total) || total < 1)
  throw new Error("Provide a positive comparison count");
const bytes = (label) => createHash("sha256").update(label).digest("hex");
const gpu = new Gpu();
try {
  console.log(await checkGpu(gpu));
  let checked = 0,
    batch = 0;
  while (checked < total) {
    const job = {
      miner: `0x${bytes(`miner${batch}`).slice(0, 40)}`,
      prev: BigInt(`0x${bytes(`prev${batch}`)}`),
      anchor: `0x${bytes(`anchor${batch}`)}`,
      target: 0n,
    };
    const prefix = BigInt(`0x${bytes(`prefix${batch}`).slice(0, 48)}`) << 64n;
    // Alternate a 32-bit carry boundary with large counters; every job has different full-width input.
    const counter =
      batch % 2
        ? (1n << 32n) - 64n
        : BigInt(`0x${bytes(`counter${batch}`).slice(0, 12)}`);
    const count = Math.min(8192, total - checked);
    const result = await gpu.batch(job, prefix, counter, count, {
      diagnostic: true,
    });
    assert.equal(result.digests.length, count);
    for (let i = 0; i < count; i++)
      assert.equal(
        result.digests[i],
        workHash(job.miner, prefix + counter + BigInt(i), job.prev, job.anchor),
      );
    checked += count;
    batch++;
    if (batch % 8 === 0 || checked === total)
      console.log(
        `Verified ${checked.toLocaleString()} / ${total.toLocaleString()} full CUDA digests`,
      );
  }
  // Exercise the actual candidate path and exact < comparison, including equality rejection.
  const job = {
    miner: `0x${"11".repeat(20)}`,
    prev: 0n,
    anchor: `0x${"22".repeat(32)}`,
    target: 0n,
  };
  const hash = workHash(job.miner, 0n, job.prev, job.anchor);
  assert.equal(
    (await gpu.batch({ ...job, target: BigInt(hash) }, 0n, 0n, 1)).candidates
      .length,
    0,
  );
  assert.equal(
    (await gpu.batch({ ...job, target: BigInt(hash) + 1n }, 0n, 0n, 1))
      .candidates.length,
    1,
  );
  const prefix = MAX_UINT256 - ((1n << 64n) - 1n);
  const last = await gpu.batch(job, prefix, (1n << 64n) - 1n, 1, {
    diagnostic: true,
  });
  assert.equal(
    last.digests[0],
    workHash(job.miner, MAX_UINT256, job.prev, job.anchor),
  );
  await assert.rejects(
    gpu.batch(job, prefix, (1n << 64n) - 1n, 2),
    /Invalid GPU nonce range/,
  );
  await assert.rejects(
    gpu.batch({ ...job, target: MAX_UINT256 }, 0n, 0n, 256),
    /candidate buffer overflow/,
  );
  console.log(
    "PASS: full digests, high nonce bits, carry boundaries, uint256 limit, exact target equality, candidate output and overflow detection",
  );
} finally {
  gpu.close();
}
