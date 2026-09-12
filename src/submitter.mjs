import { randomUUID } from "node:crypto";
import {
  getAddress,
  keccak256,
  toQuantity,
  Transaction,
  ZeroAddress,
} from "ethers";
import {
  ABI,
  assertFresh,
  proofIsValid,
  StaleProofError,
} from "./protocol.mjs";
import { assertSigned, checkSigner } from "./wallet.mjs";

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function broadcastIdentical(rpcs, signed) {
  const hash = keccak256(signed);
  const sends = rpcs.map(async (rpc) => {
    try {
      const returned = await rpc.call("eth_sendRawTransaction", [signed]);
      if (returned.toLowerCase() !== hash.toLowerCase())
        throw new Error("RPC returned a different transaction hash");
      return hash;
    } catch (error) {
      if (/already known|known transaction/i.test(error.message)) return hash;
      throw error;
    }
  });
  // Promise.any installs handlers on every send; the slow endpoint never blocks success.
  try {
    await Promise.any(sends);
    return { hash, acknowledged: true };
  } catch {
    return { hash, acknowledged: false };
  }
}

export class Submitter {
  constructor({
    rpc,
    fallbacks = [],
    wallet,
    journal,
    maxPrice,
    budget,
    maxGasCost,
    confirmations = 2,
    anchorMargin = 30n,
    signal,
  }) {
    if (maxPrice <= 0n || budget <= 0n || maxGasCost <= 0n)
      throw new Error("Positive price, budget and gas ceilings are required");
    this.rpc = rpc;
    this.rpcs = [rpc, ...fallbacks].slice(0, 2);
    this.wallet = wallet;
    this.journal = journal;
    this.maxPrice = maxPrice;
    this.budget = budget;
    this.maxGasCost = maxGasCost;
    this.confirmations = confirmations;
    this.anchorMargin = anchorMargin;
    this.busy = false;
    this.signal = signal;
  }

  async ready() {
    await this.rpc.verify();
    await checkSigner(this.wallet, this.rpc.chainId, this.rpc.collection);
    await this.auditReceipts();
    const pending = this.journal.pending();
    if (pending.length > 1)
      throw new Error("More than one unresolved journal transaction");
    if (pending.length) return { pending: pending[0] };
    const [snapshot, account] = await Promise.all([
      this.rpc.snapshot(this.wallet.address),
      this.rpc.account(this.wallet.address),
    ]);
    this.assertFunds(snapshot, account);
    return { snapshot, account };
  }

  assertFunds(snapshot, account) {
    if (snapshot.price > this.maxPrice)
      throw new Error("Mint price exceeds configured ceiling");
    if (account.pending !== account.latest)
      throw new Error("Wallet has an untracked pending transaction");
    if (account.balance < snapshot.price + this.maxGasCost)
      throw new Error("Insufficient ETH for mint plus gas allowance");
    if (this.journal.spent() + snapshot.price + this.maxGasCost > this.budget)
      throw new Error("Journal spending budget exhausted");
  }

  async auditReceipts() {
    // Detect a reorg of previously recorded spending before allowing another mint.
    const receipts = this.journal.records.filter(
      (record) => record.type === "receipt",
    );
    for (const record of receipts) {
      const block = await this.rpc.call("eth_getBlockByNumber", [
        record.blockNumber,
        false,
      ]);
      if (block?.hash !== record.blockHash)
        throw new Error(
          `Recorded receipt reorged: ${record.hash}; reconcile journal before mining`,
        );
    }
  }

  async submit(candidate) {
    this.signal?.throwIfAborted();
    if (this.busy || this.journal.pending().length)
      throw new Error("A submission is already unresolved");
    this.busy = true;
    const id = randomUUID();
    try {
      if (getAddress(candidate.miner) !== this.wallet.address)
        throw new Error("Candidate belongs to another wallet");
      const checked = proofIsValid(candidate, candidate.nonce, candidate.hash);
      if (!checked.valid)
        throw new Error("Candidate does not meet its recorded target");
      candidate = { ...candidate, hash: checked.hash };
      this.journal.append({ type: "found", id, candidate });
      const [current, account, anchor] = await Promise.all([
        this.rpc.snapshot(this.wallet.address),
        this.rpc.account(this.wallet.address),
        this.rpc.anchorHash(candidate.anchorBlock),
      ]);
      assertFresh(candidate, current, { margin: this.anchorMargin });
      if (anchor !== candidate.anchor)
        throw new StaleProofError("Anchor hash changed (reorg)");
      this.assertFunds(current, account);
      if (account.pending > BigInt(Number.MAX_SAFE_INTEGER))
        throw new Error("Account nonce cannot be represented safely");
      const gasPrice = (account.gasPrice * 125n + 99n) / 100n;
      const data = ABI.encodeFunctionData("mine", [
        candidate.nonce,
        candidate.anchorBlock,
      ]);
      const estimate = BigInt(
        await this.rpc.call("eth_estimateGas", [
          {
            from: this.wallet.address,
            to: this.rpc.collection,
            data,
            value: toQuantity(current.price),
            gasPrice: toQuantity(gasPrice),
            nonce: toQuantity(account.pending),
          },
        ]),
      );
      const gasLimit = (estimate * 125n + 99n) / 100n;
      if (gasLimit > 1000000n || gasLimit * gasPrice > this.maxGasCost)
        throw new Error("Estimated gas exceeds configured ceiling");
      const fresh = await this.rpc.snapshot(this.wallet.address);
      assertFresh(candidate, fresh, { margin: this.anchorMargin });
      if (fresh.price !== current.price)
        throw new StaleProofError("Mint price changed during estimation");
      const request = {
        type: 0,
        chainId: this.rpc.chainId,
        to: this.rpc.collection,
        nonce: Number(account.pending),
        value: current.price,
        data,
        gasPrice,
        gasLimit,
      };
      this.signal?.throwIfAborted();
      const signed = await this.wallet.signTransaction(request);
      const transaction = assertSigned(signed, this.wallet.address, request);
      this.signal?.throwIfAborted();
      this.journal.append({
        type: "signed",
        id,
        candidate,
        raw: signed,
        hash: transaction.hash,
        nonce: request.nonce,
        value: request.value,
        gasPrice,
        gasLimit,
      });
      const result = await broadcastIdentical(this.rpcs, signed);
      this.journal.append({
        type: result.acknowledged ? "broadcast" : "broadcast_unknown",
        id,
        hash: result.hash,
      });
      return result;
    } catch (error) {
      // A signed record remains unresolved after any subsequent error, including journal failure.
      if (!this.journal.pending().some((record) => record.id === id)) {
        this.journal.append({ type: "rejected", id, reason: error.message });
      }
      throw error;
    } finally {
      this.busy = false;
    }
  }

