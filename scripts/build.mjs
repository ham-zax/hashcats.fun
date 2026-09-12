import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const cuda = process.env.HASHCATS_CUDA_ROOT ?? "/usr/local/cuda-13.1";
const lib = join(cuda, "targets/x86_64-linux/lib");
const library = readdirSync(lib).find((name) =>
  /^libnvrtc\.so\.\d+$/.test(name),
);
if (!library)
  throw new Error(`NVRTC not found in ${lib}; set HASHCATS_CUDA_ROOT`);
let include = join(cuda, "targets/x86_64-linux/include");
const cachedInclude = join(
  root,
  ".cuda/usr/local/cuda-13.1/targets/x86_64-linux/include",
);
if (
  (!existsSync(join(include, "cuda.h")) ||
    !existsSync(join(include, "nvrtc.h"))) &&
  existsSync(join(cachedInclude, "cuda.h")) &&
  existsSync(join(cachedInclude, "nvrtc.h"))
)
  include = cachedInclude;
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error || result.status !== 0)
    throw result.error ?? new Error(`${command} exited ${result.status}`);
}
if (
  !existsSync(join(include, "cuda.h")) ||
  !existsSync(join(include, "nvrtc.h"))
) {
  const cache = join(root, ".cuda");
  const packages = join(cache, "packages");
  mkdirSync(packages, { recursive: true });
  console.log(
    "Fetching matching CUDA 13.1 development packages into .cuda/ (no sudo).",
  );
  run(
    "apt-get",
    ["download", "cuda-cudart-dev-13-1", "cuda-nvrtc-dev-13-1"],
    packages,
  );
  for (const name of readdirSync(packages).filter((name) =>
    name.endsWith(".deb"),
  )) {
    run("dpkg-deb", ["-x", join(packages, name), cache]);
  }
  include = join(cache, "usr/local/cuda-13.1/targets/x86_64-linux/include");
}
const driver =
  process.env.HASHCATS_CUDA_DRIVER ??
  [
    "/usr/lib/wsl/lib/libcuda.so.1",
    "/usr/lib/x86_64-linux-gnu/libcuda.so.1",
    "/usr/lib64/libcuda.so.1",
    "/usr/local/nvidia/lib64/libcuda.so.1",
  ].find(existsSync);
if (!driver || !existsSync(driver))
  throw new Error(`Set HASHCATS_CUDA_DRIVER to your libcuda.so.1 path`);
mkdirSync(join(root, "build"), { recursive: true });
run("g++", [
  "-std=c++17",
  "-O3",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-I",
  include,
  resolve(root, "native/worker.cpp"),
  driver,
  join(lib, library),
  `-Wl,-rpath,${lib}`,
  `-Wl,-rpath,${resolve(driver, "..")}`,
  "-o",
  join(root, "build/hashcats-gpu"),
]);
console.log("Built build/hashcats-gpu");
