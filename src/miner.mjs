import { randomUUID } from "node:crypto";
import { Gpu, randomNoncePrefix, COUNTER_LIMIT } from "./gpu.mjs";
import {
  checkGoldenVectors,
  GOLDEN_VECTORS,
  proofIsValid,
  json,
  StaleProofError,
} from "./protocol.mjs";
import { RpcUnavailableError } from "./rpc.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function checkGpu(gpu) {
  checkGoldenVectors();
  const device = await gpu.ready;
  for (const vector of GOLDEN_VECTORS) {
    if ((await gpu.hash(vector)) !== vector.hash)
      throw new Error("GPU golden vector mismatch");
  }
  return device;
}

export async function mine({
  rpc,
  address,
  submitter = null,
  seconds = 0,
  pollMs = 500,
  maxCats = 1,
  threads = 128,
  targetMs = 15,
  signal,
  onEvent = console.log,
  gpu = new Gpu(),
}) {
  let stopped = false,
    latest = null,
    error = null;
  let accountReadyAt = 0;
  const deadline = seconds ? Date.now() + seconds * 1000 : Infinity;
  const alive = () => !stopped && !signal?.aborted && Date.now() < deadline;
  const emit = (event) =>
    onEvent(json({ at: new Date().toISOString(), ...event }));
  let polling;
  try {
    emit({
      ...(await checkGpu(gpu)),
      type: "device",
      mode: submitter ? "LIVE" : "SHADOW (no transactions)",
    });
    await rpc.verify();
    const refresh = async () => {
      try {
        const snapshot = await rpc.snapshot(address);
        if (
          submitter &&
          Date.now() - accountReadyAt > 3000 &&
          !submitter.journal.pending().length
        ) {
          const account = await rpc.account(address);
          submitter.assertFunds(snapshot, account);
          accountReadyAt = Date.now();
        }
        latest = snapshot;
        error = null;
      } catch (failure) {
        latest = null;
        if (error !== failure.message)
          emit({ type: "paused", reason: failure.message });
        error = failure.message;
      }
    };
    await refresh();
    polling = (async () => {
      while (alive()) {
        await sleep(pollMs);
        if (alive()) await refresh();
      }
    })();
    let prefix = randomNoncePrefix(),
      counter = 0n,
      batchSize = 65536;
    let hashes = 0,
      lastReport = Date.now(),
      intervalHashes = 0,
      minted = 0,
      armed = false;
    while (alive()) {
      if (submitter?.journal.pending().length) {
        const result = await submitter.reconcile();
        if (result.state === "minted") {
          minted++;
          emit(result);
          if (minted >= maxCats) break;
        } else if (result.state === "reverted") emit(result);
        else {
          await sleep(250);
          continue;
        }
        accountReadyAt = 0;
        await refresh();
      }
      const job = latest;
      if (!job || Date.now() - job.observedAt > 2500) {
        await sleep(100);
        continue;
      }
      if (!armed) {
        emit({
          type: "armed",
          address,
          mode: submitter ? "LIVE" : "SHADOW (no transactions)",
        });
        armed = true;
      }
      if (counter + BigInt(batchSize) >= COUNTER_LIMIT) {
        prefix = randomNoncePrefix();
        counter = 0n;
      }
      const startingCounter = counter;
      const batch = await gpu.batch(job, prefix, counter, batchSize, {
        threads,
      });
      counter += BigInt(batchSize);
      hashes += batchSize;
      intervalHashes += batchSize;
      for (const candidate of batch.candidates) {
        const nonce = prefix + BigInt(candidate.counter);
        if (
          BigInt(candidate.counter) < startingCounter ||
          BigInt(candidate.counter) >= counter
        )
          throw new Error("GPU returned nonce outside its assigned range");
        const checked = proofIsValid(job, nonce, candidate.hash);
        if (!checked.valid)
          throw new Error("GPU candidate failed exact target verification");
        const found = {
          ...job,
          nonce,
          hash: checked.hash,
          foundAt: Date.now(),
          id: randomUUID(),
        };
        emit({
          type: "found",
          nonce,
          hash: found.hash,
          anchorBlock: found.anchorBlock,
        });
        if (submitter) {
          try {
            emit({ type: "submission", ...(await submitter.submit(found)) });
          } catch (failure) {
            if (signal?.aborted) break;
            if (
              !(failure instanceof StaleProofError) &&
              !(failure instanceof RpcUnavailableError)
            ) {
              emit({ type: "submission_failed", reason: failure.message });
              throw failure;
            }
            emit({ type: "discarded", reason: failure.message });
            latest = null;
            await refresh();
          }
          break;
        }
      }
      // Bound each batch and avoid sudden queue growth on the display GPU.
      const desired = Math.floor(
        (batchSize * targetMs) / Math.max(batch.ms, 0.1),
      );
      batchSize =
        Math.max(
          4096,
          Math.min(
            1 << 24,
            Math.max(batchSize / 2, Math.min(batchSize * 2, desired)),
          ),
        ) & ~127;
      if (Date.now() - lastReport >= 1000) {
        emit({
          type: "progress",
          hashes,
          hashesPerSecond: (intervalHashes * 1000) / (Date.now() - lastReport),
          minted,
          totalMinted: job.totalMinted,
          epoch: job.epoch,
          priceWei: job.price,
          target: job.target,
          rpcMs: job.rpcMs,
          batchMs: batch.ms,
        });
        intervalHashes = 0;
        lastReport = Date.now();
      }
    }
    return {
      hashes,
      minted,
      pending: submitter?.journal.pending().map((item) => item.hash) ?? [],
    };
  } finally {
    stopped = true;
    gpu.close();
    if (polling) await polling;
  }
}
