# Hashcats Native

A working CUDA + Node.js command-line miner for Hashcats on Robinhood Chain. It searches on the RTX 3070 Ti without a browser and supports unattended local signing after one password prompt at startup.

**This is an experimental client, not a guaranteed win or a demonstrated speedup over WebGPU.** Native measured about **1.19 GH/s in a short run and 1.09 GH/s in the final 30-second run**, below Hamza's reported **1.25–1.30 GH/s** browser baseline. Current tuning and verification results are recorded in [IMPLEMENTATION.md](IMPLEMENTATION.md).

Implemented: chain snapshots, full-target CUDA search, independent CPU checks, encrypted account import, spending limits, gas estimation, signing, parallel identical-byte broadcasting, receipt tracking and a durable transaction journal. No real wallet has been imported or paid mainnet mint submitted during development.

## 1. Build and check

This checkout has already been built on Hamza's WSL machine. To reproduce:

```bash
cd /home/hamza/repo/hashcat
npm ci --ignore-scripts
npm run build
npm test
npm run test:gpu
npm run doctor
npm run benchmark -- --seconds 30
```

Requirements: Node.js 22+, g++, NVIDIA CUDA driver access, and the CUDA 13.1 NVRTC runtime. The build uses NVRTC at runtime, so `nvcc` is not required. On this machine, missing CUDA headers are downloaded from the configured NVIDIA apt repository into ignored `.cuda/` files, without sudo or system package installation. Rebuilds reuse them.

The defaults target the installed WSL paths. `HASHCATS_CUDA_ROOT` and `HASHCATS_CUDA_DRIVER` override the runtime root and `libcuda.so.1` path. Automatic header downloading is specifically for CUDA 13.1. Other toolchain/platform combinations have not been tested.

Close other GPU miners before benchmarking. `wallMHs` includes host/batch overhead and CPU sample verification; divide it by 1,000 for GH/s. `kernelMHs` excludes some host overhead and is **not** the headline speed. A benchmark uses fixed public inputs, no wallet and no RPC.

## 2. Connect your iPhone wallet locally

You do **not** need MetaMask, WalletConnect, an open browser or per-mint iPhone approval. The local process uses the same account's signing key. Keep the twelve-word recovery phrase out of chat, command-line arguments, logs and this repository.

Copy the new wallet's full public EVM address from Robinhood Wallet, then run this yourself in an interactive local terminal, replacing the placeholder:

```bash
npm run wallet -- import --address 0xYOUR_FULL_IPHONE_ADDRESS
```

