import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { solidityPacked } from "ethers";
import { hex32, workHash, MAX_UINT256 } from "./protocol.mjs";

const executable = fileURLToPath(
  new URL("../build/hashcats-gpu", import.meta.url),
);
const kernel = fileURLToPath(new URL("../native/keccak.cu", import.meta.url));
export const COUNTER_LIMIT = 1n << 64n;
export const randomNoncePrefix = () =>
  BigInt(`0x${randomBytes(24).toString("hex")}`) << 64n;

export async function listGpus() {
  const { stdout } = await promisify(execFile)(executable, ["--list"], {
    timeout: 10000,
  });
  const devices = JSON.parse(stdout);
  if (
    !Array.isArray(devices) ||
    devices.some(
      (device) => !Number.isSafeInteger(device.index) || device.index < 0,
    )
  )
    throw new Error("Invalid CUDA device list; rebuild the worker");
  return devices;
}

export class Gpu {
  constructor(deviceIndex = 0) {
    if (!Number.isSafeInteger(deviceIndex) || deviceIndex < 0)
      throw new Error("Invalid GPU index");
    this.deviceIndex = deviceIndex;
    this.maxBatchSize = 1 << 24;
    this.kernelPath = kernel;
    this.kernelName = "64";
    this.sequence = 0;
    this.pending = new Map();
    this.process = spawn(executable, [kernel, String(deviceIndex)], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.startupTimer = setTimeout(() => {
      this.fail(new Error("GPU startup timed out"));
      this.close();
    }, 30000);
    this.lines = createInterface({ input: this.process.stdout });
    this.lines.on("line", (line) => {
      try {
        const message = JSON.parse(line);
        if (message.type === "ready") {
          clearTimeout(this.startupTimer);
          return this.readyResolve(message);
        }
        const operation = this.pending.get(message.id);
        if (operation) {
          clearTimeout(operation.timer);
          this.pending.delete(message.id);
          operation.resolve(message);
        }
      } catch {
        this.fail(new Error("Malformed GPU worker response"));
        this.close();
      }
    });
    this.process.on("error", (error) => this.fail(error));
    this.process.on("exit", (code, signal) =>
      this.fail(
        new Error(`GPU ${deviceIndex} worker exited (${signal ?? code})`),
      ),
    );
    this.process.stdin.on("error", (error) => this.fail(error));
  }

  fail(error) {
    clearTimeout(this.startupTimer);
    this.readyReject(error);
    this.error = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async request(operation, input, suffix = "") {
    await this.ready;
    if (this.closed) throw new Error(`GPU ${this.deviceIndex} is closed`);
    if (this.error) throw this.error;
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error("GPU batch timed out"));
        this.close();
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(
        `${operation} ${id} ${input.slice(2)} ${suffix}\n`,
      );
    });
  }

  async hash(vector) {
    return (
      await this.request(
        "HASH",
        solidityPacked(
          ["address", "uint256", "uint256", "bytes32"],
          [vector.miner, vector.nonce, vector.prev, vector.anchor],
        ),
      )
    ).hash;
  }

  async batch(
    job,
    prefix,
    counter,
    count,
    { diagnostic = false, threads = 128 } = {},
  ) {
    if (
      prefix < 0n ||
      prefix > MAX_UINT256 ||
      (prefix & (COUNTER_LIMIT - 1n)) !== 0n ||
      counter < 0n ||
      counter + BigInt(count) > COUNTER_LIMIT ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > 2 ** 26
    )
      throw new Error("Invalid GPU nonce range");
    const input = solidityPacked(
      ["address", "uint256", "uint256", "bytes32"],
      [job.miner, prefix, job.prev, job.anchor],
    );
    const result = await this.request(
      diagnostic ? "DIGEST" : "SEARCH",
      input,
      `${hex32(job.target).slice(2)} ${counter} ${count} ${threads}`,
    );
    if (!diagnostic) {
      if (
        result.sample !==
        workHash(job.miner, prefix + counter, job.prev, job.anchor)
      )
        throw new Error("GPU sample hash mismatch");
      if (result.overflow)
        throw new Error("GPU candidate buffer overflow; lower the batch size");
    }
    return result;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.startupTimer);
    this.process.stdin.end();
    this.process.kill("SIGTERM");
    this.lines.close();
  }
}
