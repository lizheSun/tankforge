// ------------------------------------------------------------
// 模型策略（RL）大脑：平台定义标准观测/动作空间，模型 JSON 编译为自包含 decide 代码
// 设计要点：
//  - 动作 18 选 1（argmax），炮塔由平台辅助瞄准（带提前量）
//  - 观测双版本：v1 = 20 维无记忆（历史兼容）；v2 = 24 维带目击记忆
//    （敌不可见时 [20..23] 指向上次目击点，模型可导航搜索，破解"原地绕圈"退化）
//  - 编译产物是纯 JS（无 Date/random/import）→ Worker 与服务端 vm 逐帧一致，回放确定性不受影响
//    （v2 的 MEM 为顶层状态，依赖执行端"顶层只执行一次"的两段式语义）
// ------------------------------------------------------------
import type { Action, Ctx } from './types';

export const OBS_DIM_V1 = 20;
export const OBS_DIM = 24; // v2 = v1 + 4 维目击记忆（敌不可见时仍可导航至上次目击点）
export const ACTION_DIM = 18;

export interface ModelLayer {
  out: number;
  /** 行主序 [out][in] */
  w: number[];
  b: number[];
}

export interface ModelJson {
  format: 'tankforge-model';
  /** 1 = 20 维无记忆观测；2 = 24 维带目击记忆观测 */
  version: 1 | 2;
  activation: 'tanh' | 'relu';
  layers: ModelLayer[];
  notes?: string;
}

/** 校验模型：合法返回 null，否则返回错误信息 */
export function validateModelJson(m: unknown): string | null {
  if (!m || typeof m !== 'object') return '必须是 JSON 对象';
  const o = m as Partial<ModelJson>;
  if (o.format !== 'tankforge-model') return 'format 必须为 "tankforge-model"';
  if (o.version !== 1 && o.version !== 2) return '仅支持 version 1（20 维）或 2（24 维带记忆）';
  if (o.activation !== 'tanh' && o.activation !== 'relu') return 'activation 必须为 tanh 或 relu';
  if (!Array.isArray(o.layers) || o.layers.length < 1) return '至少需要 1 层全连接层';
  let inDim = o.version === 1 ? OBS_DIM_V1 : OBS_DIM;
  let params = 0;
  for (let i = 0; i < o.layers!.length; i++) {
    const L = o.layers![i] as Partial<ModelLayer>;
    if (typeof L.out !== 'number' || !Number.isInteger(L.out) || L.out < 1 || L.out > 1024)
      return `第 ${i + 1} 层 out 非法（1~1024）`;
    if (!Array.isArray(L.w) || !Array.isArray(L.b)) return `第 ${i + 1} 层缺少 w/b 数组`;
    if (L.b!.length !== L.out) return `第 ${i + 1} 层 b 长度应为 ${L.out}`;
    if (L.w!.length !== inDim * L.out) return `第 ${i + 1} 层 w 长度应为 ${inDim}×${L.out}=${inDim * L.out}`;
    if (L.w!.some((x) => !Number.isFinite(x)) || L.b!.some((x) => !Number.isFinite(x)))
      return `第 ${i + 1} 层存在非数值权重`;
    params += L.w!.length + L.b!.length;
    inDim = L.out;
  }
  if (inDim !== ACTION_DIM) return `最后一层输出必须为 ${ACTION_DIM}（动作空间）`;
  if (params > 400_000) return `参数量过大（${params} > 400k）`;
  return null;
}

export function modelParams(m: ModelJson): number {
  return m.layers.reduce((s, L) => s + L.w.length + L.b.length, 0);
}

// ---------------- 观测构建 ----------------

function nearestEnemy(ctx: Ctx) {
  return ctx.view.enemies.slice().sort((a, b) => a.dist - b.dist)[0] ?? null;
}

