# Hashcats native mining plan — RTX 3070 Ti

Prepared 2026-09-12. Scope: a technical plan for increasing accepted mining work and reducing submission delay. This document does not implement or run a miner, change GPU/browser settings, connect a wallet, or submit transactions. No GPU benchmark was performed; **1.25 GH/s is your reported WebGPU baseline**.

See [FINDINGS.md](FINDINGS.md) for the evidence ledger, including the subsequent Windows browser inspection and measured adapter/device limits.

## Recommendation

Build a small native CUDA search engine with a host-side chain watcher, independent CPU verifier, and transaction submitter. Start with short, bounded GPU batches and one mining address. Establish correctness and measure useful throughput before adding persistent kernels, extra streams, address rotation, or aggressive scheduling.

Native CUDA gives control over kernel compilation, launch sizes, nonce allocation and result handling. It does not remove protocol difficulty, anchor expiry, competition, driver scheduling, or hardware limits. There is no measured basis here for promising a 2–4× improvement over the existing browser miner.

Two objectives need different policies:

- **Maximum chance over a fixed period:** keep computing whenever the job is valid and the entry price is acceptable. Pausing during difficult periods sacrifices some chance.
- **Maximum chance per unit of electricity or a fixed energy budget:** preferentially mine when the address-specific target is easier. Evaluate the benefit against waiting time and competition for those periods.

The primary metric is **accepted mints per cost and elapsed time**, supported by valid, nonduplicated hashes per second and submission latency. Hashrate alone is insufficient.

## 1. Evidence and live snapshot

The supplied report mixes snapshots. Treat its counts, prices, difficulty and economics as historical observations, not configuration constants.

Read-only JSON-RPC observations from `https://rpc.mainnet.chain.robinhood.com`, with contract reads pinned to block **61,256,947 (`0x3a6b4f3`)**, queried beginning **2026-09-12 16:45:18 UTC**:

| Read | Result |
| --- | --- |
| `eth_chainId` | `0x1237` = 4663 |
| `totalMinted()` | 6,092 |
| `currentEpoch()` | 9 |
| `mintPrice()` | 81,760,000,000,000,000 wei = 0.08176 ETH |
| `currentTarget()` | `0x000000000000ffffffffffffffffffffffffffffffffffffffffffffffffffff` — approximately 48-bit difficulty |
| `ANCHOR_WINDOW()` | 250 blocks |
| `pacePlan()` | 10 seconds target interval, 10 seconds decay halflife, 300 seconds failsafe idle |

This was the **global** target. No user mining address was supplied, so `targetFor(yourAddress)` and your personal penalty were not checked. Read the full 256-bit target for the actual mining address before starting.

Collection: `0xCA75DF55Cc9C476DB27a7375D1fc8E794cf80721`.

Frontend evidence:

