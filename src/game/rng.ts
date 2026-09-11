// 确定性 PRNG：xoshiro256**（引擎唯一随机源，杜绝 Math.random）
export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(seed: number) {
    // 使用 mulberry32 风格展开 4 个 32bit state（实现无关，仅需确定性）
    let a = seed >>> 0 || 0x9e3779b9;
    const nxt = () => {
      a += 0x6d2b79f5;
      let z = a;
      z = Math.imul(z ^ (z >>> 15), z | 1);
      z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
      return ((z ^ (z >>> 14)) >>> 0);
    };
    this.s0 = nxt();
    this.s1 = nxt();
    this.s2 = nxt();
    this.s3 = nxt();
  }

  private rotl(x: number, k: number): number {
    return ((x << k) | (x >>> (32 - k))) >>> 0;
  }

  /** [0,1) */
  next(): number {
    const s0 = this.s0;
    let s1 = this.s1;
    const res = Math.imul(this.rotl(Math.imul(s1, 5), 7) * 9, 0x9e3779b1) >>> 0;
    const t = Math.imul(s1 << 9, 0x94d049bb) >>> 0;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = this.rotl(this.s3, 11);
    return (res >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** 高斯近似（中心极限 3 次），std 单位 */
  gauss(std: number): number {
    return (this.next() + this.next() + this.next() - 1.5) * (std * 2);
  }

  int(min: number, maxInclusive: number): number {
    return Math.floor(this.range(min, maxInclusive + 1));
  }
}