/** v1 观测向量（20 维，无记忆；顺序与导出脚本/文档严格一致，勿改顺序） */
export function buildObsV1(ctx: Ctx): number[] {
  const s = ctx.self;
  const e = nearestEnemy(ctx);
  const rad = Math.PI / 180;
  const o = new Array<number>(OBS_DIM_V1).fill(0);
  o[0] = s.hp / s.maxHp;
  o[1] = s.cooldownMs / s.stats.fireIntervalMs;
  o[2] = Math.sin(s.heading * rad);
  o[3] = Math.cos(s.heading * rad);
  o[4] = Math.sin(s.turret * rad);
  o[5] = Math.cos(s.turret * rad);
  if (e) {
    o[6] = 1;
    o[7] = (e.pos.x - s.pos.x) / 600;
    o[8] = (e.pos.y - s.pos.y) / 400;
    o[9] = Math.min(2, e.dist / s.stats.viewRadius);
    o[10] = Math.sin(e.heading * rad);
    o[11] = Math.cos(e.heading * rad);
    const v = e.vel ?? { dx: 0, dy: 0 };
    o[12] = Math.max(-1.5, Math.min(1.5, v.dx / 240));
    o[13] = Math.max(-1.5, Math.min(1.5, v.dy / 240));
    o[14] = Math.min(1, e.hp / 190);
    const bearing = Math.atan2(e.pos.y - s.pos.y, e.pos.x - s.pos.x) / rad;
    let d = bearing - s.turret;
    while (d > 180) d -= 360;
    while (d <= -180) d += 360;
    o[15] = d / 180;
  } else {
    o[9] = 2;
  }
  o[16] = Math.min(1, ctx.timeLeftMs / 90000);
  o[17] = s.pos.x / 1200;
  o[18] = s.pos.y / 800;
  o[19] = 1; // bias
  return o;
}

// ---------------- 目击记忆（v2） ----------------

/** 上次目击记忆：记录敌方的世界坐标与时刻（用世界坐标而非相对向量——自己移动后仍可导航回去） */
export interface BrainMem {
  has: boolean;
  ex: number; // 上次目击时敌 x
  ey: number; // 上次目击时敌 y
  ms: number; // 目击时刻（引擎时钟）
}

export function createBrainMem(): BrainMem {
  return { has: false, ex: 0, ey: 0, ms: 0 };
}

/**
 * v2 观测向量（24 维 = v1 + 目击记忆 4 维）；每次调用以本帧目击更新 mem。
 * 记忆是「历史观测的确定性函数」→ 同 seed 同轨迹重演完全一致，不影响确定性契约。
 * 维度说明（与 export_sb3.py / gym_tankforge.py 严格一致，勿改顺序）：
 *   [20] 是否有过目击(0/1)
 *   [21] (上次目击敌x − 当前self.x)/600   [22] (上次目击敌y − 当前self.y)/400
 *   [23] 记忆年龄 min(1, (clockMs − 目击ms)/90000)；从未目击 = 1
 */
export function buildObs(ctx: Ctx, mem: BrainMem): number[] {
  const o = buildObsV1(ctx);
  const e = nearestEnemy(ctx);
  if (e) {
    mem.has = true;
    mem.ex = e.pos.x;
    mem.ey = e.pos.y;
    mem.ms = ctx.clockMs;
  }
  o.push(
    mem.has ? 1 : 0,
    mem.has ? (mem.ex - ctx.self.pos.x) / 600 : 0,
    mem.has ? (mem.ey - ctx.self.pos.y) / 400 : 0,
    mem.has ? Math.min(1, Math.max(0, (ctx.clockMs - mem.ms) / 90_000)) : 1,
  );
  return o;
}

// ---------------- 前向传播 ----------------

export function forward(m: ModelJson, x: number[]): number[] {
  let h = x;
  for (let i = 0; i < m.layers.length; i++) {
    const L = m.layers[i];
    const isLast = i === m.layers.length - 1;
    const out = new Array<number>(L.out);
    for (let r = 0; r < L.out; r++) {
      let s = L.b[r];
      const off = r * h.length;
      for (let c = 0; c < h.length; c++) s += L.w[off + c] * h[c];
      out[r] = isLast ? s : m.activation === 'relu' ? Math.max(0, s) : Math.tanh(s);
    }
    h = out;
  }
  return h; // logits
}

