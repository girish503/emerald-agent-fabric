/**
 * Emerald Agent Fabric — Browser Web Crypto Adapter (Milestone 2.27 / Phase 5)
 *
 * Provides a 100% browser-compatible, zero-dependency SHA-256 cryptographic hash
 * implementation conforming to FIPS 180-4 / RFC 6234.
 *
 * Why:
 * Transitive type and schema contracts from the backend domain kernel import "node:crypto".
 * When compiled for the browser, standard browsers lack the Node.js runtime module.
 * This adapter guarantees that:
 * 1. The browser bundle is completely self-contained with ZERO Node.js runtime imports.
 * 2. Cryptographic hashing is fully functional and produces true SHA-256 digests identical to node:crypto.
 * 3. Never uses dummy, mock, or weakened cryptographic implementations.
 */

/**
 * Standard SHA-256 constants (initial hash values H0-H7).
 */
const H_INIT = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

/**
 * SHA-256 round constants (first 32 bits of fractional parts of cube roots of first 64 primes).
 */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(n: number, b: number): number {
  return (n >>> b) | (n << (32 - b));
}

export class WebHash {
  readonly algorithm: string;
  private buffer: Uint8Array;
  private length = 0;

  constructor(algorithm = "sha256") {
    this.algorithm = algorithm;
    if (algorithm.toLowerCase() !== "sha256") {
      throw new Error(`WebHash: unsupported algorithm '${algorithm}'. Only 'sha256' is supported in browser runtime.`);
    }
    this.buffer = new Uint8Array(64);
  }

  update(data: string | Uint8Array): this {
    let bytes: Uint8Array;
    if (typeof data === "string") {
      bytes = new TextEncoder().encode(data);
    } else {
      bytes = data;
    }

    const newBuf = new Uint8Array(this.length + bytes.length);
    newBuf.set(this.buffer.subarray(0, this.length), 0);
    newBuf.set(bytes, this.length);
    this.buffer = newBuf;
    this.length += bytes.length;
    return this;
  }

  digest(encoding: "hex" | "binary" = "hex"): string | Uint8Array {
    const totalBytes = this.length;
    const totalBits = totalBytes * 8;

    // Padding: message + 0x80 + zeroes + 64-bit big-endian length
    const padLen = (totalBytes % 64 < 56) ? (56 - (totalBytes % 64)) : (120 - (totalBytes % 64));
    const padded = new Uint8Array(totalBytes + padLen + 8);
    padded.set(this.buffer.subarray(0, totalBytes), 0);
    padded[totalBytes] = 0x80;

    // Big-endian 64-bit integer bit length
    const view = new DataView(padded.buffer);
    const highBits = Math.floor(totalBits / 0x100000000);
    const lowBits = totalBits >>> 0;
    view.setUint32(padded.length - 8, highBits, false);
    view.setUint32(padded.length - 4, lowBits, false);

    const H = new Uint32Array(H_INIT);
    const W = new Uint32Array(64);

    for (let offset = 0; offset < padded.length; offset += 64) {
      for (let i = 0; i < 16; i++) {
        W[i] = view.getUint32(offset + i * 4, false);
      }
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(W[i - 15]!, 7) ^ rotr(W[i - 15]!, 18) ^ (W[i - 15]! >>> 3);
        const s1 = rotr(W[i - 2]!, 17) ^ rotr(W[i - 2]!, 19) ^ (W[i - 2]! >>> 10);
        W[i] = (W[i - 16]! + s0 + W[i - 7]! + s1) >>> 0;
      }

      let a = H[0]!;
      let b = H[1]!;
      let c = H[2]!;
      let d = H[3]!;
      let e = H[4]!;
      let f = H[5]!;
      let g = H[6]!;
      let h = H[7]!;

      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const temp1 = (h + S1 + ch + K[i]! + W[i]!) >>> 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (S0 + maj) >>> 0;

        h = g;
        g = f;
        f = e;
        e = (d + temp1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (temp1 + temp2) >>> 0;
      }

      H[0] = (H[0]! + a) >>> 0;
      H[1] = (H[1]! + b) >>> 0;
      H[2] = (H[2]! + c) >>> 0;
      H[3] = (H[3]! + d) >>> 0;
      H[4] = (H[4]! + e) >>> 0;
      H[5] = (H[5]! + f) >>> 0;
      H[6] = (H[6]! + g) >>> 0;
      H[7] = (H[7]! + h) >>> 0;
    }

    const outBytes = new Uint8Array(32);
    const outView = new DataView(outBytes.buffer);
    for (let i = 0; i < 8; i++) {
      outView.setUint32(i * 4, H[i]!, false);
    }

    if (encoding === "hex") {
      let hex = "";
      for (let i = 0; i < 32; i++) {
        hex += outBytes[i]!.toString(16).padStart(2, "0");
      }
      return hex;
    }

    return outBytes;
  }
}

/**
 * Node.js-compatible createHash factory function for browser execution.
 */
export function createHash(algorithm = "sha256"): WebHash {
  return new WebHash(algorithm);
}

export default {
  createHash,
};
