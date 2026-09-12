# Dependency setup

Run `bash scripts/setup.sh` from a checkout. This installs missing dependencies and verifies local mining. `--check` only inspects dependencies; `--install-driver` additionally permits Ubuntu's recommended host driver installation when GPU access is missing. The normal setup path never changes a working host driver.

## Installed components

- System build/download tools, when absent: `build-essential`, `curl`, `ca-certificates`, `tar`, `xz-utils`, `coreutils` through apt. Privileged commands run through sudo unless already root.
- Node 24.21.0 from the official `nodejs.org` Linux x64 distribution, only if Node >=22 and npm are not available. The archive is verified against its HTTPS SHA-256 manifest, extracted into `.tools/node`, and exposed by `source scripts/env.sh`. The system Node installation is not changed. This pins a release; future security updates require maintaining that version.
- NVIDIA's `cuda-keyring` apt configuration for an explicitly supported OS, followed by `cuda-nvrtc-13-1`, `cuda-nvrtc-dev-13-1`, and `cuda-cudart-dev-13-1`. Dependencies include the matching NVRTC built-ins. Driver-pulling CUDA metapackages are not used. Compatible existing runtime/headers, including this project's cached headers, are reused.
- Lockfile-pinned npm dependencies with development dependencies included and install scripts disabled. Installation replaces the checkout's `node_modules`, matching normal `npm ci` behavior.

The setup process then builds, enumerates CUDA devices, runs Node tests, compares 10,000 full CUDA/CPU digests, and runs one short benchmark. A failure prevents a success message. Run `npm run test:gpu` separately for the full million-comparison gate.

## Platform boundaries

Automatic CUDA repositories: Ubuntu 22.04/24.04, Debian 12/13, and Ubuntu WSL using NVIDIA's `wsl-ubuntu` repository. Existing compatible dependencies can be used on other Linux x86-64 hosts. NVIDIA architectures unsupported by the installed CUDA compiler will fail compilation; AMD, Intel and Apple GPUs are unsupported.

For a missing Ubuntu host driver, `--install-driver` invokes `ubuntu-drivers install`, then stops for the operator to reboot if needed. Secure Boot enrollment or a cloud provider's host configuration can require manual action. Missing driver access on Debian is reported for the operator to resolve. WSL and containers never attempt host-driver installation, even with the flag.

`--check` is a prerequisite check, not a kernel compilation or performance test. A working `nvidia-smi` plus a driver library does not prove CUDA 13.1 compatibility. The actual build and CUDA verification are the final gate. No package installer can create GPU hardware or configure a provider's host from inside an isolated container.

Installation is not transactional: successfully installed packages remain if a later step fails. Correct the reported issue and rerun. Temporary downloads are removed on exit; downloaded Node and installed packages remain available. No wallet setup, signing, paid RPC service, mining transaction, GPU overclock or automatic reboot is performed.

## Sources

Checked 2026-09-12 against primary sources. Open WebSearch returned no results; direct official documentation retrieval was used. Documents are archived by the running Khiip daemon.

- [NVIDIA CUDA 13.1 Linux installation guide](https://docs.nvidia.com/cuda/archive/13.1.0/cuda-installation-guide-linux/index.html): supported distribution mappings and CUDA keyring/package installation.
- [NVIDIA WSL guide](https://docs.nvidia.com/cuda/wsl-user-guide/index.html): Windows-supplied GPU driver and avoiding Linux driver installation inside WSL.
- [Ubuntu NVIDIA driver installation](https://ubuntu.com/server/docs/how-to/graphics/install-nvidia-drivers/): recommended driver detection/installation with `ubuntu-drivers`.
- [Node 24.21.0 checksums](https://nodejs.org/dist/v24.21.0/SHASUMS256.txt): pinned Linux x64 archive verification. Its SHA-256 at implementation time is `fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6`.

## Verification

Shell syntax and isolated tests cover repository selection, WSL/container driver rejection, driver opt-in, reuse of compatible dependencies, inspection-only behavior, custom CUDA roots, verification ordering, and failure propagation. Real installation from an empty Ubuntu/Debian GPU rental remains untested. Local end-to-end setup evidence is recorded after validation in IMPLEMENTATION.md.
