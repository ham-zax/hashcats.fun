typedef unsigned long long u64;
#ifndef ROUND_UNROLL
#define ROUND_UNROLL 24
#endif

__device__ __forceinline__ u64 rotate(u64 value, int bits) {
  return bits == 0 ? value : (value << bits) | (value >> (64 - bits));
}

__device__ __forceinline__ u64 swap64(u64 value) {
  return ((u64)__byte_perm((unsigned)value, 0, 0x0123) << 32)
    | __byte_perm((unsigned)(value >> 32), 0, 0x0123);
}

__device__ __forceinline__ void keccak(u64* state) {
  const u64 rc[24] = {
    0x0000000000000001ULL,0x0000000000008082ULL,0x800000000000808aULL,0x8000000080008000ULL,
    0x000000000000808bULL,0x0000000080000001ULL,0x8000000080008081ULL,0x8000000000008009ULL,
    0x000000000000008aULL,0x0000000000000088ULL,0x0000000080008009ULL,0x000000008000000aULL,
    0x000000008000808bULL,0x800000000000008bULL,0x8000000000008089ULL,0x8000000000008003ULL,
    0x8000000000008002ULL,0x8000000000000080ULL,0x000000000000800aULL,0x800000008000000aULL,
    0x8000000080008081ULL,0x8000000000008080ULL,0x0000000080000001ULL,0x8000000080008008ULL
  };
  const int rotations[25] = {0,1,62,28,27,36,44,6,55,20,3,10,43,25,39,41,45,15,21,8,18,2,61,56,14};
  #pragma unroll ROUND_UNROLL
  for (int round = 0; round < 24; ++round) {
    u64 columns[5], delta[5], mixed[25];
    #pragma unroll
    for (int x = 0; x < 5; ++x) columns[x] = state[x] ^ state[x+5] ^ state[x+10] ^ state[x+15] ^ state[x+20];
    #pragma unroll
    for (int x = 0; x < 5; ++x) delta[x] = columns[(x+4)%5] ^ rotate(columns[(x+1)%5], 1);
    #pragma unroll
    for (int y = 0; y < 5; ++y) {
      #pragma unroll
      for (int x = 0; x < 5; ++x) mixed[y + 5*((2*x+3*y)%5)] = rotate(state[x+5*y] ^ delta[x], rotations[x+5*y]);
    }
    #pragma unroll
    for (int y = 0; y < 5; ++y) {
      #pragma unroll
      for (int x = 0; x < 5; ++x) state[x+5*y] = mixed[x+5*y] ^ ((~mixed[(x+1)%5+5*y]) & mixed[(x+2)%5+5*y]);
    }
    state[0] ^= rc[round];
  }
}

extern "C" __global__ void hash_one(const u64* input, u64* output) {
  u64 state[25];
  #pragma unroll
  for (int i=0; i<25; ++i) state[i] = input[i];
  keccak(state);
  #pragma unroll
  for (int i=0; i<4; ++i) output[i] = state[i];
}

extern "C" __global__ void search(const u64* __restrict__ input, const u64* __restrict__ target, u64 start,
                                  unsigned count, u64* __restrict__ output, int diagnostic) {
  const unsigned stride = blockDim.x * gridDim.x;
  for (unsigned index = blockIdx.x * blockDim.x + threadIdx.x; index < count; index += stride) {
    const u64 nonce = start + index;
    const u64 packed = swap64(nonce);
    u64 state[25];
    #pragma unroll
    for (int i=0; i<25; ++i) state[i] = input[i];
    state[5] = (state[5] & 0xffffffffULL) | (packed << 32);
    state[6] = (state[6] & 0xffffffff00000000ULL) | (packed >> 32);
    keccak(state);
    if (diagnostic) {
      #pragma unroll
      for (int i=0; i<4; ++i) output[index*4+i] = state[i];
      continue;
    }
    if (index == 0) {
      #pragma unroll
      for (int i=0; i<4; ++i) output[1+i] = state[i];
    }
    bool qualifies = false;
    #pragma unroll
    for (int i=0; i<4; ++i) {
      const u64 word = swap64(state[i]);
      if (word != target[i]) { qualifies = word < target[i]; break; }
    }
    if (qualifies) {
      const u64 slot = atomicAdd(output, 1ULL);
      if (slot < 64) {
        output[5+slot*5] = nonce;
        #pragma unroll
        for (int i=0; i<4; ++i) output[6+slot*5+i] = state[i];
      }
    }
  }
}
