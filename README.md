# Hashcats Native

**Mine Hashcats from your terminal. No browser. No WebGPU. One GPU or a multi-GPU machine.**

> **Current hardware support: NVIDIA CUDA GPUs only.** AMD, Intel and Apple GPUs are not supported in this release.

Hashcats Native is an independent CUDA + Node.js command-line miner for [Hashcats](https://hashcats.fun/) on Robinhood Chain. Its purpose is to take proof-of-work search out of a browser tab and make it usable on a personal NVIDIA GPU, a multi-GPU workstation, or a compatible headless Linux GPU server managed over SSH. The same controller searches, verifies proofs and supports unattended local signing after one password prompt at startup.

- **Browser-independent:** no Chrome, browser extension, WebGPU, graphical desktop or open mining tab is required by the miner.
- **Multi-GPU by default:** all CUDA-visible NVIDIA GPUs on one host contribute distinct work to the same mining account.
- **Headless operation:** run from a local terminal or an SSH session on compatible rented GPU hardware.
- **Measured throughput:** benchmark without a wallet or chain connection; report aggregate and per-device rates.
- **One submission controller:** CPU verification, explicit spending limits and a durable transaction journal accompany local signing.

This is not a mining pool, network-distributed scheduler, or official Hashcats client. It does not bypass proof requirements or the NFT mint payment.

**Experimental—not a guaranteed win, profit, or demonstrated speedup over WebGPU.** On the tested RTX 3070 Ti, native measured **1.192 GH/s median across 3×30 s (128 threads)** and **1.167 GH/s median (256 threads)**, below the user's reported **1.25–1.30 GH/s** browser baseline. Removing the browser enables a different deployment and submission workflow; it does not automatically make the same GPU faster. Current tuning and verification results are recorded in [IMPLEMENTATION.md](IMPLEMENTATION.md).

Implemented: chain snapshots, full-target CUDA search, independent CPU checks, encrypted account import, spending limits, gas estimation, signing, parallel identical-byte broadcasting, receipt tracking and a durable transaction journal. No real wallet has been imported or paid mainnet mint submitted during development.

## 1. Build and check

### Is cloning and `npm install` enough?

**No. The source is included, but NVIDIA drivers and the CUDA toolchain are external prerequisites.** `npm install` (or `npm i`) installs JavaScript dependencies; it does not install a driver, enable GPU passthrough, install the NVRTC runtime, or compile the miner. Use `npm ci --ignore-scripts` for the lockfile-pinned install, then explicitly build.

This checkout is intended to run from source, not via `npm install hashcats-native`. The package's `private: true` setting prevents accidental npm publication; it does not prevent cloning the repository and installing its dependencies.

| Dependency | How it is supplied |
| --- | --- |
| Node.js 22+ and npm | Install on the host; development checks used Node 24 |
| JavaScript libraries | `npm ci --ignore-scripts` from the committed lockfile; includes development/test dependencies |
| NVIDIA GPU and compatible driver | Supplied/configured by the host or cloud provider; not installed by npm |
| Linux x86-64 userspace and g++ with C++17 | Supplied by the OS/image; WSL2 is the locally tested environment |
| CUDA 13.1 NVRTC runtime, built-ins and development headers | Supplied by the CUDA installation; `nvcc` is not required |
| Native worker executable | Built locally with `npm run build`; not shipped as a prebuilt binary |

A GPU-capable driver alone is not a CUDA toolkit installation. An image with only runtime libraries may also lack the headers/compiler needed to build. The selected GPU architecture must be supported by the installed NVRTC compiler. CUDA 13.1 is the tested toolchain, not a claim that every historical NVIDIA GPU works.

After cloning this repository, enter its checkout directory and run:

```bash
node --version
nvidia-smi
npm ci --ignore-scripts
npm run build
npm start -- devices
npm test
npm run test:gpu
npm run doctor
npm run benchmark -- --seconds 30 --runs 3
```

`test:gpu` independently compares one million CUDA digests with the CPU reference by default; it can take several minutes. `doctor` also checks the configured chain RPCs; `devices`, `test:gpu` and `benchmark` do not need a funded wallet or broadcast transactions.

If headers are missing, the build can download CUDA 13.1 development packages into ignored `.cuda/` files **only when `apt-get`, `dpkg-deb` and the matching NVIDIA apt repository are already available**. This does not bootstrap the driver or NVRTC runtime. Preinstalled matching development headers avoid that fallback. Rebuilds reuse cached headers.

The build detects common WSL and Linux driver-library paths. `HASHCATS_CUDA_ROOT` and `HASHCATS_CUDA_DRIVER` override the runtime root and `libcuda.so.1` path. Automatic header downloading is specifically for CUDA 13.1. Other toolchain/platform combinations have not been tested.

Close other GPU miners before benchmarking. `wallMHs` includes host/batch overhead and CPU sample verification; divide it by 1,000 for GH/s. `kernelMHs` excludes some host overhead and is **not** the headline speed. A benchmark uses fixed public inputs, no wallet and no RPC.

### Multiple GPUs in one PC

**All CUDA-visible NVIDIA GPUs are used by default** by `mine`, `benchmark` and `doctor`. Rebuild the worker after updating this checkout. No network cluster, separate wallets, SLI or NVLink is needed.

```bash
npm start -- devices
npm run benchmark -- --seconds 30 --runs 3
npm run benchmark -- --gpus 0,1 --seconds 30 --runs 3
npm start -- mine --gpus 0,1 --seconds 30
```

The last command is shadow mining, not a paid mint. Omit `--gpus` to use all devices; use `--gpus 0` for only the first. The same option applies to explicit live mining below. Missing or duplicate indices are rejected. These are **CUDA-visible indices**, not necessarily `nvidia-smi` indices: `CUDA_VISIBLE_DEVICES` can hide/reorder cards. Run `devices` with the same environment you will use for mining. Benchmark telemetry identifies physical cards by UUID.

Each GPU has a separate native worker. One controller allocates non-overlapping nonce ranges, dispatches them concurrently and adjusts work shares using measured per-device rates. Every selected GPU checks the startup golden vectors; each search batch has a CPU-checked sample per active GPU. Returned candidates are CPU-verified before submission. All GPUs share **one wallet, one transaction nonce manager, one spending budget and one journal**. Simultaneous candidates do not trigger parallel purchases.

`progress.hashesPerSecond` is the aggregate rate, not the rate of each card. Its `devices` array contains each device's last-batch count and time. Benchmark reports additionally contain per-device hashes and wall-clock MH/s; those rates sum to the aggregate.

Scheduling uses bounded parallel batches, waiting for all assigned devices before processing results. It adapts shares for different card speeds, but a slow/stalled worker can delay the batch; a worker error stops the entire pool. This is not an independent continuous queue per GPU. More cards should increase search throughput, but linear scaling and a particular combined GH/s are **not measured or guaranteed**. AMD/Intel GPUs and native Windows builds are not supported by this CUDA/Linux build path.

Validation here uses three simulated GPU workers plus the one physical RTX 3070 Ti available locally. A real two-or-more-card benchmark remains necessary on your multi-GPU PC. `npm run test:gpu` distributes the total digest-comparison count across visible GPUs; to check one specific card, run `HASHCATS_GPUS=1 npm run test:gpu` (using a listed index).

### Remote and rented GPU servers

The intended deployment model is **one compatible Linux GPU host, reached over SSH**. That can be your own server or an instance obtained through services such as [Vast.ai](https://docs.vast.ai/guides/instances/connect/ssh), [Shadeform](https://docs.shadeform.ai/getting-started/introduction), or [Lambda](https://docs.lambda.ai/public-cloud/). These links describe provider access/services, not tested integrations or endorsements. **No deployment on these providers has been validated for this repository.** It will not run on literally any server: the prerequisites above and actual CUDA device access are required.

Before paying for an instance, confirm that the provider permits this workload and that its selected image offers a long-running shell, NVIDIA GPU access, a compatible driver/toolkit, and persistent storage. Serverless inference endpoints are not interchangeable with an SSH-accessible GPU machine. No provider API, paid service, container image or one-click installer is bundled here.

1. Provision the compatible host yourself and connect over SSH. For a container, ensure the host exposes the GPU devices and NVIDIA driver libraries to it.
2. Clone, install, build and run the checks above. Benchmark **before importing or funding a wallet**. Test each GPU separately if comparing models, then test the combined configuration.
3. Use a terminal multiplexer such as `tmux` if you want a session to survive an SSH disconnect. If installed, `tmux new -s hashcats` starts one; detach with `Ctrl+B`, then `D`, and return with `tmux attach -t hashcats`. This does not survive the host being terminated or rebooted.
4. Complete wallet setup and a shadow rehearsal below. Paid mining still requires explicitly chosen limits. A remote host's operator can potentially access a running signer: use a dedicated, limited-funds account, not your main wallet.
5. Keep the encrypted keystore and transaction journal on persistent storage and back them up before terminating a rental. Restarting requires unlocking again. Never run multiple controllers on different hosts using the same signing account; network-wide transaction coordination is not implemented.

### What GPU capability matters?

**Optimize for sustained, verified Keccak-256 integer/bitwise throughput—not VRAM capacity or advertised AI TFLOPS.** This miner uses GPU compute; saying it does not need compute would be incorrect. It uses CUDA directly, not throughput routed through WebGPU.

The [search kernel](native/keccak.cu) repeatedly executes XOR, AND, NOT, rotations and integer operations over a small Keccak state. It does not load an AI model or a large mining DAG, and it does not use tensor cores or floating-point math. There is GPU memory overhead for the CUDA context/compiler and buffers, so “zero VRAM needed” would also be wrong. Extra VRAM capacity by itself does not increase this kernel's hashes per second.

Useful factors are the GPU's integer/bitwise execution behavior, sustained clocks, register pressure, compiler-generated instructions and ability to keep useful work running concurrently. Registers, occupancy and spilling interact; neither maximum occupancy nor the lowest register count guarantees the best result. NVIDIA discusses those tradeoffs in its [CUDA Best Practices Guide](https://docs.nvidia.com/cuda/cuda-c-best-practices-guide/). This is why CUDA-core counts, FP32/FP16 TFLOPS and memory bandwidth alone cannot predict this miner's performance across architectures.

Measure rather than assume:

```bash
npm run benchmark -- --gpus 0 --seconds 30 --runs 3 --warmup-seconds 5
npm run benchmark -- --seconds 30 --runs 3 --warmup-seconds 5
```

Use median **wall-clock GH/s**, with clocks, temperature and power stable. For rentals, compare that measured aggregate rate against the **whole instance's hourly cost**, not just the GPU's listing price. For owned hardware, compare GH/s per watt as well. These efficiency measures are not a profitability forecast: stale work, RPC latency, competition, mint price, gas and NFT/token value still matter. An expensive large-VRAM accelerator is not automatically the best-value miner, and this repository has no validated GPU rental ranking.

## 2. Set up a signing wallet

You do **not** need MetaMask, WalletConnect, an open browser or per-mint phone approval. The controller uses an account's signing key on the machine running it. Keep recovery phrases out of chat, command-line arguments, logs and this repository.

To import an existing compatible mnemonic-based wallet—for example, a dedicated Robinhood Wallet account on an iPhone—copy its full public EVM address and run this yourself in an interactive terminal, replacing the placeholder:

```bash
npm run wallet -- import --address 0xYOUR_FULL_WALLET_ADDRESS
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

## Support and contact

If this project helps you and you would like to support its continued development, donations are welcome at:

**Robinhood Chain (chain ID 4663), native ETH:** [`0xDB4d4abb19AAe5Be15f30ee75c2a2ba047bAB78D`](https://robinhoodchain.blockscout.com/address/0xDB4d4abb19AAe5Be15f30ee75c2a2ba047bAB78D)

Verify the full address and network before sending. Cryptocurrency transfers are irreversible. Do not send assets on a network you cannot recover from.

For setup questions, bug reports, performance results or further help, open a GitHub issue in this repository or contact **Ahmed Hamza** at [ahmed@hamza.my.id](mailto:ahmed@hamza.my.id). Never include a recovery phrase, private key, keystore password or other secret in an issue or email.

## License

Hashcats Native is available under the [MIT License](LICENSE).
