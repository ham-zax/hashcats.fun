#!/usr/bin/env bash
# Repeatable Linux installer. Sourcing exposes functions for isolated tests only.
set -euo pipefail

SETUP_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_VERSION=24.21.0
CHECK_ONLY=0
INSTALL_DRIVER=0
APT_UPDATED=0
SETUP_TEMP=""

say() { printf '%s\n' "$*"; }
fail() { say "Setup stopped: $*" >&2; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }
is_wsl() { grep -qi microsoft /proc/sys/kernel/osrelease; }
is_container() {
  [[ -f /.dockerenv || -f /run/.containerenv ]] ||
    grep -qE '(docker|containerd|kubepods|lxc)' /proc/1/cgroup
}
admin() {
  if (( EUID == 0 )); then "$@";
  elif has sudo; then sudo -- "$@";
  else fail "Installing system dependencies requires root or sudo. Ask the host administrator to install them.";
  fi
}
apt_install() {
  has apt-get || fail "Automatic system installation requires apt-get. Install the reported dependencies manually on this OS."
  if (( ! APT_UPDATED )); then admin apt-get update; APT_UPDATED=1; fi
  say "Installing system packages: $*"
  admin apt-get install -y --no-install-recommends "$@"
}
download() { curl --fail --location --show-error --silent --proto '=https' --tlsv1.2 --retry 2 --connect-timeout 20 --max-time 600 "$1" -o "$2"; }
temporary_dir() {
  if [[ -z "$SETUP_TEMP" ]]; then SETUP_TEMP="$(mktemp -d -t hashcats-setup.XXXXXXXX)"; fi
}
cleanup() {
  # Only delete the exact mktemp-created directory, never a user-supplied path.
  if [[ -n "$SETUP_TEMP" && -d "$SETUP_TEMP" ]]; then rm -rf -- "$SETUP_TEMP"; fi
}
node_ready() {
  has node && has npm && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' >/dev/null 2>&1
}
driver_library() {
  local candidate
  if [[ -n "${HASHCATS_CUDA_DRIVER:-}" ]]; then
    [[ -f "$HASHCATS_CUDA_DRIVER" ]] || return 1
    printf '%s\n' "$HASHCATS_CUDA_DRIVER"; return 0
  fi
  for candidate in /usr/lib/wsl/lib/libcuda.so.1 /usr/lib/x86_64-linux-gnu/libcuda.so.1 /usr/lib64/libcuda.so.1 /usr/local/nvidia/lib64/libcuda.so.1; do
    if [[ -f "$candidate" ]]; then printf '%s\n' "$candidate"; return 0; fi
  done
  return 1
}
gpu_ready() {
  local smi=nvidia-smi devices
  if ! has "$smi" && [[ -x /usr/lib/wsl/lib/nvidia-smi ]]; then smi=/usr/lib/wsl/lib/nvidia-smi; fi
  devices="$("$smi" --query-gpu=name --format=csv,noheader 2>/dev/null)" || return 1
  [[ -n "$devices" ]] && driver_library >/dev/null
}
cuda_runtime_ready() {
  local lib="$HASHCATS_CUDA_ROOT/targets/x86_64-linux/lib"
  compgen -G "$lib/libnvrtc.so.[0-9]*" >/dev/null &&
    compgen -G "$lib/libnvrtc-builtins.so*" >/dev/null
}
cuda_headers_ready() {
  local include="$HASHCATS_CUDA_ROOT/targets/x86_64-linux/include"
  [[ -f "$include/cuda.h" && -f "$include/nvrtc.h" ]] || {
    include="$SETUP_ROOT/.cuda/usr/local/cuda-13.1/targets/x86_64-linux/include"
    [[ -f "$include/cuda.h" && -f "$include/nvrtc.h" ]]
  }
}
cuda_repo() {
  if is_wsl && [[ "$ID" == ubuntu ]]; then say wsl-ubuntu; return; fi
  case "$ID:$VERSION_ID" in
    ubuntu:22.04) say ubuntu2204 ;;
    ubuntu:24.04) say ubuntu2404 ;;
    debian:12) say debian12 ;;
    debian:13) say debian13 ;;
    *) return 1 ;;
  esac
}
ensure_node() {
  node_ready && return 0
  [[ ! -e "$SETUP_ROOT/.tools/node" ]] || fail "The local .tools/node installation is incomplete or incompatible. Move it aside and rerun setup."
  temporary_dir
  local archive="node-v${NODE_VERSION}-linux-x64.tar.xz" base="https://nodejs.org/dist/v${NODE_VERSION}" checksum
  say "Installing Node $NODE_VERSION into .tools/node (your system Node is unchanged)."
  download "$base/SHASUMS256.txt" "$SETUP_TEMP/SHASUMS256.txt"
  checksum="$(awk -v file="$archive" '$2 == file {print $1}' "$SETUP_TEMP/SHASUMS256.txt")"
  [[ "$checksum" =~ ^[a-f0-9]{64}$ ]] || fail "Node checksum manifest does not contain the expected archive."
  download "$base/$archive" "$SETUP_TEMP/$archive"
  (cd -- "$SETUP_TEMP" && printf '%s  %s\n' "$checksum" "$archive" | sha256sum --check --status) || fail "Node download checksum mismatch."
  mkdir -p -- "$SETUP_TEMP/node" "$SETUP_ROOT/.tools"
  tar -xJf "$SETUP_TEMP/$archive" --strip-components=1 -C "$SETUP_TEMP/node"
  mv -- "$SETUP_TEMP/node" "$SETUP_ROOT/.tools/node"
  export PATH="$SETUP_ROOT/.tools/node/bin:$PATH"
  node_ready || fail "Downloaded Node cannot run on this host. Check the host architecture and glibc version."
}
ensure_cuda() {
  if cuda_runtime_ready && cuda_headers_ready; then return 0; fi
  [[ "$HASHCATS_CUDA_ROOT" == /usr/local/cuda-13.1 ]] || fail "Custom HASHCATS_CUDA_ROOT is incomplete: $HASHCATS_CUDA_ROOT. Fix it or unset the override to install CUDA 13.1."
  local repo packages=(cuda-nvrtc-13-1 cuda-nvrtc-dev-13-1 cuda-cudart-dev-13-1)
  repo="$(cuda_repo)" || fail "No supported CUDA 13.1 apt repository mapping for $ID $VERSION_ID. Use Ubuntu 22.04/24.04, Debian 12/13, Ubuntu WSL, or provision CUDA manually."
  temporary_dir
  download "https://developer.download.nvidia.com/compute/cuda/repos/$repo/x86_64/cuda-keyring_1.1-1_all.deb" "$SETUP_TEMP/cuda-keyring.deb"
  admin dpkg -i "$SETUP_TEMP/cuda-keyring.deb"
  APT_UPDATED=0
  # Explicit components avoid CUDA metapackages that can pull in host drivers.
  apt_install "${packages[@]}"
  cuda_runtime_ready && cuda_headers_ready || fail "CUDA runtime/headers are still missing under $HASHCATS_CUDA_ROOT."
}
ensure_gpu() {
  gpu_ready && return 0
  if is_wsl; then
    fail "WSL cannot access the NVIDIA GPU/driver. Install or update the NVIDIA Windows driver, enable WSL2 GPU access, then rerun setup. Never install a Linux display driver inside WSL. See https://docs.nvidia.com/cuda/wsl-user-guide/index.html"
  fi
  if is_container; then
    fail "GPU access is missing inside this container. The host needs a working NVIDIA driver and GPU passthrough (for Docker, NVIDIA Container Toolkit and --gpus all). Rerun setup after the provider/host exposes the GPU."
  fi
  if (( ! INSTALL_DRIVER )); then
    fail "NVIDIA GPU access or libcuda.so.1 is missing. On an Ubuntu host, rerun with --install-driver to install its recommended driver. For a custom library path, set HASHCATS_CUDA_DRIVER."
  fi
  [[ "$ID" == ubuntu ]] || fail "Automatic host-driver installation is supported only on Ubuntu. Install the recommended NVIDIA driver for your OS, then rerun setup."
  apt_install ubuntu-drivers-common
  local recommended
  recommended="$(ubuntu-drivers devices)"
  [[ "$recommended" == *recommended* ]] || fail "Ubuntu detected no recommended NVIDIA driver. Check that a supported NVIDIA GPU is attached."
  admin ubuntu-drivers install
  fail "Driver installation completed. Reboot this host if required, then rerun setup. This script does not reboot automatically."
}
check_dependencies() {
  local missing=0
  if node_ready; then say "OK: Node and npm"; else say "MISSING: Node >=22 and npm"; missing=1; fi
  local tool
  for tool in g++ make curl tar xz sha256sum; do
    if has "$tool"; then say "OK: $tool"; else say "MISSING: $tool"; missing=1; fi
  done
  if gpu_ready; then say "OK: NVIDIA device and driver library"; else say "MISSING: NVIDIA GPU access or driver library"; missing=1; fi
  if cuda_runtime_ready; then say "OK: CUDA NVRTC runtime and built-ins"; else say "MISSING: CUDA NVRTC runtime/built-ins"; missing=1; fi
  if cuda_headers_ready; then say "OK: CUDA headers"; else say "MISSING: CUDA development headers"; missing=1; fi
  return "$missing"
}
main() {
  local option
  for option in "$@"; do
    case "$option" in
      --check) CHECK_ONLY=1 ;;
      --install-driver) INSTALL_DRIVER=1 ;;
      --help|-h)
        say 'Usage: bash scripts/setup.sh [--check] [--install-driver]'
        say 'Default: install missing dependencies, install npm packages, build, test and benchmark.'
        say '--check: inspect dependencies only; no downloads, installs, builds or GPU hashing.'
        say '--install-driver: also allow a missing NVIDIA host driver to be installed on Ubuntu.'
        return ;;
      *) fail "Unknown option: $option" ;;
    esac
  done
  [[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || fail "This installer supports Linux x86-64, including WSL2. NVIDIA CUDA GPUs only."
  # OS-owned metadata; do not infer an Ubuntu repository for derivative distributions.
  ID=unknown VERSION_ID=unknown
  if [[ -r /etc/os-release ]]; then source /etc/os-release; fi
  source "$SETUP_ROOT/scripts/env.sh"
  say "Hashcats setup: $ID $VERSION_ID, NVIDIA CUDA, $HASHCATS_CUDA_ROOT"
  if (( CHECK_ONLY )); then check_dependencies; return; fi
  ensure_gpu
  local packages=()
  has g++ && has make || packages+=(build-essential)
  has curl || packages+=(curl)
  [[ -s /etc/ssl/certs/ca-certificates.crt ]] || packages+=(ca-certificates)
  has tar || packages+=(tar)
  has xz || packages+=(xz-utils)
  has sha256sum || packages+=(coreutils)
  if (( ${#packages[@]} )); then apt_install "${packages[@]}"; fi
  ensure_node
  ensure_cuda
  cd -- "$SETUP_ROOT"
  say 'Installing project dependencies and building the native worker...'
  npm ci --ignore-scripts --include=dev
  npm run build
  npm start -- devices
  npm test
  say 'Checking 10,000 CUDA hashes against the CPU reference on visible GPUs...'
  npm run test:gpu -- 10000
  say 'Running a short offline benchmark (no wallet or transactions)...'
  npm run benchmark -- --seconds 3 --runs 1 --warmup-seconds 1
  say 'Setup complete. This checks local mining; chain connectivity and wallet funding are separate.'
  printf 'For subsequent commands in this shell, run: source %q\n' "$SETUP_ROOT/scripts/env.sh"
  say 'Next: npm run wallet -- create (or import), then npm start -- status.'
  say 'For the full CUDA correctness check: npm run test:gpu'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  trap cleanup EXIT
  main "$@"
fi
