import type { Action, Ctx } from '../game/types';

export interface ScriptHandle {
  name: string;
  kind: 'script';
  decide(ctx: Ctx): Promise<Action[]>;
  dispose(): void;
  /** worker 是否发生无法恢复的崩溃（线程中断） */
  crashed: boolean;
}

/**
 * 用户脚本 driver：每个坦克一个专用 Worker。
 * 说明：Worker 无法被外部硬性中断死循环，runner 侧对决策 Promise 做 100ms 超时
 *      （超时该帧 NOOP，连续 30 tick 无响应计 1 次 sanction，累计 100 次判失联）；
 *      若 Worker 线程因死循环无法响应，将在对局结束后由 UI 回收。生产环境改用 QuickJS-WASM。
 * ctx 中的 rng 是函数、无法结构化克隆：发送前剥离，由 worker 侧用 (坦克id, 帧tick)
 * 重建确定性 PRNG —— 同种子对局重演时序列完全一致。
 */
export function createScriptDriver(name: string, code: string): ScriptHandle {
  let worker: Worker | null = null;
  let reqSeq = 0;
  let disposed = false;
  let crashed = false;
  const waiters = new Map<number, { resolve: (a: Action[]) => void; reject: (e: Error) => void }>();

  function ensureWorker(): Worker {
    if (worker) return worker;
    worker = new Worker(new URL('./userbot.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ reqId: number; actions: Action[]; error: string | null }>) => {
      const w = waiters.get(e.data.reqId);
      if (!w) return;
      waiters.delete(e.data.reqId);
      if (e.data.error) w.reject(new Error(e.data.error));
      else w.resolve(e.data.actions ?? []);
    };
    worker.onerror = (e) => {
      // 线程级崩溃：标记并回收，后续 decide 不再向死线程投递（走 runner 超时/失联路径）
      crashed = true;
      for (const w of waiters.values()) w.reject(new Error(e.message || 'worker 异常'));
      waiters.clear();
      worker?.terminate();
      worker = null;
    };
    return worker;
  }

  return {
    name,
    kind: 'script',
    decide(ctx: Ctx) {
      if (disposed) return Promise.reject(new Error('脚本已被回收'));
      const w = ensureWorker();
      const reqId = ++reqSeq;
      return new Promise<Action[]>((resolve, reject) => {
        waiters.set(reqId, { resolve, reject });
        // rng 是函数无法克隆：置空传输，worker 侧重建
        w.postMessage({ reqId, code, ctx: { ...ctx, rng: undefined } });
      });
    },
    dispose() {
      disposed = true;
      for (const w of waiters.values()) w.reject(new Error('脚本已被回收'));
      waiters.clear();
      worker?.terminate();
      worker = null;
    },
    get crashed() {
      return crashed;
    },
  };
}