/** 动作解码：idx 0..17 → 转向×油门×开火；炮塔由平台辅助瞄准 */
export function decodeAction(idx: number, ctx: Ctx): Action[] {
  const steer = [-1, 0, 1][idx % 3] ?? 0;
  const throttle = [1, 0.4, -0.6][Math.floor(idx / 3) % 3] ?? 1;
  const wantFire = Math.floor(idx / 9) === 1;
  const acts: Action[] = [
    { t: 'steer', v: steer },
    { t: 'throttle', v: throttle },
  ];
  // 平台辅助瞄准：炮塔带提前量指向最近可见敌（模型专注走位，开火意愿由模型输出）
  const e = nearestEnemy(ctx);
  if (e) {
    const rad = Math.PI / 180;
    const v = e.vel ?? { dx: 0, dy: 0 };
    let tf = e.dist / ctx.self.stats.shellSpeed;
    let px = e.pos.x + v.dx * tf;
    let py = e.pos.y + v.dy * tf;
    for (let k = 0; k < 2; k++) {
      tf = Math.hypot(px - ctx.self.pos.x, py - ctx.self.pos.y) / ctx.self.stats.shellSpeed;
      px = e.pos.x + v.dx * tf;
      py = e.pos.y + v.dy * tf;
    }
    const aim = Math.atan2(py - ctx.self.pos.y, px - ctx.self.pos.x) / rad;
    let d = aim - ctx.self.turret;
    while (d > 180) d -= 360;
    while (d <= -180) d += 360;
    acts.push({ t: 'turretTo', deg: aim });
    if (wantFire && Math.abs(d) < 15 && ctx.self.cooldownMs <= 0) acts.push({ t: 'fire' });
  } else {
    acts.push({ t: 'turretTo', deg: ctx.self.heading });
  }
  return acts;
}

/** 模型大脑入口（带状态的工厂）：每局调用一次创建，记忆随闭包跨决策帧保持
 *  v1 模型自动退化为无记忆路径（20 维），v2 模型带目击记忆（24 维） */
export function makeModelBrain(m: ModelJson): (ctx: Ctx) => Action[] {
  if (m.version === 1) {
    return (ctx: Ctx) => decodeAction(argmax(forward(m, buildObsV1(ctx))), ctx);
  }
  const mem = createBrainMem();
  return (ctx: Ctx) => decodeAction(argmax(forward(m, buildObs(ctx, mem))), ctx);
}

function argmax(logits: number[]): number {
  let best = 0;
  for (let i = 1; i < logits.length; i++) if (logits[i] > logits[best]) best = i;
  return best;
}

// ---------------- 编译为自包含策略代码 ----------------

/** 前向传播（编译版源码，v1/v2 共用） */
const CODE_FORWARD = `function mlpForward(x) {
  let h = x;
  for (let i = 0; i < M.layers.length; i++) {
    const L = M.layers[i], isLast = i === M.layers.length - 1, out = new Array(L.out);
    for (let r = 0; r < L.out; r++) {
      let s = L.b[r], off = r * h.length;
      for (let c = 0; c < h.length; c++) s += L.w[off + c] * h[c];
      out[r] = isLast ? s : (M.activation === 'relu' ? Math.max(0, s) : Math.tanh(s));
    }
    h = out;
  }
  return h;
}`;

