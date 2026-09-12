import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/setup.sh", import.meta.url));
function shell(body) {
  return spawnSync("bash", ["-c", `source "$HASHCATS_SETUP_SCRIPT"\n${body}`], {
    env: { ...process.env, HASHCATS_SETUP_SCRIPT: script },
    encoding: "utf8",
    timeout: 5000,
  });
}

test("setup maps supported CUDA repositories and refuses guessed distro mappings", () => {
  const result = shell(`
    is_wsl() { return 1; }
    ID=ubuntu VERSION_ID=22.04; cuda_repo
    VERSION_ID=24.04; cuda_repo
    ID=debian VERSION_ID=12; cuda_repo
    VERSION_ID=13; cuda_repo
    ID=ubuntu VERSION_ID=26.04; if cuda_repo; then exit 99; fi
    ID=linuxmint VERSION_ID=22; if cuda_repo; then exit 99; fi
    ID=ubuntu; is_wsl() { return 0; }; cuda_repo
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n"), [
    "ubuntu2204",
    "ubuntu2404",
    "debian12",
    "debian13",
    "wsl-ubuntu",
  ]);
});

test("setup refuses driver installation inside WSL or containers even with opt-in", () => {
  for (const platform of ["wsl", "container"]) {
    const result = shell(`
      gpu_ready() { return 1; }
      is_wsl() { return ${platform === "wsl" ? 0 : 1}; }
      is_container() { return 0; }
      apt_install() { echo FORBIDDEN; }
      INSTALL_DRIVER=1
      ensure_gpu
    `);
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /FORBIDDEN/);
    assert.match(
      result.stderr,
      platform === "wsl" ? /NVIDIA Windows driver/ : /passthrough/,
    );
  }
});

test("setup requires explicit opt-in for Ubuntu driver changes and stops for reboot", () => {
  const prelude = `
    gpu_ready() { return 1; }
    is_wsl() { return 1; }
    is_container() { return 1; }
    apt_install() { echo "INSTALL $*"; }
    admin() { echo "ADMIN $*"; }
    ubuntu-drivers() { echo 'nvidia-driver-example recommended'; }
    ID=ubuntu
  `;
  const denied = shell(`${prelude}\nensure_gpu`);
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /--install-driver/);
  assert.doesNotMatch(denied.stdout, /INSTALL|ADMIN/);
  const allowed = shell(`${prelude}\nINSTALL_DRIVER=1\nensure_gpu`);
  assert.equal(allowed.status, 1);
  assert.match(allowed.stdout, /ADMIN ubuntu-drivers install/);
  assert.match(allowed.stderr, /Reboot this host/);
});

test("setup reuses working GPU, CUDA and Node without package changes", () => {
  const result = shell(`
    gpu_ready() { return 0; }
    node_ready() { return 0; }
    cuda_runtime_ready() { return 0; }
    cuda_headers_ready() { return 0; }
    admin() { exit 99; }; download() { exit 99; }; apt_install() { exit 99; }
    ensure_gpu; ensure_node; ensure_cuda
  `);
  assert.equal(result.status, 0, result.stderr);
});

test("setup check mode cannot invoke installer or project commands", () => {
  const result = shell(`
    check_dependencies() { echo 'MISSING: test dependency'; return 1; }
    ensure_gpu() { exit 99; }; apt_install() { exit 99; }; npm() { exit 99; }
    main --check --install-driver
  `);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /MISSING: test dependency/);
});

test("setup refuses to install into an incomplete custom CUDA root", () => {
  const result = shell(`
    HASHCATS_CUDA_ROOT=/custom/cuda
    cuda_runtime_ready() { return 1; }; cuda_headers_ready() { return 1; }
    admin() { exit 99; }; download() { exit 99; }
    ensure_cuda
  `);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Custom HASHCATS_CUDA_ROOT is incomplete/);
});

test("setup installs only explicit CUDA components through the selected official repository", () => {
  const result = shell(`
    HASHCATS_CUDA_ROOT=/usr/local/cuda-13.1
    ready=1
    cuda_runtime_ready() { return "$ready"; }; cuda_headers_ready() { return "$ready"; }
    cuda_repo() { echo ubuntu2404; }
    temporary_dir() { SETUP_TEMP=/test-only; }
    download() { echo "DOWNLOAD $1"; }
    admin() { echo "ADMIN $*"; }
    apt_install() { echo "INSTALL $*"; ready=0; }
    ensure_cuda
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /https:\/\/developer.download.nvidia.com\/compute\/cuda\/repos\/ubuntu2404\/x86_64\/cuda-keyring_1.1-1_all.deb/,
  );
  assert.match(
    result.stdout,
    /INSTALL cuda-nvrtc-13-1 cuda-nvrtc-dev-13-1 cuda-cudart-dev-13-1/,
  );
  assert.doesNotMatch(result.stdout, /cuda-drivers|cuda-toolkit/);
});

test("setup runs install, build, tests and offline GPU verification in sequence", () => {
  const result = shell(`
    ensure_gpu() { :; }; ensure_node() { :; }; ensure_cuda() { :; }
    has() { return 0; }; npm() { echo "NPM $*"; }
    main
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    result.stdout.split("\n").filter((line) => line.startsWith("NPM ")),
    [
      "NPM ci --ignore-scripts --include=dev",
      "NPM run build",
      "NPM start -- devices",
      "NPM test",
      "NPM run test:gpu -- 10000",
      "NPM run benchmark -- --seconds 3 --runs 1 --warmup-seconds 1",
    ],
  );
});

test("setup never reports completion after failed CUDA verification", () => {
  const result = shell(`
    ensure_gpu() { :; }; ensure_node() { :; }; ensure_cuda() { :; }
    has() { return 0; }
    npm() { if [[ "$*" == 'run test:gpu -- 10000' ]]; then return 7; fi; }
    main
  `);
  assert.equal(result.status, 7);
  assert.doesNotMatch(result.stdout, /Setup complete/);
});
