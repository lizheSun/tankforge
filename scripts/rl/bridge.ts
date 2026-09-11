// ============================================================
// 训练桥：Python（SB3/PPO） ↔ stdio JSONL ↔ 真实 TS 引擎
// 协议（每行一个 JSON）：
//   → {"op":"reset","seed":1,"mapId":"crossroads","opponent":"veteran","presetIdx":3,"durationMs":60000}
//   ← {"obs":[20 floats],"info":{...}}
//   → {"op":"step","action":7}
//   ← {"obs":[...],"reward":0.0,"done":false,"info":{...}}
//   → {"op":"close"}
// 说明：观测/动作与线上模型坦克完全一致（modelBrain.buildObs/decodeAction），
//      每步 = 一个决策帧（5 物理tick）。
//      奖励 = 输出(造成伤害 − 承受伤害) + 视野塑形 + 胜负终奖(±100)。
//      视野塑形（关键）：保持接触 +bonus / 逼近 +势函数 / 丢失目标 −penalty。
//      —— 否则模型在「看不到敌人」时奖励恒为 0、无梯度，会退化成原地绕圈（实测可见度仅 12%）。
// ============================================================
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { BUILD_PRESETS, resolveStats } from '../../src/game/build';
import { BUILTIN_BOTS } from '../../src/game/bots';
import { teamSpawns } from '../../src/game/formation';
import { buildMap } from '../../src/game/map';
import { buildObs, createBrainMem, decodeAction, makeModelBrain, type BrainMem, type ModelJson } from '../../src/game/modelBrain';
import { applyActions, buildCtx, createMatch, step, viewEnemies, type EngineMatch } from '../../src/game/engine';
import type { Action, Ctx } from '../../src/game/types';

// 视野/搜索塑形系数（可按训练表现微调）
const CONTACT_BONUS = 0.03; // 每决策帧「敌人可见」的正奖励
const APPROACH_K = 0.01; // 逼近敌方的势函数系数（对 dist 差分）
const IDLE_PENALTY = 0.02; // 每决策帧「丢失目标」的负奖励
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

interface Req {
  op: 'reset' | 'step' | 'close';
  seed?: number;
  action?: number;
  mapId?: string;
  opponent?: string;
  presetIdx?: number;
  durationMs?: number;
  // 兼容 snake_case 客户端（历史版本 gym_tankforge.py 发的是这三个键）
  map_id?: string;
  preset_idx?: number;
  duration_ms?: number;
}

const RL = 'red-0';
const OP = 'blue-0';
const BEST_MODEL = resolve(process.cwd(), 'scripts/rl/best-model.json');

let m: EngineMatch | null = null;
let opponentDecide: ((ctx: Ctx) => Action[]) | null = null;
let mem: BrainMem = createBrainMem(); // RL 侧目击记忆（v2 观测；每局 reset 重建）
let prevDmg = 0;
let prevHp = 0;
let prevDist: number | null = null; // 上一决策帧与最近可见敌的距离（不可见为 null）

function statsOf(presetIdx: number) {
  return resolveStats(BUILD_PRESETS[presetIdx]?.points ?? BUILD_PRESETS[0].points);
}

function obsNow(): number[] {
  const rl = m!.tanks.get(RL)!;
  return buildObs(buildCtx(m!, rl), mem);
}

function infoNow(): Record<string, unknown> {
  const rl = m!.tanks.get(RL)!;
  const op = m!.tanks.get(OP)!;
  return {
    hp: Math.ceil(rl.hp),
    enemyHp: Math.ceil(op.hp),
    tick: m!.tick,
    winner: m!.result?.winner ?? null,
    reason: m!.result?.reason ?? null,
  };
}

/** 从 tankforge-model JSON 文件加载模型陪练（self-play 用） */
function loadModelOpponent(path: string): { decide: (ctx: Ctx) => Action[]; buildIdx: number } | null {
  try {
    const model = JSON.parse(readFileSync(path, 'utf-8')) as ModelJson;
    // 陪练模型按游侠 build（与 RL 训练车一致 → self-play 镜像对局）；makeModelBrain 每局新建 → 记忆独立
    return { decide: makeModelBrain(model), buildIdx: 3 };
  } catch {
    return null; // 文件缺失/非法 → 由调用方降级
  }
}