/** v1 观测源码（20 维，无记忆；与历史产物保持一致） */
const CODE_OBS_V1 = `function mlpObs(ctx) {
  const s = ctx.self, o = new Array(OBS_DIM).fill(0);
  const e = ctx.view.enemies.slice().sort(function (a, b) { return a.dist - b.dist; })[0] || null;
  o[0] = s.hp / s.maxHp;
  o[1] = s.cooldownMs / s.stats.fireIntervalMs;
  o[2] = Math.sin(s.heading * RAD); o[3] = Math.cos(s.heading * RAD);
  o[4] = Math.sin(s.turret * RAD); o[5] = Math.cos(s.turret * RAD);
  if (e) {
    o[6] = 1;
    o[7] = (e.pos.x - s.pos.x) / 600; o[8] = (e.pos.y - s.pos.y) / 400;
    o[9] = Math.min(2, e.dist / s.stats.viewRadius);
    o[10] = Math.sin(e.heading * RAD); o[11] = Math.cos(e.heading * RAD);
    const v = e.vel || { dx: 0, dy: 0 };
    o[12] = Math.max(-1.5, Math.min(1.5, v.dx / 240));
    o[13] = Math.max(-1.5, Math.min(1.5, v.dy / 240));
    o[14] = Math.min(1, e.hp / 190);
    let d = Math.atan2(e.pos.y - s.pos.y, e.pos.x - s.pos.x) / RAD - s.turret;
    while (d > 180) d -= 360; while (d <= -180) d += 360;
    o[15] = d / 180;
  } else { o[9] = 2; }
  o[16] = Math.min(1, ctx.timeLeftMs / 90000);
  o[17] = s.pos.x / 1200; o[18] = s.pos.y / 800;
  o[19] = 1;
  return o;
}`;

/** v2 观测源码（24 维，含目击记忆 MEM）
 *  注意：MEM 是顶层状态 —— 依赖执行端「顶层只执行一次、每帧只调 decide」的语义
 *  （服务端 vmScriptDriver 两段式 / userbot.worker 两段式），勿在每次重执行顶层的环境中部署 */
const CODE_OBS_V2 = `var MEM = { has: false, ex: 0, ey: 0, ms: 0 };
function mlpObs(ctx) {
  const s = ctx.self, o = new Array(OBS_DIM).fill(0);
  const e = ctx.view.enemies.slice().sort(function (a, b) { return a.dist - b.dist; })[0] || null;
  if (e) { MEM.has = true; MEM.ex = e.pos.x; MEM.ey = e.pos.y; MEM.ms = ctx.clockMs; }
  o[0] = s.hp / s.maxHp;
  o[1] = s.cooldownMs / s.stats.fireIntervalMs;
  o[2] = Math.sin(s.heading * RAD); o[3] = Math.cos(s.heading * RAD);
  o[4] = Math.sin(s.turret * RAD); o[5] = Math.cos(s.turret * RAD);
  if (e) {
    o[6] = 1;
    o[7] = (e.pos.x - s.pos.x) / 600; o[8] = (e.pos.y - s.pos.y) / 400;
    o[9] = Math.min(2, e.dist / s.stats.viewRadius);
    o[10] = Math.sin(e.heading * RAD); o[11] = Math.cos(e.heading * RAD);
    const v = e.vel || { dx: 0, dy: 0 };
    o[12] = Math.max(-1.5, Math.min(1.5, v.dx / 240));
    o[13] = Math.max(-1.5, Math.min(1.5, v.dy / 240));
    o[14] = Math.min(1, e.hp / 190);
    let d = Math.atan2(e.pos.y - s.pos.y, e.pos.x - s.pos.x) / RAD - s.turret;
    while (d > 180) d -= 360; while (d <= -180) d += 360;
    o[15] = d / 180;
  } else { o[9] = 2; }
  o[16] = Math.min(1, ctx.timeLeftMs / 90000);
  o[17] = s.pos.x / 1200; o[18] = s.pos.y / 800;
  o[19] = 1;
  o[20] = MEM.has ? 1 : 0;
  o[21] = MEM.has ? (MEM.ex - s.pos.x) / 600 : 0;
  o[22] = MEM.has ? (MEM.ey - s.pos.y) / 400 : 0;
  o[23] = MEM.has ? Math.min(1, Math.max(0, (ctx.clockMs - MEM.ms) / 90000)) : 1;
  return o;
}`;

