#include <cuda.h>
#include <nvrtc.h>
#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <cstdlib>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

using Words = std::array<unsigned long long, 25>;
void check(CUresult result) {
  if (result == CUDA_SUCCESS) return;
  const char* message = nullptr;
  cuGetErrorString(result, &message);
  throw std::runtime_error(message ? message : "CUDA driver failure");
}
void rtc(nvrtcResult result) {
  if (result != NVRTC_SUCCESS) throw std::runtime_error(nvrtcGetErrorString(result));
}
int nibble(char value) {
  if (value >= '0' && value <= '9') return value-'0';
  if (value >= 'a' && value <= 'f') return value-'a'+10;
  if (value >= 'A' && value <= 'F') return value-'A'+10;
  throw std::runtime_error("Invalid hex input");
}
std::vector<unsigned char> unhex(const std::string& input, size_t length) {
  if (input.size() != length*2) throw std::runtime_error("Invalid hex input length");
  std::vector<unsigned char> output(length);
  for (size_t i=0; i<length; ++i) output[i] = (nibble(input[i*2]) << 4) | nibble(input[i*2+1]);
  return output;
}
std::string hex(const void* bytes, size_t length) {
  const auto* data = static_cast<const unsigned char*>(bytes);
  std::ostringstream out;
  out << "0x" << std::hex << std::setfill('0');
  for (size_t i=0; i<length; ++i) out << std::setw(2) << unsigned(data[i]);
  return out.str();
}
Words padded(const std::string& input) {
  const auto bytes = unhex(input, 116);
  Words words{};
  std::memcpy(words.data(), bytes.data(), bytes.size());
  auto* raw = reinterpret_cast<unsigned char*>(words.data());
  raw[116] = 1;
  raw[135] = 128;
  return words;
}

std::string deviceUuid(CUdevice device) {
  CUuuid uuid;
  check(cuDeviceGetUuid(&uuid, device));
  const std::string raw = hex(uuid.bytes, 16).substr(2);
  return "GPU-" + raw.substr(0,8) + "-" + raw.substr(8,4) + "-" + raw.substr(12,4)
    + "-" + raw.substr(16,4) + "-" + raw.substr(20);
}

