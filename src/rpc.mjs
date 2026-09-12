import { ABI, CHAIN_ID, COLLECTION, DEFAULT_RPC } from "./protocol.mjs";
import { getAddress, toQuantity } from "ethers";

export class RpcUnavailableError extends Error {}

export async function selectRpcs(rpcs, onUnavailable = () => {}) {
  const results = await Promise.allSettled(rpcs.map((rpc) => rpc.verify()));
  const healthy = rpcs.filter((rpc, index) => {
    if (results[index].status === "fulfilled") return true;
    onUnavailable(index, results[index].reason);
    return false;
  });
  if (!healthy.length)
    throw new RpcUnavailableError(
      "No configured RPC passed chain and collection checks",
    );
  return healthy;
}

export class Rpc {
  constructor(
    url = DEFAULT_RPC,
    { timeoutMs = 5000, chainId = CHAIN_ID, collection = COLLECTION } = {},
  ) {
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.chainId = chainId;
    this.collection = getAddress(collection);
    this.id = 0;
  }

  async batch(calls) {
    if (this.singleRequests && calls.length > 1) {
      const results = [];
      for (let offset = 0; offset < calls.length; offset += 2) {
        const group = await Promise.all(
          calls
            .slice(offset, offset + 2)
            .map(async (call) => (await this.batch([call]))[0]),
        );
        results.push(...group);
      }
      return results;
    }
    const payload = calls.map(([method, params]) => ({
      jsonrpc: "2.0",
      id: ++this.id,
      method,
      params,
    }));
    const remaining = (this.retryAt ?? 0) - Date.now();
    if (remaining > 0) {
      const error = new RpcUnavailableError(
        "RPC cooling down after rate limiting",
      );
      error.retryAfterMs = remaining;
      throw error;
    }
    let response;
    try {
      response = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload.length === 1 ? payload[0] : payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new RpcUnavailableError("RPC connection failed or timed out");
    }
    if (!response.ok) {
      // Some public RPCs reject batched reads although individual requests work.
      // Never retry a possibly accepted transaction through this compatibility path.
      const readsOnly = payload.every((item) =>
        /^eth_(get\w+|call|estimateGas|chainId|blockNumber|gasPrice)$/.test(
          item.method,
        ),
      );
      if (
        payload.length > 1 &&
        readsOnly &&
        [400, 500].includes(response.status)
      ) {
        this.singleRequests = true;
        return this.batch(calls);
      }
      const error = new RpcUnavailableError(`RPC HTTP ${response.status}`);
      if (response.status === 429 || response.status === 503) {
        const advertised = response.headers.get("retry-after");
        const seconds = Number(advertised);
        const delay =
          advertised && !Number.isFinite(seconds)
            ? Date.parse(advertised) - Date.now()
            : seconds * 1000;
        this.retryAt =
          Date.now() + Math.max(5000, Number.isFinite(delay) ? delay : 0);
        error.retryAfterMs = this.retryAt - Date.now();
      }
      throw error;
    }
    let decoded;
    try {
      decoded = await response.json();
    } catch {
      throw new RpcUnavailableError("RPC returned invalid JSON");
    }
    const results = Array.isArray(decoded) ? decoded : [decoded];
    return payload.map((request) => {
      const result = results.find((item) => item.id === request.id);
      if (!result || result.error || result.result === undefined) {
        const unavailable =
          !result || [429, -32005].includes(result?.error?.code);
        const ErrorType = unavailable ? RpcUnavailableError : Error;
        const error = new ErrorType(
          `${request.method}: ${result?.error?.message ?? "missing RPC response"}`,
        );
        error.code = result?.error?.code;
        error.data = result?.error?.data;
        if (error.code === 429 || error.code === -32005) {
          this.retryAt = Date.now() + 5000;
          error.retryAfterMs = 5000;
        }
        throw error;
      }
      return result.result;
    });
  }

  async call(method, params = []) {
    return (await this.batch([[method, params]]))[0];
  }

  async verify() {
    const [chainId, code] = await this.batch([
      ["eth_chainId", []],
      ["eth_getCode", [this.collection, "latest"]],
    ]);
    if (BigInt(chainId) !== BigInt(this.chainId))
      throw new Error(`Wrong chain: ${chainId}`);
    if (code === "0x" || code === "0x0")
      throw new Error("Collection has no contract code");
  }

  async snapshot(miner) {
    miner = getAddress(miner);
    const startedAt = Date.now();
    const block = await this.call("eth_getBlockByNumber", ["latest", false]);
    if (!block?.hash) throw new Error("Latest block unavailable");
    const reads = [
      ["prevWork", []],
      ["currentAnchor", []],
      ["targetFor", [miner]],
      ["mintPrice", []],
      ["totalMinted", []],
      ["currentEpoch", []],
      ["ANCHOR_WINDOW", []],
    ];
    const results = await this.batch(
      reads.map(([name, args]) => [
        "eth_call",
        [
          { to: this.collection, data: ABI.encodeFunctionData(name, args) },
          block.number,
        ],
      ]),
    );
    const decoded = results.map((result, index) =>
      ABI.decodeFunctionResult(reads[index][0], result),
    );
    // Numeric block tags must still refer to the same block after the read set.
    if ((await this.anchorHash(BigInt(block.number))) !== block.hash)
      throw new RpcUnavailableError("Snapshot block reorged during reads");
    const [anchorBlock, anchor] = decoded[1];
    return {
      miner,
      blockNumber: BigInt(block.number),
      blockHash: block.hash,
      timestamp: Number(BigInt(block.timestamp)),
      prev: decoded[0][0],
      anchorBlock,
      anchor,
      target: decoded[2][0],
      price: decoded[3][0],
      totalMinted: decoded[4][0],
      epoch: decoded[5][0],
      anchorWindow: decoded[6][0],
      observedAt: startedAt,
      rpcMs: Date.now() - startedAt,
    };
  }

  async account(address) {
    const [balance, latest, pending, gasPrice] = await this.batch([
      ["eth_getBalance", [address, "latest"]],
      ["eth_getTransactionCount", [address, "latest"]],
      ["eth_getTransactionCount", [address, "pending"]],
      ["eth_gasPrice", []],
    ]);
    return {
      balance: BigInt(balance),
      latest: BigInt(latest),
      pending: BigInt(pending),
      gasPrice: BigInt(gasPrice),
    };
  }

  async anchorHash(blockNumber) {
    const block = await this.call("eth_getBlockByNumber", [
      toQuantity(blockNumber),
      false,
    ]);
    if (!block?.hash) throw new Error("Anchor block unavailable");
    return block.hash;
  }
}
