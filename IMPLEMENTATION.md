# Native implementation checkpoint — 2026-09-12

Working tree: `/home/hamza/repo/hashcat`, branch `feat/native-miner`. No subagents used. No mainnet signing key imported and no real paid mint submitted.

## Delivered components

| Component | Implementation |
| --- | --- |
| CLI and local wallet onboarding | `src/cli.mjs`, `src/wallet.mjs` |
| Exact protocol encoding and reference vectors | `src/protocol.mjs` |
| Pinned, checked chain snapshots and RPC compatibility | `src/rpc.mjs` |
| CUDA search / NVRTC driver worker | `native/keccak.cu`, `native/worker.cpp`, `src/gpu.mjs` |
| Watching, bounded batch scheduling and candidate handling | `src/miner.mjs` |
| Single-PC GPU discovery, selection and parallel nonce allocation | `src/gpu-pool.mjs`, `src/gpu.mjs`, `native/worker.cpp` |
| Signing, broadcast, receipt verification and recovery | `src/submitter.mjs`, `src/journal.mjs` |
| Reproducible build and million-digest comparison | `scripts/build.mjs`, `scripts/verify-gpu.mjs` |

The original plan is now partly implemented; [README.md](README.md) is the operational guide. No address rotation, trait filtering, persistent kernel, automatic restart unlocking, 24-hour profitability study or mainnet success claim is included.

## Verification checkpoint

- **21 automated tests passed** using Node's test runner, local HTTP RPC mocks and a local Ganache EVM with a purpose-built fixture. The fixture is not the Hashcats contract, and local acceptance does not prove mainnet acceptance.
- Tests cover packed hash vectors, strict target equality, anchor age, mnemonic/address matching, encrypted account-only storage, signer field recovery, journal locking/tail repair, wrong identity, RPC batch compatibility/backoff, state reorg detection, watcher pause/resume, stale-candidate continuation, funding/budget gates, real local signed mint/ownership, lost response recovery, reverted gas accounting, unknown consumed nonces and cancellation.
- The restored **selected default CUDA kernel passed a fresh 1,000,000 full digest comparisons** against the independent ethers CPU implementation across differing inputs and nonce carry boundaries. The run also passed uint256-limit, exact-target equality, candidate-output and overflow-detection checks. Future kernel changes require rerunning that gate before promotion.
- A live **20-second SHADOW run at 17:31–17:32 UTC** completed about **20.9 billion hashes**, followed total-minted changes from 6,294 to 6,296, and paused/resumed on an HTTP error. Active intervals were roughly **1.17–1.23 GH/s**. No signing/broadcast path was enabled.
- Node 24's optional Ganache µWS native module was unavailable; the local tests used its JavaScript fallback and passed. This warning concerns the test dependency, not the native CUDA worker.

## Performance evidence, not a speedup promise

Machine: NVIDIA GeForce RTX 3070 Ti, compute capability 8.6, WSL CUDA driver, CUDA NVRTC 13.1, Node 24.19.0. Browser was closed for native runs. Short tests on the display GPU are not a controlled thermal/power comparison against the earlier browser screenshot.

| Trial | End-to-end GH/s | Notes |
| --- | ---: | --- |
| Reported browser baseline | 1.25–1.30 | User measurement, not rerun under a matched harness |
| Initial native, limited loop unrolling, 256 threads | 1.060 | 10-second run |
| Fully unrolled native, unrestricted register allocation, 128 threads | 1.167 | 105 registers, 10 seconds |
| Fully unrolled native, 80-register cap, 128 threads | 1.190 | 10 seconds; internal kernel/copy timer about 1.246 GH/s |
| Explicit funnel shifts, 80-register cap | 1.182 | 15 seconds; no clear improvement |
| Explicit funnel shifts, 64-register cap | 1.193 | 15 seconds; difference too small to establish a win |
| Explicit funnel shifts, 72-register cap | 1.079 | 15 seconds; regression |
| Explicit funnel shifts plus constant padding lanes | 1.131 | 15 seconds, compiler used 72 registers despite cap 80; regression |
| Restored selected default, final longer run | 1.088 | 30.011 seconds, 32,644,375,168 hashes; internal timer 1.136 GH/s |
| Selected default, 128 threads, repeatable harness (new) | 1.176 / 1.192 / 1.193 | 3×30 s + 5 s warmup, median 1.192; kernel 1.230-1.241; batch p50 ~14 ms; 72-75C, ~255 W; `reports/bench-128.json` |
| Selected default, 256 threads, repeatable harness (new) | 1.170 / 1.167 / 1.154 | 3×30 s + 5 s warmup, median 1.167; kernel 1.207-1.221; 128 threads retained; `reports/bench-256.json` |
| Reverted: async stream + pinned staging + scoped theta temps | 1.159 / 1.154 / 1.072 | 3×30 s median 1.154 < 1.192 baseline; kernel also slower (1.20 vs 1.24), so not thermal alone; reverted to baseline, 10k digests PASS after restore; `reports/bench-async-128.json` |

