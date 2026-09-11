// ============================================================
// TANKFORGE · 用户策略代码静态诊断
// 与 userbot.worker 使用同一编译体（new Function），提前暴露语法/结构错误
// ============================================================

export interface Diag {
  ok: boolean;
  message: string;
  line?: number;
}

export function compileBody(code: string): string {
  // 与沙箱 worker 完全一致的编译体
  return `${code}\n;return typeof decide === 'function';`;
}

function errLine(e: unknown): number | undefined {
  const msg = e instanceof Error ? e.stack || e.message : String(e);
  // new Function 的 SyntaxError 栈形如 "at <anonymous>:LINE:COL"
  const m = /<anonymous>:(\d+)/.exec(msg);
  if (!m) return undefined;
  const ln = Number(m[1]);
  // 第 1 行是我们的注入语句本身时会多计 1，尽力贴近用户代码行号
  return Math.max(1, ln - 1);
}

export function diagnoseCode(code: string): Diag {
  try {
    const fn = new Function('ctx', compileBody(code)) as () => unknown;
    const hasDecide = fn();
    return hasDecide
      ? { ok: true, message: '语法通过 · decide(ctx) 已就绪' }
      : { ok: false, message: '未定义顶层函数 decide(ctx)' };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e), line: errLine(e) };
  }
}
