import {
  mkdirSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  readFileSync,
  existsSync,
  copyFileSync,
  truncateSync,
  unlinkSync,
  rmdirSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { json } from "./protocol.mjs";

function syncDirectory(path) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export class Journal {
  constructor(path, identity) {
    this.path = path;
    this.lock = `${path}.lock`;
    this.closed = false;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // No stale-lock takeover: a second controller must never reuse a pending nonce.
    try {
      mkdirSync(this.lock, { mode: 0o700 });
    } catch (error) {
      if (error.code === "EEXIST")
        throw new Error(
          `Journal locked: ${this.lock}. Check owner.json; remove the lock only after its process has stopped.`,
        );
      throw error;
    }
    try {
      const owner = openSync(join(this.lock, "owner.json"), "wx", 0o600);
      try {
        writeSync(
          owner,
          json({ pid: process.pid, startedAt: new Date().toISOString() }),
        );
        fsyncSync(owner);
      } finally {
        closeSync(owner);
      }
      let interrupted;
      if (existsSync(path)) {
        const bytes = readFileSync(path);
        const complete = bytes.lastIndexOf(10) + 1;
        if (complete !== bytes.length) interrupted = { complete };
        this.records = bytes
          .subarray(0, complete)
          .toString("utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      } else this.records = [];
      if (
        this.records.length &&
        (this.records[0].type !== "identity" ||
          this.records[0].address !== identity.address ||
          this.records[0].chainId !== identity.chainId ||
          this.records[0].collection !== identity.collection)
      ) {
        throw new Error(
          "Journal belongs to another wallet, chain or collection",
        );
      }
      if (interrupted) {
        const backup = `${path}.interrupted-${Date.now()}`;
        copyFileSync(path, backup);
        truncateSync(path, interrupted.complete);
        process.stderr.write(
          `Recovered incomplete journal tail; original saved to ${backup}\n`,
        );
      }
      this.fd = openSync(path, "a", 0o600);
      if (!this.records.length) this.append({ type: "identity", ...identity });
      syncDirectory(dirname(path));
    } catch (error) {
      this.close();
      throw error;
    }
  }

  append(record) {
    const entry = { at: new Date().toISOString(), ...record };
    const bytes = Buffer.from(`${json(entry)}\n`);
    let offset = 0;
    while (offset < bytes.length)
      offset += writeSync(this.fd, bytes, offset, bytes.length - offset);
    fsyncSync(this.fd);
    this.records = [...this.records, JSON.parse(json(entry))];
  }

  pending() {
    const completed = new Set(
      this.records
        .filter((record) => record.type === "receipt")
        .map((record) => record.hash),
    );
    return this.records.filter(
      (record) => record.type === "signed" && !completed.has(record.hash),
    );
  }

  spent() {
    return this.records
      .filter((record) => record.type === "receipt")
      .reduce((total, record) => total + BigInt(record.cost), 0n);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.fd !== undefined) closeSync(this.fd);
    if (existsSync(join(this.lock, "owner.json")))
      unlinkSync(join(this.lock, "owner.json"));
    rmdirSync(this.lock);
  }
}