  async reconcile({ rebroadcast = false } = {}) {
    const pending = this.journal.pending();
    if (!pending.length) return { state: "clear" };
    if (pending.length > 1)
      throw new Error("Multiple unresolved signed transactions");
    const record = pending[0];
    const transaction = Transaction.from(record.raw);
    if (
      transaction.hash !== record.hash ||
      transaction.from !== this.wallet.address ||
      transaction.chainId !== BigInt(this.rpc.chainId) ||
      transaction.to !== this.rpc.collection
    ) {
      throw new Error("Signed journal transaction identity mismatch");
    }
    const responses = await Promise.allSettled(
      this.rpcs.map((rpc) =>
        rpc.call("eth_getTransactionReceipt", [record.hash]),
      ),
    );
    const receipts = responses
      .filter((item) => item.status === "fulfilled" && item.value)
      .map((item) => item.value);
    if (
      receipts.length &&
      receipts.some(
        (receipt) =>
          receipt.blockHash !== receipts[0].blockHash ||
          receipt.status !== receipts[0].status,
      )
    ) {
      throw new Error("RPC endpoints disagree about transaction receipt");
    }
    const receipt = receipts[0];
    if (receipt) {
      const [block, head] = await this.rpc.batch([
        ["eth_getBlockByNumber", [receipt.blockNumber, false]],
        ["eth_blockNumber", []],
      ]);
      if (block?.hash !== receipt.blockHash)
        return { state: "reorg", hash: record.hash };
      if (
        BigInt(head) - BigInt(receipt.blockNumber) + 1n <
        BigInt(this.confirmations)
      )
        return { state: "confirming", hash: record.hash };
      const success = BigInt(receipt.status) === 1n;
      const mints = success
        ? receipt.logs
            .filter((log) => getAddress(log.address) === this.rpc.collection)
            .map((log) => {
              try {
                return ABI.parseLog(log);
              } catch {
                return null;
              }
            })
            .filter(
              (log) =>
                log?.name === "Transfer" &&
                log.args.from === ZeroAddress &&
                log.args.to === this.wallet.address,
            )
        : [];
      if (success && mints.length !== 1)
        throw new Error(
          "Successful receipt does not contain exactly one mint to our wallet",
        );
      const cost =
        BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice) +
        (success ? transaction.value : 0n);
      this.journal.append({
        type: "receipt",
        hash: record.hash,
        success,
        tokenId: mints[0]?.args.tokenId ?? null,
        cost,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
      });
      return {
        state: success ? "minted" : "reverted",
        hash: record.hash,
        tokenId: mints[0]?.args.tokenId ?? null,
        cost,
      };
    }
    const account = await this.rpc.account(this.wallet.address);
    if (account.latest > BigInt(transaction.nonce))
      throw new Error(
        "Account nonce was consumed but this transaction receipt is unknown",
      );
    if (rebroadcast) {
      const current = await this.rpc.snapshot(this.wallet.address);
      try {
        assertFresh(record.candidate, current, { margin: this.anchorMargin });
      } catch {
        return { state: "stale_pending", hash: record.hash };
      }
      if (
        transaction.value +
          transaction.gasLimit * transaction.gasPrice +
          this.journal.spent() >
          this.budget ||
        transaction.value > this.maxPrice ||
        transaction.gasLimit * transaction.gasPrice > this.maxGasCost
      ) {
        throw new Error("Recorded transaction exceeds current spending limits");
      }
      await broadcastIdentical(this.rpcs, record.raw);
    }
    return { state: "pending", hash: record.hash };
  }

  async wait({ timeoutMs = 30000, signal } = {}) {
    const deadline = Date.now() + timeoutMs;
    do {
      const result = await this.reconcile();
      if (["minted", "reverted", "clear"].includes(result.state)) return result;
      await sleep(250);
    } while (Date.now() < deadline && !signal?.aborted);
    return { state: "pending", hash: this.journal.pending()[0]?.hash };
  }
}
