# Hashcats mining findings

Observed 2026-09-12. Companion: [native mining plan for RTX 3070 Ti](NATIVE-MINING-PLAN.md).

## Result

The checked protocol uses a 116-byte packed Ethereum Keccak-256 preimage. Five reference inputs matched the deployed contract's hash function. A native CUDA client now implements this work. **Native end-to-end results of about 1.19 GH/s in a short run and 1.09 GH/s in the final 30-second run do not beat the user's 1.25–1.30 GH/s browser baseline.** See [implementation evidence](IMPLEMENTATION.md) for tests, live shadow observations and tuning updates, and [README.md](README.md) for use. The sections below preserve the earlier investigation's evidence and limits at that time.

The managed Windows browser successfully rendered the mining and documentation pages. Its WebGPU adapter was real NVIDIA Ampere hardware. The site has identifiable device and batching limits; none has yet been shown to constrain useful mining throughput.

## What was verified

| Finding | Evidence | Limits of the finding |
| --- | --- | --- |
| Mining preimage is 116 bytes | CPU and GPU worker input builders; five packed-hash/contract comparisons | Browser WASM and GPU execution were not run against the vectors |
| Message layout is address20, nonce32, previous-work32, anchor32 | Worker offsets 0, 20, 52, 84 | Native lane/nonce implementation still needs validation |
| Hash is Ethereum Keccak, with worker padding `0x01` and final `0x80` | Both workers; RPC `web3_sha3` comparisons | Not interchangeable with SHA3-256 |
| Payable transaction is `mine(uint256,uint256)` | Embedded ABI and actual frontend submission code | Does not establish every internal contract check |
| The second transaction argument is the original anchor block | ABI argument name and frontend anchor-hash-to-block mapping | An anchor cannot be substituted after hashing |
| Client compares the entire digest strictly below target | GPU worker's CPU verifier | A displayed integer bit count is insufficient |
| Current chain ID is 4663 | Official RPC `eth_chainId` returned `0x1237` | RPC service identity was not independently cross-checked |
| Contract anchor window is 250 blocks | Pinned `ANCHOR_WINDOW()` call | Exact oldest accepted boundary remains untested |
| Native target architecture is compute capability 8.6 for a 3070 Ti | [NVIDIA GPU table](https://developer.nvidia.com/cuda/gpus) | Browser identifies Ampere, but hides the precise GPU model |

The exact five input definitions, expected digests, selectors, RPC block tags and source archive paths are in [the plan](NATIVE-MINING-PLAN.md).

## Windows browser observations

Used the existing managed Windows Chrome profile through Browser Fast and Browser DevTools. No browser process was manually launched, no GPU setting changed, and no mining/wallet button clicked. Browser memory returned no site policies or warnings.

At **2026-09-12 16:50:22.019 UTC**, `https://hashcats.fun/mine` showed:

| Field | Rendered value |
| --- | --- |
| Miner | IDLE |
| Speed | 0 H/s |
| Wallet action | CONNECT WALLET |
| Target | 46 leading-zero bits |
| Entry price | 0.08176 ETH |
| Epoch / floor | 9 / 35 bits |
| Total minted | 6,113 |
| Displayed network streak | 11 |
| Anchor L2 block | 61,259,912 |

An earlier browser snapshot showed 6,111 minted, target 45 bits and L2 block 61,259,761. The changing target is expected for this system. These UI observations were not a single pinned contract-state snapshot. The unconnected UI's “your streak” display must not be interpreted as a reading for Hamza's wallet.

`navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })` returned:

```text
vendor: nvidia
architecture: ampere
device: empty
description: empty
isFallbackAdapter: false
```

At **16:50:35.165 UTC**, a temporary device was requested with default options, matching the worker's `requestDevice()` call. No compute pipeline was dispatched; the device was immediately destroyed after reading its limits.

| Limit | Adapter capability | Default device limit | Site worker behavior |
| --- | ---: | ---: | --- |
| Compute invocations per workgroup | 1,024 | 256 | Chooses at most 256 |
| Compute workgroup size X | 1,024 | 256 | Chooses at most 256 |
| Workgroups per dimension | 65,535 | 65,535 | Caps at 32,768; adaptive sizes can be smaller |
| Storage-buffer binding size | 2,147,483,644 bytes | 134,217,728 bytes | Observed worker buffers are far smaller |
| Buffer size | 2,147,483,648 bytes | 268,435,456 bytes | Observed worker buffers are far smaller |

**Interpretation:** this establishes a difference between adapter capabilities, default device limits and application limits. It does not establish that requesting higher limits increases speed. A 1,024-thread group may worsen register pressure or latency relative to 256; larger dispatches can delay detection of a solution or reaction to a new mint. Measure useful throughput before altering them.

The rendered `/docs#difficulty` page described an epoch floor, eight-mint retargeting, global and personal streaks, and the failsafe. Those are first-party descriptions. Local scheduling code still needs parity checks against actual contract outputs.

## Browser worker details that affect the native design

Sources: [GPU worker](https://hashcats.fun/assets/gpu.worker-BNBpr-u3.js), [CPU/WASM worker](https://hashcats.fun/assets/cpu.worker-CzK-dBIZ.js), and the saved main bundle identified in the plan.

- The GPU path already pipelines two buffer sets and adaptively sizes batches. It is not an entirely naive implementation whose overhead can simply be assumed large.
- Candidate filtering adapts to workload and buffer capacity. The proposed `targetBits - 2` rule does not describe the inspected worker.
- Candidate output contains nonce-counter/depth pairs; CPU code reconstructs and verifies the full digest before submission.
- The worker represents Keccak lanes with interleaved 32-bit components. CUDA's natural 64-bit representation is an alternative to benchmark, not an automatic improvement.
- A plain fixed 32-bit counter would exhaust its search space in about 3.44 seconds at 1.25 GH/s. Native nonce allocation needs a wider counter or properly advanced prefix and disjoint stream ranges.
- The main client's `mine` path reads price, simulates the call, estimates gas, sends through its wallet, and waits for a receipt. Search performance and submission latency are separate optimization opportunities.

## Corrections to the supplied draft

| Original assumption | Correction |
| --- | --- |
| Refresh anchor/previous work when submitting a candidate | Submit the original anchor block. If previous work changed, discard the proof |
| Native should be 2–4× WebGPU | Unverified; establish a matched benchmark |
| Browser GPU limits can simply be removed | Native changes the runtime; device, driver and hardware constraints remain |
| Single Keccak block means nothing can be precomputed | Constant lanes/padding can be prepared; a full reusable prefix-block midstate is unavailable |
| Leading-zero checking permits early exit from Keccak rounds | No such generic round-skipping method was established |
| Always pause above a fixed streak | This trades total chance for energy efficiency; choose the objective explicitly |
| Every nonce attempt costs 0.08176 ETH | Entry price is paid on a successful mint; hashes consume compute, and included failed transactions can consume gas |
| Expiring 25-second jobs inherently inflate the mathematical mean | With prompt switching and independent attempts, invalidation itself adds no extra probability penalty; stale computation and lost submissions do |
| More gas guarantees 100 ms inclusion | Not established for this sequencer |
| Abort a transaction after another cat mints | Already-broadcast transactions cannot be recalled reliably |
| HASH mint/burn ceiling is a realizable exit value | It is not a guaranteed sale price or redemption floor |

At 45 bits and 1.25 GH/s, the fixed-target mean is **7.82 hours**, and the chance in 25 uninterrupted seconds is **0.08878%**. At 48 bits, the corresponding mean is **62.55 hours**. These describe finding a proof under stable assumptions, not successfully minting under live competition.

## Remaining unknowns and implementation prerequisites

1. Actual mining address and therefore the address-specific target/personal penalty.
2. Independently measured sustained 3070 Ti hashrate, power, thermals and candidate correctness.
3. Exact anchor-boundary acceptance, target rounding, failsafe transitions, and reorg behavior.
4. CUDA versus WASM/JS full-digest parity, including high nonce bits and counter carries.
5. RPC tail latency, head freshness, WebSocket reliability, rate limits and submission ordering.
6. Local wallet import, exact address match, signer operation and spending limits. The user selected unattended signing for Robinhood Wallet on iPhone; the implementation is specified in [NATIVE-WALLET-WORKFLOW.md](NATIVE-WALLET-WORKFLOW.md) and remains unbuilt.

No CUDA miner, signer, paid transaction, 24-hour monitor or OS/GPU configuration change was created. The broader anonymous-owner, audit and liquidity claims in the supplied report were not re-investigated for this task.

## Evidence handling

Khiip archived the two worker URLs and NVIDIA documentation; capture identifiers and raw artifact paths are in the plan. Use the raw compressed artifacts when checking JavaScript, because Markdown conversion alters code characters. Browser observations above were transcribed from timestamped tool output; no screenshot artifact or complete browser network audit was produced.

Suggested manually assignable `opencode2` packages are in section 10 of the plan: protocol verification, offline CUDA search, watcher/unsigned submission, then integration.

## Public deployment and hardware guidance — 2026-09-12 follow-up

The implementation has advanced since the original investigation above; use [IMPLEMENTATION.md](IMPLEMENTATION.md) for current completion/test status and [README.md](README.md) for installation. This follow-up checks the public deployment wording, not current protocol economics.

- Local evidence: `package.json` installs Node dependencies but has no install-time driver/toolchain provisioning or native build hook. `scripts/build.mjs` requires a CUDA NVRTC installation and a C++ compiler; its header-download fallback assumes NVIDIA apt packages are already available. Cloning and `npm install` alone are not sufficient. No clean rented-host install has been tested.
- Local evidence: `native/keccak.cu` performs integer/bitwise Keccak, with no tensor-core or floating-point operations and no large DAG/model allocation. The hardware-selection inference is to measure sustained verified hash throughput, not rank by VRAM capacity or AI TFLOPS. This does not establish a measured hardware bottleneck or a ranking of GPU models.
- NVIDIA's [CUDA Best Practices Guide](https://docs.nvidia.com/cuda/cuda-c-best-practices-guide/) describes instruction throughput and the tradeoffs among register usage, occupancy and spilling. It supports benchmark-first guidance, not a guaranteed native/WebGPU speed ratio. Khiip capture: `01M2B83QH0G46K87DSR0YJ4PRB`.
- [Vast.ai SSH documentation](https://docs.vast.ai/guides/instances/connect/ssh), [Shadeform's introduction](https://docs.shadeform.ai/getting-started/introduction), and [Lambda's cloud introduction](https://docs.lambda.ai/public-cloud/) establish the provider/server context used in the README. They do **not** establish this miner's compatibility, profitability or permission to mine on any particular offering. Provider integrations, policies, pricing and physical multi-GPU scaling were not validated. Khiip captures, respectively: `01M2BYX494YDDH6EFVT5DQQWB4`, `01M2BYX5626T2WPWHRV3S94NWK`, `01M2BYX5RHZPFP89YFXZFHG3KW`.

Research was performed directly without subagents. Open WebSearch's Startpage queries returned no results and its Bing fallback returned HTTP 301 errors; fallback web retrieval opened the primary pages above. The running Khiip daemon archived all four pages with provenance.
