import { parseArgs } from "node:util";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  Wallet,
  getAddress,
  parseEther,
  formatEther,
  ZeroAddress,
} from "ethers";
import {
  CHAIN_ID,
  COLLECTION,
  DEFAULT_RPC,
  FALLBACK_RPC,
  json,
  checkGoldenVectors,
} from "./protocol.mjs";
import { Rpc, selectRpcs } from "./rpc.mjs";
import {
  walletAddress,
  unlockWallet,
  importMnemonic,
  secretPrompt,
  ask,
  saveWallet,
  checkSigner,
} from "./wallet.mjs";
import { Journal } from "./journal.mjs";
import { Submitter } from "./submitter.mjs";
import { Gpu, randomNoncePrefix } from "./gpu.mjs";
import { checkGpu, mine } from "./miner.mjs";

const HELP = `Hashcats Native — CUDA mining with local signing

  npm start -- doctor
  npm run wallet -- import --address 0xYOUR_IPHONE_ADDRESS
  npm run wallet -- create
  npm run wallet -- address
  npm run wallet -- check
  npm start -- status [--address 0x...]
  npm start -- watch [--address 0x...] [--seconds 30]
  npm run benchmark -- --seconds 10 [--threads 128]
  npm start -- mine --address 0x... --seconds 30          (shadow; never sends)
  npm start -- mine --live --max-price 0.09 --budget 0.10 (ETH; unlocks once)
  npm start -- recover --max-price 0.09 --budget 0.10 [--live]

Options:
  --keystore PATH      Default: ~/.local/share/hashcats/wallet.json
  --journal PATH       Default: data directory / wallet-address.journal.jsonl
  --rpc URL            Repeat at most twice; defaults: official RPC and dRPC
  --max-gas-eth ETH    Maximum transaction gas cost; default 0.001
  --max-cats N         Stop after N successful mints; default 1
  --seconds N          Stop searching after N seconds; 0 means unlimited
  --poll-ms N          Chain polling interval; default 500
  --threads 128|256    CUDA thread-block size; default 128
  --batch-ms N         Adaptive batch target, 1–50 ms; default 15
  --derivation-path P  Import only; default m/44'/60'/0'/0/0
  --mnemonic-passphrase  Ask for the original optional mnemonic passphrase

Wallet import/create prompts locally for secrets. No secret command-line flags.
Budget is a cumulative spending ceiling for this wallet's journal, including gas.
Ctrl+C stops searching; already-broadcast transactions remain tracked in the journal.
`;

