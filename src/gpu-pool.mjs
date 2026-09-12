import { Gpu, listGpus, COUNTER_LIMIT } from "./gpu.mjs";

export function selectDevices(available, selection = "all") {
  if (!available.length) throw new Error("No CUDA-visible GPUs found");
  if (selection === "all") return available;
  if (!/^(0|[1-9]\d*)(,(0|[1-9]\d*))*$/.test(selection))
    throw new Error("--gpus must be all or comma-separated device indices");
  const indices = selection.split(",").map(Number);
  if (new Set(indices).size !== indices.length)
    throw new Error("Duplicate GPU indices are not allowed");
  return indices.map((index) => {
    const device = available.find((item) => item.index === index);
    if (!device) throw new Error(`GPU ${index} is not CUDA-visible`);
    return device;
  });
}

/** Allocate exact contiguous ranges, with a hard per-worker limit. */
export function partitionWork(count, weights, capacity = 2 ** 26) {
  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    !weights.length ||
    !Number.isSafeInteger(capacity) ||
    capacity < 1 ||
    weights.some((weight) => !Number.isFinite(weight) || weight <= 0) ||
    count > capacity * weights.length
  )
    throw new Error("Invalid pool batch size or weights");
  const counts = weights.map(() => 0);
  let remaining = count;
  while (remaining) {
    const active = weights
      .map((weight, index) => ({ weight, index }))
      .filter((item) => counts[item.index] < capacity);
    const totalWeight = active.reduce((sum, item) => sum + item.weight, 0);
    const available = remaining;
    for (const { weight, index } of active) {
      const grant = Math.min(
        remaining,
        capacity - counts[index],
        Math.max(1, Math.floor((available * weight) / totalWeight)),
      );
      counts[index] += grant;
      remaining -= grant;
    }
  }
  return counts;
}

/** One worker per device; the host remains the only wallet/transaction owner. */
export class GpuPool {
  constructor({
    selection = "all",
    discover = listGpus,
    createWorker = (index) => new Gpu(index),
  } = {}) {
    this.workers = [];
    this.closed = false;
    this.ready = this.initialize(selection, discover, createWorker);
  }

  async initialize(selection, discover, createWorker) {
    try {
      const selected = selectDevices(await discover(), selection);
      if (this.closed) throw new Error("GPU pool closed during discovery");
      for (const device of selected) {
        const worker = createWorker(device.index);
        this.workers = [...this.workers, worker];
      }
      const devices = await Promise.all(
        this.workers.map((worker) => worker.ready),
      );
      if (this.closed) throw new Error("GPU pool closed during startup");
      this.weights = this.workers.map(() => 1);
      this.maxBatchSize = this.workers.length * (1 << 24);
      this.kernelPath = this.workers[0].kernelPath;
      this.kernelName = this.workers[0].kernelName;
      this.devices = devices;
      return { type: "ready", deviceCount: devices.length, devices };
    } catch (error) {
      this.close();
      throw error;
    }
  }

  async hash(vector) {
    await this.ready;
    if (this.closed) throw new Error("GPU pool is closed");
    try {
      const hashes = await Promise.all(
        this.workers.map((worker) => worker.hash(vector)),
      );
      if (hashes.some((hash) => hash !== hashes[0]))
        throw new Error("GPU devices disagree on golden hash");
      return hashes[0];
    } catch (error) {
      this.close();
      throw error;
    }
  }

  async batch(job, prefix, counter, count, options = {}) {
    await this.ready;
    if (this.closed) throw new Error("GPU pool is closed");
    if (this.busy) throw new Error("GPU pool batch already running");
    if (
      !Number.isSafeInteger(count) ||
      count < 1 ||
      count > this.maxBatchSize ||
      counter < 0n ||
      counter + BigInt(count) > COUNTER_LIMIT
    )
      throw new Error("Invalid GPU nonce range");
    const counts = partitionWork(
      count,
      options.diagnostic ? this.weights.map(() => 1) : this.weights,
      options.diagnostic ? 8192 : 2 ** 26,
    );
    let next = counter;
    const assignments = counts
      .map((size, index) => {
        const start = next;
        next += BigInt(size);
        return { size, start, index, worker: this.workers[index] };
      })
      .filter((item) => item.size > 0);
    this.busy = true;
    try {
      const results = await Promise.all(
        assignments.map(async ({ worker, size, start, index }) => {
          const result = await worker.batch(job, prefix, start, size, options);
          if (
            result.count !== size ||
            !Number.isFinite(result.ms) ||
            result.ms <= 0
          )
            throw new Error(
              `GPU ${worker.deviceIndex} returned invalid batch accounting`,
            );
          if (options.diagnostic && result.digests?.length !== size)
            throw new Error(
              `GPU ${worker.deviceIndex} returned incomplete digests`,
            );
          for (const candidate of result.candidates ?? []) {
            if (
              BigInt(candidate.counter) < start ||
              BigInt(candidate.counter) >= start + BigInt(size)
            )
              throw new Error(
                `GPU ${worker.deviceIndex} returned a nonce outside its assigned range`,
              );
          }
          return { ...result, index, deviceIndex: worker.deviceIndex };
        }),
      );
      if (this.closed) throw new Error("GPU pool closed during batch");
      this.weights = this.weights.map((weight, index) => {
        const result = results.find((item) => item.index === index);
        return result ? result.count / result.ms : weight;
      });
      return {
        count,
        ms: Math.max(...results.map((result) => result.ms)),
        candidates: results.flatMap((result) =>
          (result.candidates ?? []).map((candidate) => ({
            ...candidate,
            deviceIndex: result.deviceIndex,
          })),
        ),
        ...(options.diagnostic
          ? { digests: results.flatMap((result) => result.digests) }
          : {}),
        devices: results.map((result) => ({
          deviceIndex: result.deviceIndex,
          count: result.count,
          ms: result.ms,
        })),
      };
    } catch (error) {
      this.close();
      throw error;
    } finally {
      this.busy = false;
    }
  }

  close() {
    this.closed = true;
    for (const worker of this.workers) {
      worker.ready.catch(() => {});
      worker.close();
    }
  }
}
