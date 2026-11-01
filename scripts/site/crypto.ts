/**
 * The one part of `node:crypto` the library calls, for the landing page's browser bundle:
 * `createHash("sha256").update(text | bytes).digest("hex")`, synchronous, as `src/ops.ts` needs it
 * for op fingerprints. WebCrypto's digest is asynchronous, so it cannot stand in. SHA-256 is
 * written from FIPS 180-4; test/site.test.ts checks it against `node:crypto`.
 */

function firstPrimes(count: number): number[] {
  const primes: number[] = [];
  for (let candidate = 2; primes.length < count; candidate++) {
    if (primes.every((prime) => candidate % prime !== 0)) primes.push(candidate);
  }
  return primes;
}

/** The first 32 bits of the fractional part of `x` (FIPS 180-4, sections 4.2.2 and 5.3.3). */
const fraction32 = (x: number): number => ((x - Math.floor(x)) * 2 ** 32) >>> 0;
const PRIMES = firstPrimes(64);
const K = PRIMES.map((prime) => fraction32(Math.cbrt(prime)));
const INITIAL = PRIMES.slice(0, 8).map((prime) => fraction32(Math.sqrt(prime)));

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

function sha256(message: Uint8Array): string {
  // Padding: a 1 bit, zeros, then the bit length as 64 bits, to a multiple of 512 bits.
  const blocks = Math.ceil((message.length + 9) / 64);
  const padded = new Uint8Array(blocks * 64);
  padded.set(message);
  padded[message.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bits = message.length * 8;
  view.setUint32(padded.length - 8, Math.floor(bits / 2 ** 32));
  view.setUint32(padded.length - 4, bits >>> 0);

  const hash = [...INITIAL];
  const w = new Array<number>(64).fill(0);
  for (let block = 0; block < blocks; block++) {
    for (let t = 0; t < 16; t++) w[t] = view.getUint32(block * 64 + t * 4);
    for (let t = 16; t < 64; t++) {
      const a = w[t - 15] ?? 0;
      const b = w[t - 2] ?? 0;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[t] = ((w[t - 16] ?? 0) + s0 + (w[t - 7] ?? 0) + s1) >>> 0;
    }
    let [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = hash;
    for (let t = 0; t < 64; t++) {
      const sum1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choose = (e & f) ^ (~e & g);
      const t1 = (h + sum1 + choose + (K[t] ?? 0) + (w[t] ?? 0)) >>> 0;
      const sum0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, h].forEach((value, i) => {
      hash[i] = ((hash[i] ?? 0) + value) >>> 0;
    });
  }
  return hash.map((word) => word.toString(16).padStart(8, "0")).join("");
}

export interface Hash {
  update(data: string | Uint8Array, encoding?: "utf8"): Hash;
  digest(encoding: "hex"): string;
}

export function createHash(algorithm: string): Hash {
  if (algorithm !== "sha256") throw new Error(`unsupported hash: ${algorithm}`);
  const chunks: Uint8Array[] = [];
  const hash: Hash = {
    update(data, encoding) {
      if (typeof data === "string" && encoding !== undefined && encoding !== "utf8") {
        throw new Error(`unsupported encoding: ${encoding}`);
      }
      chunks.push(typeof data === "string" ? new TextEncoder().encode(data) : data);
      return hash;
    },
    digest(encoding) {
      if (encoding !== "hex") throw new Error(`unsupported digest encoding: ${encoding}`);
      const message = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        message.set(chunk, offset);
        offset += chunk.length;
      }
      return sha256(message);
    },
  };
  return hash;
}