int main(int argc, char** argv) {
  try {
    if (argc < 2 || argc > 3) throw std::runtime_error("Usage: hashcats-gpu --list | /path/to/keccak.cu [device-index]");
    check(cuInit(0));
    int deviceCount;
    check(cuDeviceGetCount(&deviceCount));
    if (std::string(argv[1]) == "--list") {
      std::cout << "[";
      for (int index=0; index<deviceCount; ++index) {
        CUdevice found;
        char name[256];
        check(cuDeviceGet(&found, index));
        check(cuDeviceGetName(name, sizeof(name), found));
        std::cout << (index ? "," : "") << "{\"index\":" << index << ",\"name\":" << std::quoted(name)
          << ",\"uuid\":\"" << deviceUuid(found) << "\"}";
      }
      std::cout << "]" << std::endl;
      return 0;
    }
    const std::string indexText = argc == 3 ? argv[2] : "0";
    if (indexText.empty() || indexText.find_first_not_of("0123456789") != std::string::npos)
      throw std::runtime_error("Invalid CUDA device index");
    const int deviceIndex = std::stoi(indexText);
    if (deviceIndex >= deviceCount) throw std::runtime_error("CUDA device index is not visible");
    std::ifstream file(argv[1]);
    if (!file) throw std::runtime_error("Cannot read CUDA source");
    const std::string source((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
    CUdevice device;
    check(cuDeviceGet(&device, deviceIndex));
    CUcontext context;
    check(cuDevicePrimaryCtxRetain(&context, device));
    check(cuCtxSetCurrent(context));
    int major, minor, processors;
    check(cuDeviceGetAttribute(&major, CU_DEVICE_ATTRIBUTE_COMPUTE_CAPABILITY_MAJOR, device));
    check(cuDeviceGetAttribute(&minor, CU_DEVICE_ATTRIBUTE_COMPUTE_CAPABILITY_MINOR, device));
    check(cuDeviceGetAttribute(&processors, CU_DEVICE_ATTRIBUTE_MULTIPROCESSOR_COUNT, device));
    char name[256];
    check(cuDeviceGetName(name, sizeof(name), device));
    nvrtcProgram program;
    rtc(nvrtcCreateProgram(&program, source.c_str(), "keccak.cu", 0, nullptr, nullptr));
    const std::string arch = "--gpu-architecture=sm_" + std::to_string(major) + std::to_string(minor);
    const std::string unroll = std::getenv("HASHCATS_UNROLL") ? std::getenv("HASHCATS_UNROLL") : "24";
    if (unroll != "1" && unroll != "2" && unroll != "4" && unroll != "8" && unroll != "24") throw std::runtime_error("HASHCATS_UNROLL must be 1,2,4,8 or 24");
    const std::string define = "-DROUND_UNROLL=" + unroll;
    const std::string regCount = std::getenv("HASHCATS_REGISTERS") ? std::getenv("HASHCATS_REGISTERS") : "80";
    if (regCount != "64" && regCount != "72" && regCount != "80" && regCount != "96" && regCount != "128") throw std::runtime_error("HASHCATS_REGISTERS must be 64,72,80,96 or 128");
    const std::string regOption = "--maxrregcount=" + regCount;
    const char* options[] = {arch.c_str(), "--std=c++17", "--device-as-default-execution-space", define.c_str(), regOption.c_str()};
    const auto compiled = nvrtcCompileProgram(program, 5, options);
    size_t logSize;
    rtc(nvrtcGetProgramLogSize(program, &logSize));
    std::string log(logSize, '\0');
    rtc(nvrtcGetProgramLog(program, log.data()));
    if (logSize > 1) std::cerr << log << '\n';
    rtc(compiled);
    size_t cubinSize;
    rtc(nvrtcGetCUBINSize(program, &cubinSize));
    std::vector<char> cubin(cubinSize);
    rtc(nvrtcGetCUBIN(program, cubin.data()));
    rtc(nvrtcDestroyProgram(&program));
    CUmodule module;
    check(cuModuleLoadData(&module, cubin.data()));
    CUfunction search, hashOne;
    check(cuModuleGetFunction(&search, module, "search"));
    check(cuModuleGetFunction(&hashOne, module, "hash_one"));
    CUdeviceptr input, target, output;
    check(cuMemAlloc(&input, sizeof(Words)));
    check(cuMemAlloc(&target, 32));
    check(cuMemAlloc(&output, 8192*32));
    int registers;
    check(cuFuncGetAttribute(&registers, CU_FUNC_ATTRIBUTE_NUM_REGS, search));
    std::cout << "{\"type\":\"ready\",\"device\":\"" << name << "\",\"sm\":" << major*10+minor
      << ",\"registers\":" << registers << ",\"deviceIndex\":" << deviceIndex
      << ",\"uuid\":\"" << deviceUuid(device) << "\"}" << std::endl;
    std::string line;
    while (std::getline(std::cin, line)) {
      if (line.size() > 2048) throw std::runtime_error("Oversized worker command");
      std::istringstream command(line);
      std::string operation, id, packed;
      if (!(command >> operation >> id >> packed)) throw std::runtime_error("Malformed command");
      if (id.find_first_not_of("0123456789") != std::string::npos) throw std::runtime_error("Invalid command id");
      const auto words = padded(packed);
      check(cuMemcpyHtoD(input, words.data(), sizeof(words)));
      if (operation == "HASH") {
        void* args[] = {&input, &output};
        check(cuLaunchKernel(hashOne, 1,1,1, 1,1,1, 0,nullptr,args,nullptr));
        std::array<unsigned long long,4> digest;
        check(cuMemcpyDtoH(digest.data(), output, 32));
        std::cout << "{\"type\":\"hash\",\"id\":" << id << ",\"hash\":\"" << hex(digest.data(),32) << "\"}" << std::endl;
        continue;
      }
      if (operation != "SEARCH" && operation != "DIGEST") throw std::runtime_error("Unknown worker operation");
      std::string targetHex;
      unsigned long long start;
      unsigned count, threads;
      if (!(command >> targetHex >> start >> count >> threads)) throw std::runtime_error("Malformed search command");
      int diagnostic = operation == "DIGEST";
      if (count == 0 || count > (1U<<26) || (diagnostic && count > 8192)
          || (threads != 128 && threads != 256)
          || start > std::numeric_limits<unsigned long long>::max()-(count-1)) throw std::runtime_error("Invalid nonce range or launch size");
      const auto bytes = unhex(targetHex,32);
      std::array<unsigned long long,4> targets{};
      for (size_t i=0; i<32; ++i) targets[i/8] = (targets[i/8]<<8) | bytes[i];
      check(cuMemcpyHtoD(target, targets.data(), 32));
      check(cuMemsetD8(output, 0, 325*8));
      const auto before = std::chrono::steady_clock::now();
      void* args[] = {&input,&target,&start,&count,&output,&diagnostic};
      const unsigned blocks = std::min((count+threads-1)/threads, static_cast<unsigned>(processors*16));
      check(cuLaunchKernel(search,blocks,1,1,threads,1,1,0,nullptr,args,nullptr));
      std::vector<unsigned long long> result(diagnostic ? count*4 : 325);
      check(cuMemcpyDtoH(result.data(), output, result.size()*8));
      const double ms = std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-before).count();
      std::cout << "{\"type\":\"" << (diagnostic ? "digests" : "batch") << "\",\"id\":" << id
        << ",\"count\":" << count << ",\"ms\":" << ms;
      if (diagnostic) {
        std::cout << ",\"digests\":[";
        for (unsigned i=0; i<count; ++i) std::cout << (i ? "," : "") << "\"" << hex(result.data()+i*4,32) << "\"";
      } else {
        std::cout << ",\"sample\":\"" << hex(result.data()+1,32) << "\",\"overflow\":"
          << (result[0]>64 ? "true" : "false") << ",\"candidates\":[";
        for (unsigned i=0; i<std::min(result[0],64ULL); ++i) std::cout << (i ? "," : "")
          << "{\"counter\":\"" << result[5+i*5] << "\",\"hash\":\"" << hex(result.data()+6+i*5,32) << "\"}";
      }
      std::cout << "]}" << std::endl;
    }
    check(cuMemFree(output)); check(cuMemFree(target)); check(cuMemFree(input));
    check(cuModuleUnload(module)); check(cuDevicePrimaryCtxRelease(device));
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "GPU worker: " << error.what() << std::endl;
    return 1;
  }
}
