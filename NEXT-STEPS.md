# Next steps: improve the chance of an accepted mint

## Decision

Keep the best correctness-checked native kernel as the reference. It measured approximately 1.19 GH/s end-to-end in a short run but 1.09 GH/s in the final 30-second run, not a win over the user's 1.25–1.30 GH/s WebGPU result. The next work should measure accepted-work losses and submission latency, alongside a bounded alternative-kernel experiment. First establish repeatable throughput with clock/power/temperature readings rather than assuming the cause of the run-to-run difference. Do not spend ETH just to demonstrate that automatic signing works; local-chain tests already exercise it, while mainnet success still needs a genuine valid proof.

Scope is normal, valid mining: no exploiting contract bugs, bypassing payment or interfering with other miners. No verified proof shortcut has been established by this investigation.

## What changes the odds

A uniform hash qualifies with probability `target / 2^256` (strict less-than comparison). Over a period with fixed conditions, the approximate chance of finding at least one qualifying proof is `1 - exp(-hashes * target / 2^256)`. This is a proof-finding model, not an inclusion guarantee.

- More **nonduplicated, correct hashes** increase the opportunity rate.
- An approximately one-bit easier target doubles the per-hash opportunity. Difficulty must be read for the actual mining address, not inferred from a rounded UI label.
- Time hashing an already obsolete previous-work value, an expired anchor or a broken input does not help.
- A qualifying proof still needs to survive CPU validation, signing, submission and competition until inclusion.
- Unsuccessful work does not accumulate toward a guaranteed win, but changing jobs does not erase the statistical opportunities already attempted. There is no need to solve a whole multi-hour proof within one 25-second window; each individual hash is an independent attempt.

For maximum chance over a fixed time period, keep searching valid jobs whenever spending is permitted. Waiting for easier difficulty may improve chance per electricity spent, but giving up valid attempts is not a free improvement in total chance. No wallet rotation or hard-coded streak heuristic is proposed for this version.

## Priority 1 — operational readiness without payment

1. Import the new Robinhood Wallet account using the hidden local prompt. Match the full public iPhone address. Never send the recovery phrase to an agent.
2. Run the offline signer check and inspect `status` for that address on chain 4663.
3. Run a bounded shadow rehearsal and inspect pauses, RPC timing and job changes. It must remain explicitly unable to send transactions.
4. Choose price, total spending and gas ceilings before any live run. Do not infer these from old screenshots.

The importer, signer checks, status, shadow mode and budget gates already exist. See [README.md](README.md).

## Priority 2 — measure useful work and submission delay

Add timestamps/counters for snapshot age, job-change detection, hashes issued per job, time paused, candidate discovery, CPU verification, gas estimation, signing, durable append, first RPC acknowledgement and receipt inclusion. Report read latency percentiles and observed work invalidations. These measurements are not fully implemented yet; `progress.rpcMs` alone is insufficient.

Use local-chain fault injection to compare submission policies before spending real ETH. Then improve the slowest measured stage. Candidates currently require fresh reads, estimation and another freshness check, so RPC latency may outweigh signing time. Do not remove checks or hard-code gas estimates merely to claim lower latency.

If public RPC throttling dominates, test a user-authorized dependable endpoint. No paid RPC service has been selected or purchased. Websocket/event subscriptions are a possible later change only after the actual endpoint's support and missed-event recovery have been verified.

## Priority 3 — one bounded speed experiment

Implement an **alternative 32-bit/interleaved Keccak CUDA kernel**, using the observed browser worker representation as a design reference, then compare it with the existing 64-bit kernel. This is a hypothesis, not a promised gain. Preserve full Ethereum Keccak semantics, all 24 rounds, exact packing and strict full-target comparison.

Acceptance gate:

- Five reference vectors, one million independent full digest comparisons, nonce carry/range limits, candidate equality rejection and overflow checks pass.
- At least three sequential, thermally comparable 30–60 second runs per candidate on the same GPU, without another miner running.
- Compare median **end-to-end** throughput, not just the GPU timer; also record batch latency and power/temperature.
- Retain the baseline unless the gain is repeatable. A useful target is to exceed 1.30 GH/s reliably, not momentarily display a bigger number.

The previous partial-unrolling, explicit funnel-shift and constant-padding trials did not establish a speedup over the best baseline. Those unsuccessful source changes were not left as the default.

### Optional opencode2 handoff

No agent has been started. Hamza can run this bounded subtask independently:

> Own only a new `native/keccak32.cu` and a short experiment note. Implement a compatible alternative 32-bit/interleaved Keccak kernel for the existing HASH/SEARCH/DIGEST worker interface. Read `src/protocol.mjs`, `native/keccak.cu` and `scripts/verify-gpu.mjs` for the frozen format/tests. Do not change wallet, submission, journal, RPC, the baseline kernel, dependencies, GPU settings or spending behavior. You are not alone in the repository; preserve others' edits. Return an integration patch and correctness evidence. Coordinate GPU test windows with Hamza: do not benchmark concurrently with another miner. Do not claim mainnet success from fixture tests.

## First paid run

Only after account readiness and explicit limits are established, use a one-cat live run. Confirm the receipt and ownership before scaling to multiple cats. Neither a faster GPU nor local signing makes the protocol economics or retained contract-owner powers safe.