function numberOption(value, fallback, min, max, name) {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max)
    throw new Error(`Invalid ${name}`);
  return result;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      live: { type: "boolean" },
      address: { type: "string" },
      keystore: { type: "string" },
      journal: { type: "string" },
      rpc: { type: "string", multiple: true },
      seconds: { type: "string" },
      threads: { type: "string" },
      "max-price": { type: "string" },
      budget: { type: "string" },
      "max-gas-eth": { type: "string" },
      "max-cats": { type: "string" },
      "poll-ms": { type: "string" },
      "batch-ms": { type: "string" },
      "derivation-path": { type: "string" },
      "mnemonic-passphrase": { type: "boolean" },
    },
  });
  const command = positionals[0] ?? "help";
  if (values.help || command === "help") return console.log(HELP);
  const dataDir = join(homedir(), ".local/share/hashcats");
  const keystore = resolve(values.keystore ?? join(dataDir, "wallet.json"));
  const rpcs = (values.rpc ?? [DEFAULT_RPC, FALLBACK_RPC]).map(
    (url) => new Rpc(url),
  );
  if (rpcs.length > 2)
    throw new Error("At most two RPC endpoints are supported");
  const connect = () =>
    selectRpcs(rpcs, (index, error) =>
      console.error(`RPC ${index + 1} unavailable: ${error.message}`),
    );
  const seconds = numberOption(values.seconds, 0, 0, 86400 * 30, "seconds");
  const threads = numberOption(values.threads, 128, 128, 256, "threads");
  if (![128, 256].includes(threads))
    throw new Error("Threads must be 128 or 256");
  checkGoldenVectors();

  if (command === "doctor") {
    console.log(`Node ${process.version}; CPU golden vectors: PASS`);
    console.log(
      `Keystore: ${existsSync(keystore) ? "present" : "not configured"}`,
    );
    const smi = spawnSync(
      "/usr/lib/wsl/lib/nvidia-smi",
      [
        "--query-gpu=name,temperature.gpu,utilization.gpu,power.draw",
        "--format=csv,noheader",
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    if (smi.status === 0) console.log(smi.stdout.trim());
    const gpu = new Gpu();
    try {
      console.log(json({ gpu: await checkGpu(gpu) }));
    } finally {
      gpu.close();
    }
    const healthy = await connect();
    console.log(
      `RPC: chain ${CHAIN_ID}; collection code present; ${healthy.length} endpoint(s) ready`,
    );
    return;
  }

  if (command === "wallet") {
    const action = positionals[1];
    if (action === "address") return console.log(await walletAddress(keystore));
    if (action === "check") {
      const wallet = await unlockWallet(
        keystore,
        await secretPrompt("Keystore password: "),
      );
      await checkSigner(wallet);
      return console.log(
        `PASS: ${wallet.address} signs and recovers correctly (offline; nothing broadcast)`,
      );
    }
    if (!["import", "create"].includes(action))
      throw new Error("Use wallet import, create, address, or check");
    if (existsSync(keystore))
      throw new Error(
        `Keystore already exists: ${keystore}; choose another --keystore path`,
      );
    let wallet;
    if (action === "import") {
      const expected = getAddress(
        values.address ??
          (await ask("Public address shown on your iPhone: ")).trim(),
      );
      const phrase = await secretPrompt("Recovery phrase (hidden): ");
      const passphrase = values["mnemonic-passphrase"]
        ? await secretPrompt("Original mnemonic passphrase (hidden): ")
        : "";
      wallet = importMnemonic(
        phrase,
        expected,
        values["derivation-path"],
        passphrase,
      );
    } else wallet = new Wallet(Wallet.createRandom().privateKey);
    const password = await secretPrompt("Choose a keystore password: ");
    if (password !== (await secretPrompt("Repeat keystore password: ")))
      throw new Error("Passwords do not match");
    await checkSigner(wallet);
    await saveWallet(wallet, keystore, password);
    console.log(
      `Wallet ready: ${wallet.address}\nKeystore: ${keystore}\nBack up this encrypted file and its password. Offline signer check passed.`,
    );
    return;
  }

  if (command === "benchmark") {
    const gpu = new Gpu();
    try {
      console.log(json({ gpu: await checkGpu(gpu) }));
      const job = {
        miner: ZeroAddress,
        prev: 0n,
        anchor: `0x${"00".repeat(32)}`,
        target: 0n,
      };
      const prefix = randomNoncePrefix();
      let counter = 0n,
        count = 65536,
        hashes = 0,
        kernelMs = 0;
      const start = Date.now(),
        duration = (seconds || 10) * 1000;
      while (Date.now() - start < duration) {
        const result = await gpu.batch(job, prefix, counter, count, {
          threads,
        });
        counter += BigInt(count);
        hashes += count;
        kernelMs += result.ms;
        count =
          Math.max(
            4096,
            Math.min(
              1 << 24,
              Math.round((count * 15) / Math.max(result.ms, 0.1)),
            ),
          ) & ~127;
      }
      console.log(
        json({
          hashes,
          seconds: (Date.now() - start) / 1000,
          wallMHs: hashes / (Date.now() - start) / 1000,
          kernelMHs: hashes / kernelMs / 1000,
          threads,
        }),
      );
    } finally {
      gpu.close();
    }
    return;
  }

  if (!["status", "watch", "mine", "recover"].includes(command))
    throw new Error(`Unknown command: ${command}`);
  const address = getAddress(values.address ?? (await walletAddress(keystore)));
  const [rpc, ...fallbacks] = await connect();
  if (command === "status" || command === "watch") {
    const deadline = seconds ? Date.now() + seconds * 1000 : Infinity;
    do {
      const [state, account] = await Promise.all([
        rpc.snapshot(address),
        rpc.account(address),
      ]);
      console.log(
        json({
          ...state,
          balanceETH: formatEther(account.balance),
          priceETH: formatEther(state.price),
          approximateBits: 256 - Math.log2(Number(state.target)),
          pendingNonce: account.pending,
        }),
      );
      if (command === "status") return;
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          numberOption(values["poll-ms"], 1000, 100, 10000, "poll-ms"),
        ),
      );
    } while (Date.now() < deadline);
    return;
  }
  if (command === "mine" && !values.live) {
    return console.log(
      json(
        await mine({
          rpc,
          address,
          seconds,
          threads,
          pollMs: numberOption(values["poll-ms"], 500, 100, 10000, "poll-ms"),
          targetMs: numberOption(values["batch-ms"], 15, 1, 50, "batch-ms"),
          signal: shutdownSignal(),
        }),
      ),
    );
  }
  if (!values["max-price"] || !values.budget)
    throw new Error("Provide --max-price and --budget in ETH");
  // Recovery needs only the public account and existing signed bytes, not the private key.
  const wallet =
    command === "recover"
      ? { address }
      : await unlockWallet(keystore, await secretPrompt("Keystore password: "));
  if (wallet.address !== address)
    throw new Error("Unlocked wallet differs from mining address");
  const journal = new Journal(
    resolve(
      values.journal ?? join(dataDir, `${address.toLowerCase()}.journal.jsonl`),
    ),
    { address, chainId: CHAIN_ID, collection: COLLECTION },
  );
  const signal = shutdownSignal();
  try {
    const submitter = new Submitter({
      rpc,
      fallbacks,
      wallet,
      journal,
      signal,
      maxPrice: parseEther(values["max-price"]),
      budget: parseEther(values.budget),
      maxGasCost: parseEther(values["max-gas-eth"] ?? "0.001"),
    });
    if (command === "recover") {
      await submitter.auditReceipts();
      console.log(
        json(await submitter.reconcile({ rebroadcast: Boolean(values.live) })),
      );
      if (journal.pending().length)
        console.log(
          json(
            await submitter.wait({ timeoutMs: (seconds || 30) * 1000, signal }),
          ),
        );
      return;
    }
    const ready = await submitter.ready();
    let maxCats = numberOption(values["max-cats"], 1, 1, 10000, "max-cats");
    if (ready.pending) {
      let result = await submitter.reconcile({ rebroadcast: true });
      console.log(json(result));
      if (journal.pending().length) {
        result = await submitter.wait({ signal });
        console.log(json(result));
      }
      if (journal.pending().length)
        throw new Error(
          "Previous transaction unresolved; use recover before mining",
        );
      if (result.state === "minted" && --maxCats === 0) return;
    }
    console.log(
      `CONFIGURED: ${address}; max price ${values["max-price"]} ETH; journal budget ${values.budget} ETH`,
    );
    console.log(
      json(
        await mine({
          rpc,
          address,
          submitter,
          seconds,
          threads,
          maxCats,
          pollMs: numberOption(values["poll-ms"], 500, 100, 10000, "poll-ms"),
          targetMs: numberOption(values["batch-ms"], 15, 1, 50, "batch-ms"),
          signal,
        }),
      ),
    );
  } finally {
    journal.close();
  }
}

function shutdownSignal() {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return controller.signal;
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