function makeOpponent(kind: string, seed: number): { decide: (ctx: Ctx) => Action[]; buildIdx: number } {
  // file:<path> —— 指定 tankforge-model JSON 当陪练（self-play 单一对手）
  if (kind.startsWith('file:')) {
    const o = loadModelOpponent(kind.slice(5));
    if (o) return o;
  }
  // league:<path> —— 陪练池（self-play 推荐）：按对局 seed 确定性轮换，同 seed 重演一致
  //   5 成 自己（path 指向的模型） / 3 成 master / 2 成 veteran
  //   混合陪练防「只打自己」的灾难性遗忘与循环克制（AlphaStar 联赛机制）
  if (kind.startsWith('league:')) {
    const pick = seed % 10;
    if (pick < 5) {
      const o = loadModelOpponent(kind.slice(7));
      if (o) return o; // 模型文件缺/坏 → 降级 master（下方 pick<8 分支）
    }
    if (pick < 8) {
      const master = BUILTIN_BOTS.find((b) => b.id === 'master')!;
      return { decide: (ctx) => master.decide(ctx), buildIdx: master.defaultBuild };
    }
    const vet = BUILTIN_BOTS.find((b) => b.id === 'veteran')!;
    return { decide: (ctx) => vet.decide(ctx), buildIdx: vet.defaultBuild };
  }
  if (kind === 'evolve-best') {
    try {
      const model = JSON.parse(readFileSync(BEST_MODEL, 'utf-8')) as ModelJson;
      // 进化产物默认按游侠 build 参战（与 evolve.ts 训练评估一致）；
      // makeModelBrain 每局创建 → 自带独立目击记忆（v2）
      return { decide: makeModelBrain(model), buildIdx: 3 };
    } catch {
      // 没有进化产物则回退 veteran
    }
  }
  const bot = BUILTIN_BOTS.find((b) => b.id === kind) ?? BUILTIN_BOTS.find((b) => b.id === 'veteran')!;
  // 关键：陪练用与线上一致的官方 Build（master=4 才有 auto 自瞄），否则练错对手
  return { decide: (ctx) => bot.decide(ctx), buildIdx: bot.defaultBuild };
}

function doReset(req: Req): Record<string, unknown> {
  const opp = makeOpponent(String(req.opponent ?? 'veteran'), Number(req.seed ?? 0));
  opponentDecide = opp.decide;
  const presetIdx = Number(req.presetIdx ?? req.preset_idx ?? 3); // 默认游侠（含辅助瞄具：训练观测与实战一致）
  const mapId = req.mapId ?? req.map_id ?? 'crossroads';
  const tiles = buildMap(mapId).tiles;
  const redSpawn = teamSpawns(tiles, 1, 'red')[0];
  const blueSpawn = teamSpawns(tiles, 1, 'blue')[0];
  m = createMatch({
    tiles,
    seed: Number(req.seed ?? 0),
    // 与线上实战一致：天梯/服务端均为 90s（训练若缩短，o[16]=timeLeft/90000 分布会与实战偏移）
    durationMs: Number(req.durationMs ?? req.duration_ms ?? 90_000),
    friendlyFire: false,
    spawns: [
      { id: RL, team: 'red', name: 'RL', buildName: 'RL', stats: statsOf(presetIdx), pos: { x: redSpawn.x, y: redSpawn.y }, heading: redSpawn.heading },
      { id: OP, team: 'blue', name: 'BOT', buildName: 'BOT', stats: statsOf(opp.buildIdx), pos: { x: blueSpawn.x, y: blueSpawn.y }, heading: blueSpawn.heading },
    ],
  });
  prevDmg = 0;
  prevHp = m.tanks.get(RL)!.hp;
  prevDist = null;
  mem = createBrainMem(); // 每局重置目击记忆（与线上"每局新建 Worker/沙箱"一致）
  return { obs: obsNow(), info: infoNow() };
}

function doStep(action: number): Record<string, unknown> {
  const match = m!;
  const rl = match.tanks.get(RL)!;
  const op = match.tanks.get(OP)!;
  // 1. 本决策帧双方出招（RL 用 Python 给的动作，走与线上完全相同的解码）
  applyActions(match, RL, decodeAction(action, buildCtx(match, rl)));
  if (op.alive) applyActions(match, OP, opponentDecide!(buildCtx(match, op)));
  // 2. 推进 5 个物理 tick（一个决策帧）
  for (let i = 0; i < 5 && !match.over; i++) step(match);
  // 3. 奖励 = 造成伤害 − 承受伤害（+ 终局 ±100）
  const dmg = rl.damageDealt - prevDmg;
  prevDmg = rl.damageDealt;
  const taken = prevHp - rl.hp;
  prevHp = rl.hp;
  let reward = dmg - taken;
  // 4. 视野/搜索塑形：让「找到并咬住敌人」本身就有回报，破解原地绕圈退化
  const nearest = rl.alive
    ? viewEnemies(match, rl)
        .slice()
        .sort((a, b) => a.dist - b.dist)[0] ?? null
    : null;
  if (nearest) {
    reward += CONTACT_BONUS;
    if (prevDist !== null) reward += clamp((prevDist - nearest.dist) * APPROACH_K, -0.5, 0.5);
    prevDist = nearest.dist;
  } else {
    reward -= IDLE_PENALTY;
    prevDist = null;
  }
  if (match.over && match.result) {
    if (match.result.winner === 'red') reward += 100;
    else if (match.result.winner === 'blue') reward -= 100;
  }
  return { obs: obsNow(), reward, done: match.over, info: infoNow() };
}

const rl0 = createInterface({ input: process.stdin });
rl0.on('line', (line) => {
  const s = line.trim();
  if (!s) return;
  let req: Req;
  try {
    req = JSON.parse(s) as Req;
  } catch {
    process.stdout.write(JSON.stringify({ error: 'bad json' }) + '\n');
    return;
  }
  try {
    if (req.op === 'reset') process.stdout.write(JSON.stringify(doReset(req)) + '\n');
    else if (req.op === 'step') process.stdout.write(JSON.stringify(doStep(Number(req.action ?? 0))) + '\n');
    else if (req.op === 'close') process.exit(0);
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) + '\n');
  }
});
rl0.on('close', () => process.exit(0));
