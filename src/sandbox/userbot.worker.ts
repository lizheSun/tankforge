// 用户策略沙箱 Worker：隔离执行 decide(ctx)，仅接收结构化 ctx，无 DOM / 网络
import type { Action, Ctx } from '../game/types';

interface Req {
  reqId: number;
  code: string;
  // 主线程剥离了 rng（函数不可克隆），此处为可空
  ctx: Omit<Ctx, 'rng'> & { rng?: undefined };
}
interface Resp {
  reqId: number;
  actions: Action[];
  error: string | null;
  durationMs: number;
}

let cached: { code: string; decide: (ctx: Ctx) => unknown } | null = null;

/**
 * 两段式（与服务端 vmScriptDriver 语义一致）：
 * 顶层代码只执行一次（提取 decide 引用），之后每帧只调用 decide(ctx)。
 * 关键：decide 闭包引用的顶层变量（如模型的目击记忆 MEM）跨决策帧保持。
 * （历史实现把「执行整个顶层 + 调 decide」放进同一个函数体，导致顶层状态每帧被重置，
 *  与服务端 vm 沙箱行为不一致 —— 任何带顶层状态的脚本前后端会产生分歧。）
 */
function extractDecide(code: string): (ctx: Ctx) => unknown {
  if (cached && cached.code === code) return cached.decide;
  const boot = new Function(`${code}\n;return typeof decide === 'function' ? decide : null;`) as
    () => ((ctx: Ctx) => unknown) | null;
  const decide = boot();
  if (typeof decide !== 'function') throw new Error('未定义 decide(ctx) 函数');
  cached = { code, decide };
  return decide;
}

/** 确定性 PRNG（mulberry32）：种子 = 坦克 id + 决策帧 tick，重演同局时序列一致 */
function makeRng(seedStr: string): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

self.onmessage = (e: MessageEvent<Req>) => {
  const { reqId, code, ctx } = e.data;
  const t0 = performance.now();
  try {
    const decide = extractDecide(code);
    // 重建被剥离的确定性 rng
    const ctxFull = { ...ctx, rng: makeRng(`${ctx.self?.id ?? '?'}|${ctx.tick ?? 0}`) } as Ctx;
    const raw = decide(ctxFull);
    const actions: Action[] = Array.isArray(raw) ? (raw as Action[]) : [];
    self.postMessage({ reqId, actions, error: null, durationMs: performance.now() - t0 } satisfies Resp);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    self.postMessage({ reqId, actions: [], error: msg, durationMs: performance.now() - t0 } satisfies Resp);
  }
};

export {};
