#!/usr/bin/env bash
# Source this file after setup when Node was installed inside the checkout.
HASHCATS_REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -x "$HASHCATS_REPO_ROOT/.tools/node/bin/node" ]]; then
  export PATH="$HASHCATS_REPO_ROOT/.tools/node/bin:$PATH"
fi
export HASHCATS_CUDA_ROOT="${HASHCATS_CUDA_ROOT:-/usr/local/cuda-13.1}"