- Saved main bundle: `/tmp/opencode/hashcats/index.js`, SHA-256 `97beff268571b5235f9802fcffbace05ed9adcb19240a4c9c7b2495dcde2eb91`.
- [GPU worker](https://hashcats.fun/assets/gpu.worker-BNBpr-u3.js), fetched and inspected during this work.
- [CPU/WASM worker](https://hashcats.fun/assets/cpu.worker-CzK-dBIZ.js), fetched and inspected during this work.
- [Public documentation](https://hashcats.fun/docs). The existing Khiip `/docs` capture contains page metadata but no substantive rendered documentation. The rendered mining/difficulty sections were subsequently inspected in the managed Windows browser; distinguish their protocol descriptions from the specific contract reads and hash comparisons completed here.

Frontend code establishes client behavior; it does not prove every contract authorization rule or future parameter value. This work did not repeat the broader audit, ownership, liquidity or wallet-safety investigation.

## 2. What “remove the browser GPU limitation” means

First establish that the browser actually uses the 3070 Ti hardware adapter. Its worker requests a high-performance adapter and rejects recognized software renderers. Do not assume an apparent hashrate ceiling is an intentional mining cap.

The inspected GPU worker already:

- Builds a shared, padded Keccak input on the CPU.
- Runs 32 nonce attempts per invocation in ordinary batches.
- Uses two result-buffer sets and adaptive batch sizing, with a desktop timing target of roughly 24 ms.
- Chooses workgroup size up to 256, subject to device limits, and bounds the workgroup count by both device limits and a site ceiling of 32,768.
- Returns candidate nonce/depth pairs, with adaptive candidate filtering, and recalculates candidate hashes on the CPU.

These are implementation and device constraints, not evidence of a universal browser percentage cap. Raising a dispatch ceiling alone need not help; it may only delay result delivery and job replacement. Source: [GPU worker](https://hashcats.fun/assets/gpu.worker-BNBpr-u3.js).

**Windows observation, 16:50 UTC:** the high-performance adapter reported NVIDIA Ampere, `isFallbackAdapter = false`, and 1,024 maximum invocations per workgroup. A temporary device created with the site's default `requestDevice()` options reported 256. It was destroyed without dispatching compute. The device allowed 65,535 workgroups per dimension, whereas the worker imposes its own 32,768 ceiling. The adapter did not expose an exact model name. These observations identify limits, not a measured performance loss; see [the complete findings](FINDINGS.md).

Native CUDA removes dependence on this browser worker and its dispatch/readback policy. Keep the normal driver watchdog and stable power settings during initial development. Use bounded kernels; a continuously running kernel is not a prerequisite for native mining.

Before benchmarking, record OS, driver and toolkit versions, GPU model, clocks, power, temperature, and whether the card drives the display. `nvidia-smi` and `nvcc --version` are useful inventory commands when installed. Native Linux or a supported CUDA environment is sufficient; an OS migration is not a prerequisite established by this investigation.

The RTX 3070 Ti has compute capability **8.6**; target `sm_86` in the eventual CUDA build. [NVIDIA GPU table](https://developer.nvidia.com/cuda/gpus).

This task concerns Hashcats' custom live proof-of-work protocol. The similarly named Hashcat password-recovery program is not established here as a compatible mining client.

## 3. Exact hashing and transaction specification

### Work input

The worker builds **116 bytes**, equivalent to Solidity packed encoding:

| Bytes, inclusive | Field | Encoding |
| --- | --- | --- |
| 0–19 | miner | 20 address bytes |
| 20–51 | nonce | unsigned 256-bit integer, big-endian |
| 52–83 | prev | unsigned 256-bit previous-work value, big-endian |
| 84–115 | anchor | 32-byte L2 block hash |

`digest = EthereumKeccak256(miner20 || nonce32 || prev32 || anchor32)`.

Use Ethereum Keccak-256, not standardized SHA3-256. The worker pads the message to the 136-byte rate with byte `0x01` at offset 116 and the final `0x80` bit at offset 135. Keccak lanes use their own little-endian representation internally; do not confuse that with integer encoding in the message. Both inspected workers use this layout. Five RPC/contract comparisons below also match it.

The **work preimage** is packed. The **function call arguments** use normal ABI encoding, including a 32-byte address slot. Confusing those two encodings produces the wrong hash.

For a full target `T`, the client accepts `uint256(digest) < T`. Compare all 256 bits; display labels such as “48 zero bits” do not substitute for the threshold. In particular, equality must fail. Source: [GPU worker's CPU comparison](https://hashcats.fun/assets/gpu.worker-BNBpr-u3.js).

One permutation handles this input. Prebuild constant input lanes and padding once per job. There is no reusable complete prefix-block midstate, but constant setup can still be optimized. Do not assume an early leading-zero check can omit ordinary Keccak rounds; start with the full 24-round computation.

### Required reads and ABI

The saved frontend ABI exposes:

| Function | Purpose / selector where checked |
| --- | --- |
| `workHash(address,uint256,uint256,bytes32)` | Contract hash oracle; `0xc1343e45` |
| `targetFor(address)` | Exact address-specific target; `0x16ccc8c0` |
| `mine(uint256 nonce,uint256 anchorBlock)` | Payable submission; `0x071e9503` |
| `prevWork()` | Current previous-work value |
| `currentAnchor()` | Returns `(anchorBlock, anchorHash)` |
| `mintPrice()` | Required payment; `0x6817c76c` |
| `totalMinted()`, `currentEpoch()` | Mint/epoch transitions |
| `currentTarget()`, `baseTarget()`, `personalBurst(address)` | Monitoring and model checks |
| `ANCHOR_WINDOW()`, `pacePlan()` | Current validity/scheduling parameters |
| `targetAt(uint256,uint256,uint256,uint256,uint256)` | Pure helper, named arguments `id, base, floorBits, idle, burst`; parity must be established before using a local model |

Read related state at one block tag to avoid combining an old previous-work value with a new target or price. Refresh on new mints and periodically as time-dependent difficulty changes. A WebSocket URL is not interchangeable with an HTTP RPC endpoint; the saved frontend names `wss://robinhood.drpc.org`, but its availability and latency were not tested here.

The contract call is `mine(nonce, anchorBlock)` from the same miner address, with `value = mintPrice()`. The previous-work value and anchor hash are not explicit transaction arguments. The contract derives them from current state and the supplied anchor block.

**Never replace the anchor or address after finding a proof.** Submit the anchor block corresponding to the hash actually searched. A new cat changes previous work and invalidates the old job; refreshing `prev` cannot repair that solution.

### Five reference vectors

At block **61,257,222 (`0x3a6b606`)**, each packed input below was hashed using RPC `web3_sha3` and compared with `eth_call` to `workHash`. All five matched. This is RPC/contract evidence from one provider, not an independent node audit or a completed CUDA/WASM parity test. These arbitrary inputs are hash vectors, not mintable solutions.

In this table, `00 × N`, `11 × N`, etc. mean repeat that hexadecimal byte exactly N times; integer values are encoded into the 32-byte slots above.

| # | Miner bytes | Nonce integer | Prev integer | Anchor bytes |
| --- | --- | --- | --- | --- |
| 1 | `00 × 20` | 0 | 0 | `00 × 32` |
| 2 | `11 × 20` | 1 | 0 | `22 × 32` |
| 3 | `12 × 20` | `0x100000000` | 1 | `ab × 32` |
| 4 | `ff × 20` | `2^256 - 1` | `2^256 - 1` | `ff × 32` |
| 5 | `000102030405060708090a0b0c0d0e0f10111213` | `0x0123456789abcdef` | `0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f` | `202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f` |

Expected full digests:

```text
1  0x3bdd562417b2b6c29b6c37a0fbf5c08139fe63f7baf013194f112d8319bf8b32
2  0x30cc5ea4c833dffdaa3c1f6b4a7581a1b13fd73c1cf4aefcdb4d0ada2b4c0aac
3  0xa17ffa45319646808b08ddebd0483225badfb58cee06e57258f7033875fc95d8
4  0x674dddb39f7c9d47047974f64d264092511068452a7a1f662194fdd635606d53
5  0x83c4d16de13fe0f5a4d513eecde45ee25e520541e63acaaf4b0e802d8b2df56a
```

Before live use, require the independent CPU implementation and CUDA diagnostic mode to reproduce these full digests. Then compare a deterministic random corpus, including nonce carries, high nonce bits, changed addresses, previous work, and anchors. One million comparisons is a proposed development gate, not a check already executed. Test the deployed browser engines on their supported nonce representation too; their internal counters/stream encoding are not simply an arbitrary full-width nonce API.

## 4. Probability: why speed and target both matter

For uniformly distributed 256-bit hashes and strict target `T`:

```text
p per distinct hash = T / 2^256
expected hashes = 2^256 / T
P(at least one qualifying hash in N attempts) = 1 - (1 - p)^N
approximately, P = 1 - exp(-H * t * p)
```

For approximate b-bit difficulty, expected time is `2^b / H`. At the reported **1.25 GH/s**:

| Approximate difficulty | Mean search time | Chance in 25 uninterrupted seconds |
| --- | --- | --- |
| 35 bits | 27.5 seconds | 59.73% |
| 40 bits | 14.66 minutes | 2.802% |
| 44 bits | 3.91 hours | 0.1775% |
| 45 bits | 7.82 hours | 0.08878% |
| 48 bits | 62.55 hours | about 0.01110% |

These are probabilities of **finding a qualifying hash**, assuming a stable threshold, valid work throughout, unique attempts, and continuous execution. They do not promise accepted mints. At 45 bits, the median search time is about 5.42 hours and the 95th-percentile time about 23.42 hours under the same assumptions.

A one-bit reduction doubles the success rate; a genuine 2× speedup has the same mathematical effect while active. However, waiting for low difficulty can reduce total attempts, and low-difficulty intervals may end quickly as others win.

**Anchor refresh does not reset accumulated probability in a way that adds another penalty by itself.** Hash search is memoryless. With immediate job switching, fresh independent hashes contribute at the same per-hash probability. The real losses are hashing already-invalid work, switching downtime, duplicate nonces, and proofs that become stale before inclusion. Do not multiply the mean time by an arbitrary “25-second window penalty.”

For varying targets, estimate exposure as `sum(H_effective * interval_seconds * T / 2^256)`. Its Poisson approximation gives `P(find ≥1) ≈ 1 - exp(-exposure)`; accepted-mint estimates need a separately measured submission-success model. Do not infer precise network hashrate from one mint gap when miner targets and streaks differ.

## 5. Minimal native architecture

```text
chain watcher → immutable job → bounded CUDA batches → CPU verifier → submitter
       └──────── current state / invalidation ────────────────┘
```

These are responsibilities, not a requirement for five threads or services. Start with one host process, asynchronous RPC, one GPU execution worker, and a small candidate queue. Keep signing authority out of GPU code.

A job records chain ID, collection, miner, observed block number/hash, previous work, anchor block/hash, full target, mint price, nonce range, and a generation identifier. Every GPU result retains the job it came from. Never reinterpret a delayed result using mutable “latest job” fields.

**Watcher:** subscribe to heads/mint events if the endpoint supports them, and reconcile after reconnects. Use bounded HTTP polling as fallback, with provider-aware backoff. A 100 ms polling interval is an initial experiment, not a mandate to send every contract read ten times a second. Measure head freshness as well as response time. Resynchronize after a reorg or endpoint disagreement.

**Anchor management:** obtain anchor block and hash together. The observed limit is 250 **blocks**, not a guaranteed 25-second lifetime. Calculate remaining blocks and retain a margin for batch duration, verification, signing, RPC delay and inclusion. Refresh before that margin is exhausted. Exact boundary acceptance remains a simulation/test case; do not guess whether the oldest boundary is inclusive.

**Nonce allocation:** give each worker/stream disjoint ranges. A 32-bit counter wraps after about 3.44 seconds at 1.25 GH/s, so a fixed 32-bit nonce space is inadequate. Use a wider counter or a correctly advanced prefix with explicit carry handling. Address changes create distinct hash spaces; they do not increase hashes per second.

**CUDA:** begin with full Keccak-f[1600], one thread processing a short nonce sequence, and measured batches around 5–25 ms. This range is a starting hypothesis for balancing throughput and reaction time. Sweep block sizes such as 128 and 256; compare 64-bit lanes with the worker's paired/interleaved 32-bit representation only after correctness is established. Record compiler register/spill output. Higher occupancy is not automatically faster. [NVIDIA execution-configuration guidance](https://docs.nvidia.com/cuda/cuda-c-best-practices-guide/#execution-configuration-optimizations).

**Results:** return qualifying nonce records and minimal diagnostics. Avoid copying every hash or keeping the site's full histogram in the production hot path. If using a prefix filter, it must be a superset of the exact target test, including boundary cases. Near misses can aid diagnostics but `targetBits - 2` is not a protocol requirement. On candidate-buffer overflow, report and account for it; never silently lose valid candidates.

**Verifier:** independently recompute the full hash on CPU, compare against the applicable full target, and check job freshness. A target-only change does not necessarily invalidate the preimage; evaluate its current eligibility. A changed previous-work value does invalidate it. Do not require CPU rehashing of every production attempt—that would bottleneck the GPU. Use full-digest validation in diagnostic mode and sampled verification during normal operation.

Add a second stream/pinned result buffers only if profiling shows transfer or synchronization gaps. Consider a persistent kernel only if launch overhead remains material after batching and a correct bounded cancellation/result protocol exists. Keep the simpler design if measured accepted-work throughput is equivalent.

## 6. Timing policy

Use `targetFor(miner)` as the authority. The snapshot's 10/10/300-second pace parameters do not by themselves prove that a hand-written “one bit per ten seconds” model exactly reproduces integer rounding, combined global/personal penalties and failsafe behavior.

1. Observe current target, mint events and elapsed idle time. Validate any local prediction against contract reads over real transitions.
2. In maximum-chance mode, continue on valid jobs within the spending limit, replacing work promptly after another mint.
3. In energy-budget mode, set a threshold on expected qualifying hashes per joule using the actual target and measured power. Evaluate this policy on recorded target intervals before choosing a fixed streak cutoff.
4. Stay ready around an approaching failsafe, but start based on the actual target change. Other miners can end the idle period first.
5. Use one address initially. Optional rotation can avoid a personal penalty only if contract readings confirm the alternative address has a better target. It cannot remove the global penalty. Switching addresses requires new work and separate transaction-nonce/funding management; a found proof cannot move between addresses.

Do not wait for a seed time bucket or discard otherwise valid solutions for hoped-for traits. Rarity selection is outside this throughput objective; the plan does not establish a broader proof that all rarity influence is impossible.

## 7. Fast, correct submission

The selected approach is unattended local signing for the user's Robinhood Wallet on iPhone, after a one-time local import and exact address match. Follow [NATIVE-WALLET-WORKFLOW.md](NATIVE-WALLET-WORKFLOW.md) for setup, readiness gates, explicit transaction construction, durable journaling and recovery. That document resolves the earlier signer choice; no signer has been implemented yet.

Prepare the sender, pending transaction nonce, chain ID, destination, payment ceiling and fee policy before searching. Start with unsigned transaction construction and simulation. Once operational, unlock the signer before arming the miner, without phone prompts on each solution.

The direct payable `mine` path inspected here does not require an ERC-20 allowance. “Pre-approve the chain” is not an on-chain authorization step.

On a candidate:

1. Recover its original job and recompute its hash on CPU.
2. Check previous work, anchor lifetime, sender target and entry price against sufficiently fresh state. Reject if the price exceeds the configured maximum.
3. Construct `mine(foundNonce, originalAnchorBlock)` from the original miner address, with the required ETH value.
4. Initially simulate through a fresh gas-estimation execution of the fully specified call, then sign and broadcast promptly. The native wallet workflow uses that execution check without an additional redundant `eth_call`. Simulation reduces avoidable failures but is not a reservation; another mint can still win first. Measure its latency before considering removal from a later production path.
5. Track the transaction hash, receipt status and mint event. A returned transaction hash is not proof of success.

The saved site client reads price, simulates, estimates gas, asks its wallet to send, and waits for the receipt. Native operation can reduce avoidable setup and human delay, but gas premiums do not establish guaranteed next-block ordering on this sequencer. The one-cat-per-block claim also does not imply exactly one cat every block.

On ambiguous broadcast failure, compute/retain the signed transaction hash and check its status. Re-broadcasting **the same signed bytes** to a healthy endpoint is different from creating a second transaction. Do not blindly advance the sender nonce or issue duplicate mint attempts. Once signed and broadcast, a transaction cannot simply be “aborted”; cancellation/replacement may arrive too late. Stale transactions may revert and still cost gas.

Use the official HTTP RPC as the initially verified endpoint. The frontend also references `https://robinhood.drpc.org` and its WebSocket counterpart; treat them as candidates to measure, not equally trusted or benchmarked fallbacks. Compare chain identity, returned block hashes, freshness, rate limits and tail latency before routing submissions.

## 8. Benchmark and release gates

These are proposed implementation checks. Only the five RPC/contract hash comparisons and stated read-only snapshot checks have been completed here.

| Gate | Evidence required before advancing |
| --- | --- |
| Protocol lock | ABI signatures, five vectors reproduced locally, exact target comparison, contract-read parity, anchor-boundary behavior |
| Offline GPU correctness | Full digest comparisons on deterministic inputs; nonce carry/disjointness; exact-target boundaries; zero mismatches |
| Responsiveness | Job switch while a batch is in flight; old-prev rejection; correct original-anchor association; overflow and GPU-error handling |
| Shadow operation | Read-only live jobs; unsigned submissions/simulation; disconnect/reconnect and endpoint disagreement handled; no signing |
| Native performance | Several matched steady-state browser/native runs on the same GPU and power settings, after warm-up; medians and variability reported |
| Paid operation | Explicit wallet and maximum mint/gas/session budgets, signer configured, transaction lifecycle checks complete |

Log completed unique attempts, sampled hash correctness, stale-work time, candidate count, stale-candidate count, job-switch delay, batch/readback latency, RPC p50/p95/p99, head lag, and eventual candidate-to-receipt time. Include measured power and thermal throttling. Record kernel-only and end-to-end rates separately.

Define the denominator for every percentage. “Stale work” is the fraction of computation spent after a job invalidation; “stale candidates” is the fraction of found candidates lost before acceptance. With very few finds, a stale-candidate percentage is not statistically useful. The proposed 30% cutoff is not a validated protocol threshold.

A day of read-only telemetry may help evaluate scheduling, but a compulsory 24-hour delay is unnecessary for the initial offline correctness work. No day-long monitor was started as part of this document.

## 9. Cost accounting and stopping

Separate three events: a nonce attempt, a found proof, and an accepted mint. Individual hashes do not cost the NFT entry price. A successful mint pays the entry price plus gas; a reverted included transaction generally costs gas while its value transfer reverts. Electricity accrues throughout operation.

Track costs in a common unit at an explicit conversion time:

```text
realized cost = successful mint payments + all paid gas + electricity
             + any explicitly included hardware/opportunity cost
```

Use measured wall power where possible. The supplied 280 W is not a measurement of this machine. For illustration only, 0.280 kW over the 45-bit mean of 7.82 hours is about 2.19 kWh; multiply by the actual tariff. This is not an estimate of cost per accepted cat under changing difficulty.

Treat burn-and-sale and NFT-sale as alternative exits, not additive proceeds from the same cat. Do not add future rent that would cease after burning. An advertised mint-and-burn price ceiling is not a guaranteed HASH sale price or redemption floor; realizable value depends on executable quotes, fees, liquidity and time. This document does not update those markets or predict profitability.

Stop automatically on correctness failures, unresolved nonce/job state, exhausted budget, unacceptable mint price, persistent RPC inconsistency, or unstable GPU operation. Set economic limits before starting. Do not use the proposed “network share below 0.05%” rule without a defensible share estimate; it is an arbitrary threshold, and differing miner targets complicate that estimate.

## 10. Work packages for opencode2

No additional agents are required. These can be assigned manually; implementation packages depend on the preceding specification/verification output.

1. **Protocol verification:** extract the ABI from the saved main bundle; reproduce section 3's vectors with an independent local Keccak implementation; verify exact target comparison and anchor-boundary behavior with read-only calls or a local harness. Deliver a small spec/vector artifact. No wallet keys or paid transactions.
2. **Offline CUDA prototype:** implement only nonce search and diagnostic full-digest output for `sm_86`; use explicit nonce ranges and bounded batches. Deliver correctness results and matched timing/power measurements against the reported baseline. No live signer.
3. **Watcher and unsigned submit path:** build coherent jobs from chain reads; handle mint changes, anchor expiry and reconnects; construct/simulate `mine` transactions with the original anchor. Deliver latency and stale-work evidence. No broadcast.
4. **Wallet readiness and integration:** implement the selected [local signing workflow](NATIVE-WALLET-WORKFLOW.md), validate it offline and in controlled integration scenarios before attaching paid mining, then connect verified search to the watcher. Configure the user's chosen spending limits before any paid operation. Add complexity only for a demonstrated bottleneck.

An independent documentation-only task can check OS-specific CUDA/watchdog prerequisites. It need not block the portable protocol and offline search work.

## Evidence archive

Known source URLs were archived through the running Khiip daemon. Open WebSearch discovery attempts returned no useful results; the worker URLs came from the saved frontend and NVIDIA pages were fetched directly. Read raw artifacts for code: HTML-to-Markdown extraction can alter JavaScript operators and escaping.

| Source | Capture ID | Local Markdown / raw artifact |
| --- | --- | --- |
| GPU worker | `01M2B830E6CAT60PD64J9KX3VE` | `/home/hamza/khiip-vault/captures/web/untitled-7.md`; `/home/hamza/.local/share/khiip/sources/web/01M2B830E6CAT60PD64J9KX3VE.html.gz` |
| CPU/WASM worker | `01M2B8403X64798QGW73RAXPG0` | `/home/hamza/khiip-vault/captures/web/untitled-8.md`; `/home/hamza/.local/share/khiip/sources/web/01M2B8403X64798QGW73RAXPG0.html.gz` |
| CUDA Best Practices | `01M2B83QH0G46K87DSR0YJ4PRB` | `/home/hamza/khiip-vault/captures/web/cuda-best-practices-guide.md` |
| NVIDIA GPU capabilities | `01M2B85FNWH57X69VS3DEAQDAZ` | `/home/hamza/khiip-vault/captures/web/nvidia-cuda-gpu-compute-capability.md` |

Live RPC observations and vector outputs are recorded in this document with their block tags. Browser observations are recorded in [FINDINGS.md](FINDINGS.md). No independent RPC-provider comparison, CUDA run, browser benchmark, or wallet interaction was performed.
