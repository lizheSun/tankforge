// 服务端对战执行器：复用战斗引擎 + node:vm 沙箱跑用户策略。
// 与浏览器端 userbot.worker 保持语义一致：
//  - 顶层代码只执行一次（提取 decide），每帧仅调用 decide(ctx)；
//  - ctx.rng 用相同的 mulberry32 + 种子（坦克id|帧tick）重建 → 服务端结果与前端重演完全一致。
import vm from 'node:vm';
import { BUILD_PRESETS, resolveStats } from '../src/game/build';
import { BUILTIN_BOTS, type BuiltinBot } from '../src/game/bots';
import { teamSpawns } from '../src/game/formation';
import { buildMap } from '../src/game/map';
import { MatchRunner, type RunnerDriver } from '../src/game/runner';
import type { Action, BuildPoints, Ctx } from '../src/game/types';

export interface TankSpec {
  name: string;
  /** 用户代码（与 botId 二选一） */
  code: string | null;
  /** 内置 NPC bot */
  botId: string | null;
  build: BuildPoints;
}

export interface BattleTankStat {
  name: string;
  hp: number;
  alive: boolean;
  shots: number;
  hits: number;
  dmg: number;
  kills: number;
  sanctions: number;
  accuracy: number;
}

export interface BattleOutcome {
  winner: 'red' | 'blue' | null;
  reason: string;
  ticks: number;
  tanks: BattleTankStat[];
  seed: number;
}

const quietConsole = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  info: () => undefined,
  debug: () => undefined,
};

/** 与 userbot.worker.ts 完全一致的确定性 PRNG（mulberry32，种子 = 坦克id|帧tick） */
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

const crashDriver = (name: string, msg: string): RunnerDriver => ({
  id: '',
  name,
  kind: 'script',
  decide: () => {
    throw new Error(msg);
  },
});

/** vm 沙箱脚本 driver：顶层编译一次提取 decide，每帧带 100ms 超时调用（死循环直接判负） */
function vmScriptDriver(name: string, code: string): RunnerDriver {
  let fn: (ctx: Ctx) => unknown;
  let call: vm.Script;
  try {
    const boot = new vm.Script(`${code}\n;decide`, { filename: `brain[${name}].js` });
    const got = boot.runInNewContext({ console: quietConsole, Math, JSON, Date }, { timeout: 500 });
    if (typeof got !== 'function') return crashDriver(name, '未定义 decide(ctx) 函数');
    fn = got as (ctx: Ctx) => unknown;
    call = new vm.Script('__out = __fn(__ctx)', { filename: `call[${name}].js` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return crashDriver(name, `策略编译失败：${msg}`);
  }
  return {
    id: '',
    name,
    kind: 'script',
    decide: (ctx: Ctx): Action[] => {
      // rng 与浏览器 Worker 同实现同种子（坦克id|帧tick），保证两端逐帧一致
      const ctxFull = { ...ctx, rng: makeRng(`${ctx.self.id}|${ctx.tick}`) };
      const sandbox: Record<string, unknown> = {
        __fn: fn,
        __ctx: ctxFull,
        __out: undefined,
        console: quietConsole,
        Math,
        JSON,
        Date,
      };
      call.runInNewContext(sandbox, { timeout: 100 });
      const out = sandbox.__out;
      return Array.isArray(out) ? (out as Action[]) : [];
    },
  };
}

function driverOf(spec: TankSpec, id: string): RunnerDriver {
  if (spec.botId) {
    const bot: BuiltinBot | undefined = BUILTIN_BOTS.find((b) => b.id === spec.botId);
    if (!bot) throw new Error(`未知内置 bot：${spec.botId}`);
    return { id, name: spec.name, kind: 'bot', decide: (ctx: Ctx) => bot.decide(ctx) };
  }
  if (!spec.code) throw new Error(`坦克 ${spec.name} 既无策略代码也不是 NPC`);
  const d = vmScriptDriver(spec.name, spec.code);
  d.id = id;
  return d;
}

/** 跑一局（多对多）：red/blue 各 1~5 辆坦克编队对战。
 *  地图 crossroads、出生点与前端 Battle 页完全一致（teamSpawns 同源生成）
 *  → 同 seed 同策略 = 与前端重演逐 tick 一致。 */
export async function runBattleTeams(red: TankSpec[], blue: TankSpec[], seedIn?: number): Promise<BattleOutcome> {
  if (!red.length || !blue.length) throw new Error('双方至少各出 1 辆坦克');
  if (red.length > 5 || blue.length > 5) throw new Error('单队最多 5 辆坦克');
  const names = new Set(red.map((s) => s.name).concat(blue.map((s) => s.name)));
  if (names.size !== red.length + blue.length) throw new Error('双方坦克不能重名（同一坦克不能同时代表两个队出战）');
  const seed = seedIn ?? Math.floor(Math.random() * 1e9);
  const map = buildMap('crossroads');
  const n = Math.max(red.length, blue.length);
  const redSpawns = teamSpawns(map.tiles, n, 'red');
  const blueSpawns = teamSpawns(map.tiles, n, 'blue');
  const stats = (b: BuildPoints) => resolveStats(b);
  const buildNameOf = (b: BuildPoints) => BUILD_PRESETS.find((p) => JSON.stringify(p.points) === JSON.stringify(b))?.name ?? '自定义';
  const sideSpawns = (specs: TankSpec[], team: 'red' | 'blue', spawns: { x: number; y: number; heading: number }[]) =>
    specs.map((s, i) => ({
      id: `${team}-${i}`,
      team,
      name: s.name,
      buildName: buildNameOf(s.build),
      stats: stats(s.build),
      pos: { x: spawns[i].x, y: spawns[i].y },
      heading: spawns[i].heading,
    }));
  const runner = new MatchRunner({
    config: {
      tiles: map.tiles,
      seed,
      durationMs: 90_000,
      friendlyFire: false,
      spawns: [...sideSpawns(red, 'red', redSpawns), ...sideSpawns(blue, 'blue', blueSpawns)],
    },
    drivers: [
      ...red.map((s, i) => driverOf(s, `red-${i}`)),
      ...blue.map((s, i) => driverOf(s, `blue-${i}`)),
    ],
  });
  await runner.runToEnd();
  const res = runner.m.result!;
  const tanks: BattleTankStat[] = [...runner.m.tanks.values()].map((t) => ({
    name: t.name,
    hp: Math.ceil(t.hp),
    alive: t.alive,
    shots: t.shotsFired,
    hits: t.hits,
    dmg: Math.round(t.damageDealt),
    kills: t.kills,
    sanctions: t.sanctions,
    accuracy: t.shotsFired ? t.hits / t.shotsFired : 0,
  }));
  return { winner: res.winner, reason: res.reason ?? 'unknown', ticks: runner.m.tick, tanks, seed };
}

/** 单挑兼容（br-run 吃鸡循环用）：内部走多对多通道 */
export function runBattle(red: TankSpec, blue: TankSpec, seedIn?: number): Promise<BattleOutcome> {
  return runBattleTeams([red], [blue], seedIn);
}
