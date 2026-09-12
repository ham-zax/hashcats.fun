import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { ZeroAddress } from "ethers";
import { GpuPool } from "./gpu-pool.mjs";
import { checkGpu } from "./miner.mjs";
import { Distribution, now, percentile } from "./metrics.mjs";

const execute = promisify(execFile);
const GPU_FIELDS =
  "index,name,temperature.gpu,utilization.gpu,power.draw,clocks.sm,clocks.mem";

export function parseGpuSample(csv) {
  const fields = csv
    .trim()
    .split(/\r?\n/)[0]
    .split(",")
    .map((value) => value.trim());
  if (fields.length !== 7) throw new Error("Unexpected nvidia-smi response");
  const numeric = (index) =>
    fields[index] === "" || !Number.isFinite(Number(fields[index]))
      ? null
      : Number(fields[index]);
  return {
    deviceIndex: numeric(0),
    name: fields[1],
    temperatureC: numeric(2),
    utilizationPercent: numeric(3),
    powerW: numeric(4),
    smClockMHz: numeric(5),
    memoryClockMHz: numeric(6),
  };
}

export async function readGpuSample(device = {}) {
  try {
    const smi =
      process.env.HASHCATS_NVIDIA_SMI ??
      (process.platform === "linux" && process.env.WSL_DISTRO_NAME
        ? "/usr/lib/wsl/lib/nvidia-smi"
        : "nvidia-smi");
    // UUIDs stay associated with physical devices when CUDA_VISIBLE_DEVICES reorders ordinals.
    const { stdout } = await execute(
      smi,
      [
        `--id=${device.uuid ?? device.deviceIndex ?? 0}`,
        `--query-gpu=${GPU_FIELDS}`,
        "--format=csv,noheader,nounits",
      ],
      { timeout: 2000 },
    );
    const parsed = parseGpuSample(stdout);
    return {
      available: true,
      ...parsed,
      smiIndex: parsed.deviceIndex,
      deviceIndex: device.deviceIndex ?? parsed.deviceIndex,
      uuid: device.uuid,
    };
  } catch {
    return {
      available: false,
      deviceIndex: device.deviceIndex,
      uuid: device.uuid,
      reason: "GPU telemetry unavailable",
    };
  }
}

async function searchPeriod(
  gpu,
  job,
  state,
  durationMs,
  threads,
  targetMs,
  signal,
) {
  const started = now(),
    batchWallMs = new Distribution(),
    kernelMs = new Distribution();
  const perDevice = new Map();
  let hashes = 0;
  while (now() - started < durationMs && !signal?.aborted) {
    const batchStarted = now();
    const result = await gpu.batch(job, 0n, state.counter, state.count, {
      threads,
    });
    batchWallMs.record(now() - batchStarted);
    kernelMs.record(result.ms);
    for (const device of result.devices ?? []) {
      const previous = perDevice.get(device.deviceIndex) ?? {
        deviceIndex: device.deviceIndex,
        hashes: 0,
        kernelMs: 0,
      };
      perDevice.set(device.deviceIndex, {
        deviceIndex: device.deviceIndex,
        hashes: previous.hashes + device.count,
        kernelMs: previous.kernelMs + device.ms,
      });
    }
    hashes += state.count;
    state.counter += BigInt(state.count);
    state.count =
      Math.floor(
        Math.max(
          4096,
          Math.min(
            gpu.maxBatchSize ?? 1 << 24,
            Math.round((state.count * targetMs) / Math.max(result.ms, 0.1)),
          ),
        ) / 128,
      ) * 128;
  }
  const elapsedMs = now() - started;
  return {
    hashes,
    seconds: elapsedMs / 1000,
    wallMHs: elapsedMs ? hashes / elapsedMs / 1000 : 0,
    kernelMHs: kernelMs.sum ? hashes / kernelMs.sum / 1000 : 0,
    batchWallMs: batchWallMs.summary(),
    kernelMs: kernelMs.summary(),
    devices: [...perDevice.values()].map((device) => ({
      ...device,
      wallMHs: device.hashes / elapsedMs / 1000,
    })),
    completed: !signal?.aborted,
  };
}

/** Fixed public inputs, sequential runs, no RPC or signer. */
export async function benchmark({
  seconds = 30,
  runs = 3,
  warmupSeconds = 5,
  threads = 128,
  targetMs = 15,
  reportPath,
  signal,
  onEvent = () => {},
  gpus = "all",
  gpu = new GpuPool({ selection: gpus }),
  sampleGpu = readGpuSample,
}) {
  const samples = [],
    results = [];
  const sampler = new AbortController();
  let phase = "startup",
    sampling;
  try {
    const device = await checkGpu(gpu);
    const kernelSha256 = gpu.kernelPath
      ? createHash("sha256")
          .update(await readFile(gpu.kernelPath))
          .digest("hex")
      : null;
    onEvent({ type: "benchmark_device", device, kernelSha256 });
    sampling = (async () => {
      while (!sampler.signal.aborted) {
        const sampledPhase = phase,
          requestedAt = new Date().toISOString();
        const readings = await Promise.all(
          (device.devices ?? [device]).map((item) => sampleGpu(item)),
        );
        for (const reading of readings) {
          const sample = { ...reading, at: requestedAt, phase: sampledPhase };
          samples.push(sample);
          onEvent({ type: "gpu_sample", ...sample });
        }
        try {
          await sleep(1000, undefined, { signal: sampler.signal });
        } catch {
          break;
        }
      }
    })();
    const job = {
      miner: ZeroAddress,
      prev: 0n,
      anchor: `0x${"00".repeat(32)}`,
      target: 0n,
    };
    const state = { counter: 0n, count: 65536 };
    phase = "warmup";
    await searchPeriod(
      gpu,
      job,
      state,
      warmupSeconds * 1000,
      threads,
      targetMs,
      signal,
    );
    for (let run = 1; run <= runs && !signal?.aborted; run++) {
      phase = `run-${run}`;
      const result = {
        run,
        ...(await searchPeriod(
          gpu,
          job,
          state,
          seconds * 1000,
          threads,
          targetMs,
          signal,
        )),
      };
      results.push(result);
      onEvent({ type: "benchmark_run", ...result });
    }
    sampler.abort();
    await sampling;
    const completed = results.filter((result) => result.completed);
    const report = {
      createdAt: new Date().toISOString(),
      node: process.version,
      device,
      kernelSha256,
      kernel: gpu.kernelName ?? "test",
      settings: {
        seconds,
        runs,
        warmupSeconds,
        threads,
        targetMs,
        gpus,
        unroll: process.env.HASHCATS_UNROLL ?? "24",
        registers: process.env.HASHCATS_REGISTERS ?? "80",
      },
      completed: completed.length === runs,
      medianWallMHs: percentile(
        completed.map((result) => result.wallMHs),
        0.5,
      ),
      results,
      samples,
    };
    if (reportPath) {
      await mkdir(dirname(reportPath), { recursive: true });
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
    }
    onEvent({
      type: "benchmark_summary",
      medianWallMHs: report.medianWallMHs,
      completed: report.completed,
      reportPath,
    });
    return report;
  } finally {
    sampler.abort();
    try {
      if (sampling) await sampling;
    } finally {
      gpu.close();
    }
  }
}