The hidden prompts ask for the recovery phrase and a new keystore password. The importer requires the derived address to match the address you supplied. It saves only that account's encrypted key, not the recovery phrase. The default derivation path is `m/44'/60'/0'/0/0`; if it does not match, stop and resolve the account/path choice. Do not fund an unexpected address.

Then:

```bash
npm run wallet -- address
npm run wallet -- check
npm start -- status
```

`wallet check` unlocks and tests signing **offline**, without broadcasting. `status` checks the actual address, current mint price and native ETH balance on chain **4663**, collection `0xCA75DF55Cc9C476DB27a7375D1fc8E794cf80721`. ETH on another chain does not fund this miner.

Alternative: `npm run wallet -- create` creates a separate local encrypted account. It does not create an iPhone account or display a mnemonic. Back up the encrypted keystore and its password before funding it. The importer never overwrites an existing keystore; use `--keystore PATH` for a different file.

Default keystore: `~/.local/share/hashcats/wallet.json`, created with mode `0600`. The wallet must be unlocked again after a process/OS restart. Fully automatic reboot-time unlocking is not implemented.

## 3. Run a no-transaction rehearsal

After import, the address can be read from the keystore without decrypting it:

```bash
npm start -- mine --seconds 30
```

This is **SHADOW** mode. It searches the real live job but never signs or sends transactions, even if a qualifying proof appears. Without a keystore, supply your public address through `--address 0x...`.

Watch for `device`, `armed` and `progress` events. `paused` means state/funding readiness was lost; searching resumes once fresh valid state returns. Any snapshot older than 2.5 seconds is not used to start another batch. A displayed `found` proof is not yet an owned NFT.

## 4. Explicitly start paid mining

For example, **only if these are spending limits you intend to authorize**:

```bash
npm start -- mine --live --max-price 0.09 --budget 0.10 --max-cats 1
```

This unlocks once, checks the signer/account/journal and starts automatic submission. There is no phone confirmation when a proof appears. The defaults reserve up to `0.001 ETH` for gas. The example price and budget are limits, not current quotes or a recommended investment.

- `--max-price`: maximum NFT entry price in ETH.
- `--budget`: cumulative ceiling for recorded mint payments plus gas in this wallet's journal. It is **not reset by restarting**.
- `--max-gas-eth`: maximum gas allowance for one transaction, default `0.001`.
- `--max-cats`: stop after this many successful mints in the run, default `1`; recovery of a pending successful mint counts toward this limit.
- `--seconds`: stop searching after the specified duration; default `0` means unlimited.

Insufficient balance or an exhausted price/budget limit prevents searching in live mode. Do not use this account concurrently for phone transactions or another miner: the controller requires exclusive ownership of its transaction nonce. Limits count this journal's spending, not unrelated wallet activity.

Press Ctrl+C once for a graceful stop. A transaction already committed for broadcast cannot be cancelled by stopping the process. The final output lists unresolved transaction hashes, if any.

## Submission and recovery

The GPU proof nonce and wallet transaction nonce are different. The host CPU checks the proof, preserves the **original** anchor, reads fresh state, estimates gas, checks again, signs locally and fsyncs the signed bytes before broadcasting. The exact same bytes can be sent concurrently through two verified endpoints. A lost RPC response is treated as uncertain, never as permission to mint again.

Only one transaction may remain unresolved. A successful receipt must contain the collection's mint event to this wallet. The default confirmation count is two L2 blocks; this is **not L1 finality**. Recorded receipt block hashes are checked again when rearming after a restart.

```bash
npm start -- recover --max-price 0.09 --budget 0.10
```

Recovery without `--live` only checks receipts/status and does not send anything. It uses the public address and journal; it does not need the wallet password. To allow resending still-valid, previously signed identical bytes:

```bash
npm start -- recover --max-price 0.09 --budget 0.10 --live
```

Limits must also permit the recorded transaction. Recovery does not sign replacement transactions, change anchors or revive expired proofs. `stale_pending`, an unexplained consumed nonce, a receipt reorg or endpoint disagreement requires investigation; the client will not silently reuse the nonce. A candidate recorded before signing is evidence for diagnosis, not an automatically recovered pending transaction.

Default journal: `~/.local/share/hashcats/<lowercase-address>.journal.jsonl`. Keep it with the wallet. Do not delete/edit it to clear an error or reset spending limits. An incomplete final line is backed up before repair.

**After a hard crash:** the journal's `.lock` directory deliberately remains. Inspect its `owner.json` and confirm that PID/controller has stopped. Only then move that specific stale lock directory aside and run `recover`. Never remove a live controller's lock. Hard-crash lock takeover and automatic stuck-transaction replacement are intentionally not implemented; graceful Ctrl+C releases the lock normally.

## RPC and tuning

The default endpoints are `https://rpc.mainnet.chain.robinhood.com` and `https://robinhood.drpc.org`. At startup, each is checked for chain ID and collection bytecode; the first usable endpoint in configured order becomes the reader. Both healthy endpoints are used for identical-byte broadcast. Read failures during a run pause work rather than automatically switching readers.

Public RPCs were intermittently rate-limited or rejecting batches during development. The client backs off on throttling and falls back to individual reads when a server rejects read batching. It never applies that retry mechanism to transaction writes. Snapshot time and RPC latency affect useful mining and submission speed.

```bash
npm start -- status --rpc https://robinhood.drpc.org
npm run benchmark -- --seconds 30 --threads 256
npm start -- mine --seconds 30 --poll-ms 500 --batch-ms 15
```

Defaults: 128 threads/block, approximately 15 ms bounded batches, 500 ms delay between completed snapshot polls. Effective refresh time also includes RPC latency; this is not a 100 ms websocket watcher. Every search batch has a CPU-checked sample, and every returned candidate is rehashed independently. All 256 target bits are compared strictly; there is no skipped-round shortcut or trait/rarity filtering.

Developer tuning: `HASHCATS_UNROLL=1|2|4|8|24` and `HASHCATS_REGISTERS=64|72|80|96|128`. Run correctness tests again after changing kernel settings. A setting that improves a short benchmark can worsen sustained performance, display responsiveness or stale-work handling. No overclock, power-limit or driver change is made by this client.

## Limits and evidence

Finding a proof is a lottery, not accumulating partial progress. The screenshot's **42/49 bits** is not “seven bits left to finish.” A new cat or expired anchor can invalidate even a real qualifying proof before inclusion. The mint still costs ETH, and a reverted transaction can spend gas without delivering a cat.

See [prioritized next steps](NEXT-STEPS.md), [implementation and test evidence](IMPLEMENTATION.md), [protocol/mining plan](NATIVE-MINING-PLAN.md), [findings and source ledger](FINDINGS.md), and [wallet design](NATIVE-WALLET-WORKFLOW.md).