Repeatable harness: `npm run benchmark -- --seconds 30 --runs 3 --warmup-seconds 5 --threads 128 --report reports/bench-128.json`. Kernel `7aacc0577f0a`, unroll 24, 80-register cap, `sm_86` 3070 Ti, Node 24.19.0, display GPU, browser closed.

At this checkpoint, native has **not beaten the browser** (1.25–1.30). The earlier 1.088 single 30 s run is superseded by the 1.192 median; short-run 1.19-1.193 differences are within run variance. The independent benefit already implemented is local automatic submission and recoverable transaction identity.

The default was restored to the best checked 64-bit implementation: full 24-round unrolling, 80-register compiler cap and 128-thread blocks. Explicit funnel-shift and constant-padding changes were reverted because they did not establish an improvement. Source kernels always execute the complete Keccak-f1600 permutation. Batches are bounded to protect job-refresh latency; larger batches may improve benchmark throughput while increasing stale time. See [NEXT-STEPS.md](NEXT-STEPS.md) for the next measurement and alternative-kernel experiment, including an optional opencode2 handoff.

For the screenshot's approximate 49-bit target, `2^49 / (1.26e9)` is about **5.17 days mean search time** under a fixed target and continuously valid work. This is not a guaranteed mint wait, and a faster miner still competes with other miners and submission latency. At 45 bits, the corresponding mean is about **7.76 hours**. The live client reads the full target; these calculations are explanatory historical examples, not its configuration.

## Source provenance for tuning

NVIDIA's [integer intrinsic documentation](https://docs.nvidia.com/cuda/cuda-math-api/cuda_math_api/group__CUDA__MATH__INTRINSIC__INT.html) and locally installed CUDA 13.1 `sm_32_intrinsics.h/.hpp` were checked for funnel-shift semantics. Open WebSearch discovery returned no useful result; the primary documentation was then opened directly. The documentation was archived through the existing Khiip daemon as capture **`01M2BB5R74AKNVBG3XWDNMR39Y`**. This establishes API behavior, not a performance improvement.

## Single-PC multi-GPU implementation

`mine`, `benchmark` and `doctor` now default to all CUDA-visible devices. `devices` lists indices/UUIDs without starting a mining context; `--gpus 0,1` selects a subset. Native workers select their assigned CUDA device and compile for that device's compute capability. The build now locates common Linux driver-library paths as well as WSL's.

The host pool dispatches distinct contiguous counter ranges concurrently, adapts the work split to measured per-device throughput, and keeps one shared submission/journal owner. It verifies golden hashes on every selected GPU and rejects candidates outside the reporting worker's assigned range. Worker errors stop the complete pool. Results wait for the slowest assigned worker in each bounded batch; this is not an independent persistent dispatcher per GPU.

- **34 automated tests passed**, including ten new pool tests covering selection, weighted allocation, concurrency, carry boundaries, per-device golden checks, out-of-order diagnostic results, cross-device nonce rejection, startup/runtime failure cleanup, cancellation, shared submission and benchmark accounting. The prior final nonce/freshness regression tests still pass.
- `npm run build` succeeds with warnings treated as errors. CUDA enumeration reports the one physical RTX 3070 Ti. Selecting absent device 1 correctly fails before a benchmark starts.
- The rebuilt worker through the default pool passed **1,000,000 full CUDA/CPU digest comparisons**, carry/high-bit boundaries, uint256 limit, strict target equality, candidate output and overflow checks on the physical 3070 Ti.
- Initial single-device pool smoke benchmark: **1.236 GH/s wall-clock**, one 3-second run after 1-second warmup. This is a smoke result, not sustained-performance evidence or a speedup over the reported browser baseline.
- Multi-device behavior is tested with up to three simulated workers; **physical multi-GPU scaling has not been measured**. No additional GPU, wallet or paid mint is claimed.

Commands, device-index remapping and operating limits are documented in [README.md](README.md#multiple-gpus-in-one-pc). The CUDA hash kernel itself is unchanged.

## Remaining operational gates

1. User imports the new iPhone wallet locally and confirms the full public address.
2. User funds that exact address on Robinhood Chain and explicitly chooses live price/budget limits.
3. Run a funded readiness check and shadow rehearsal before enabling paid submission.
4. A genuine qualifying mainnet proof and successful receipt are still required to demonstrate an actual mainnet mint. Neither is claimed by the local tests.

The selected default has completed the correctness gate. Further speed experiments and richer latency/stale-work telemetry are deferred to [NEXT-STEPS.md](NEXT-STEPS.md); no performance gain over the browser is claimed.