/** 决策与动作解码（编译版源码，v1/v2 共用；炮塔平台辅助瞄准带提前量） */
const CODE_DECIDE = `function decide(ctx) {
  const logits = mlpForward(mlpObs(ctx));
  let best = 0;
  for (let i = 1; i < logits.length; i++) if (logits[i] > logits[best]) best = i;
  const steer = [-1, 0, 1][best % 3] || 0;
  const throttle = [1, 0.4, -0.6][Math.floor(best / 3) % 3] || 1;
  const wantFire = Math.floor(best / 9) === 1;
  const acts = [{ t: 'steer', v: steer }, { t: 'throttle', v: throttle }];
  const e = ctx.view.enemies.slice().sort(function (a, b) { return a.dist - b.dist; })[0] || null;
  if (e) {
    const v = e.vel || { dx: 0, dy: 0 };
    let tf = e.dist / ctx.self.stats.shellSpeed;
    let px = e.pos.x + v.dx * tf, py = e.pos.y + v.dy * tf;
    for (let k = 0; k < 2; k++) {
      tf = Math.hypot(px - ctx.self.pos.x, py - ctx.self.pos.y) / ctx.self.stats.shellSpeed;
      px = e.pos.x + v.dx * tf; py = e.pos.y + v.dy * tf;
    }
    const aim = Math.atan2(py - ctx.self.pos.y, px - ctx.self.pos.x) / RAD;
    let d = aim - ctx.self.turret;
    while (d > 180) d -= 360; while (d <= -180) d += 360;
    acts.push({ t: 'turretTo', deg: aim });
    if (wantFire && Math.abs(d) < 15 && ctx.self.cooldownMs <= 0) acts.push({ t: 'fire' });
  } else {
    acts.push({ t: 'turretTo', deg: ctx.self.heading });
  }
  return acts;
}`;

/** 生成可直接存库/在 Worker 与 vm 沙箱运行的 decide(ctx) 源码（按模型版本选择观测实现） */
export function toModelBrainCode(m: ModelJson): string {
  const v2 = m.version === 2;
  return `// [tankforge-model v${m.version}] 由模型编译生成的策略：MLP/${m.activation} · ${modelParams(m)} 参数
// 观测 ${v2 ? OBS_DIM : OBS_DIM_V1} 维 / 动作 ${ACTION_DIM} 选 1（argmax）；炮塔由平台辅助瞄准（带提前量）
${v2 ? '// v2：含目击记忆 MEM —— 敌不可见时观测 [20..23] 指向上次目击点，支持导航搜索\n' : ''}const M = ${JSON.stringify(m)};
const OBS_DIM = ${v2 ? OBS_DIM : OBS_DIM_V1};
const RAD = Math.PI / 180;
${v2 ? CODE_OBS_V2 : CODE_OBS_V1}
${CODE_FORWARD}
${CODE_DECIDE}
`;
}

// ---------------- 随机模型（管线测试/进化初始种群） ----------------

/** 确定性 PRNG（mulberry32） */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 随机 MLP：hidden 各层宽度，最后映射到 ACTION_DIM */
export function makeRandomModel(hidden: number[] = [32, 32], seed = 1): ModelJson {
  const rng = mulberry32(seed);
  const dims = [OBS_DIM, ...hidden, ACTION_DIM];
  const layers: ModelLayer[] = [];
  for (let i = 0; i < dims.length - 1; i++) {
    const inD = dims[i];
    const out = dims[i + 1];
    const scale = 1 / Math.sqrt(inD);
    const w = new Array<number>(inD * out);
    for (let k = 0; k < w.length; k++) w[k] = (rng() * 2 - 1) * scale;
    const b = new Array<number>(out).fill(0);
    layers.push({ out, w, b });
  }
  return { format: 'tankforge-model', version: 2, activation: 'tanh', layers };
}

/** 进化变异：对权重做高斯扰动 */
export function mutateModel(m: ModelJson, rate = 0.3, amp = 0.15, seed = 1): ModelJson {
  const rng = mulberry32(seed);
  const gauss = () => {
    const u = Math.max(1e-9, rng());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  };
  return {
    ...m,
    layers: m.layers.map((L) => ({
      out: L.out,
      b: L.b.map((x) => (rng() < rate ? x + gauss() * amp : x)),
      w: L.w.map((x) => (rng() < rate ? x + gauss() * amp : x)),
    })),
  };
}
