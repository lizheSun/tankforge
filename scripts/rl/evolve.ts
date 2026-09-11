// ============================================================
// 模型进化训练：随机 MLP 种群 → 与内置 bot 对战打分 → 选优 → 高斯变异 → 迭代
// 输出：scripts/rl/best-model.json（可直接在坦克工坊「模型策略」上传参战）
// 用法：npx tsx scripts/rl/evolve.ts [代数=30] [种群=12] [输出路径]
// ============================================================
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BUILD_PRESETS, resolveStats } from '../../src/game/build';
import { BUILTIN_BOTS, type BuiltinBot } from '../../src/game/bots';
import { teamSpawns } from '../../src/game/formation';
import { buildMap } from '../../src/game/map';
import { makeModelBrain, makeRandomModel, mutateModel, type ModelJson } from '../../src/game/modelBrain';
import { MatchRunner } from '../../src/game/runner';
import type { Action, Ctx } from '../../src/game/types';

const GENS = Math.max(2, Number(process.argv[2]) || 30);
const POP = Math.max(4, Number(process.argv[3]) || 12);
const OPPONENTS: ('rookie' | 'veteran' | 'master')[] = ['rookie', 'veteran', 'master'];
const HIDDEN = [32, 32];
// 第 3 个参数可指定输出路径（默认覆盖 best-model.json，可用它做安全实验）
const OUT = resolve(process.cwd(), process.argv[4] || 'scripts/rl/best-model.json');

/** 固定种子集：所有个体、所有代都用同一组种子 → 分数严格可比，消除"种子运气" */
const SEEDS = [1000, 2000, 3000]; // 每个对手打 3 局取平均：降方差 + 防过拟合单一对手轨迹

async function evalOnce(model: ModelJson, bot: BuiltinBot, seed: number): Promise<number> {
  const map = buildMap('crossroads');
  const redSpawn = teamSpawns(map.tiles, 1, 'red')[0];
  const blueSpawn = teamSpawns(map.tiles, 1, 'blue')[0];
  // 视野/搜索塑形：统计「敌人可见」的决策帧占比（与 bridge.ts 训练奖励同源）
  let frames = 0;
  let contactFrames = 0;
  const brain = makeModelBrain(model); // 每局一个大脑实例：v2 模型的目击记忆随闭包跨帧保持
  const decideRl = (ctx: Ctx): Action[] => {
    frames++;
    if (ctx.view.enemies.length) contactFrames++;
    return brain(ctx);
  };
  const runner = new MatchRunner({
    config: {
      tiles: map.tiles,
      seed,
      durationMs: 90_000, // 与线上天梯/服务端一致（实战时长），避免 o[16] 观测分布偏移
      friendlyFire: false,
      spawns: [
        {
          id: 'red-0',
          team: 'red',
          name: 'MODEL',
          buildName: '游侠',
          stats: resolveStats(BUILD_PRESETS[3].points),
          pos: { x: redSpawn.x, y: redSpawn.y },
          heading: redSpawn.heading,
        },
        {
          id: 'blue-0',
          team: 'blue',
          name: bot.name,
          buildName: bot.name,
          stats: resolveStats(BUILD_PRESETS[bot.defaultBuild].points),
          pos: { x: blueSpawn.x, y: blueSpawn.y },
          heading: blueSpawn.heading,
        },
      ],
    },
    drivers: [
      { id: 'red-0', name: 'MODEL', kind: 'script', decide: decideRl },
      { id: 'blue-0', name: bot.name, kind: 'bot', decide: (ctx) => bot.decide(ctx) },
    ],
  });
  await runner.runToEnd();
  const r = runner.m.result!;
  const me = runner.m.tanks.get('red-0')!;
  const foe = runner.m.tanks.get('blue-0')!;
  const contact = frames > 0 ? contactFrames / frames : 0;
  return (
    (r.winner === 'red' ? 100 : 0) +
    me.kills * 30 +
    me.damageDealt / 3 +
    me.hp / 5 +
    contact * 60 - // 最高 60 分（与「赢一局」同量级）：逼模型主动搜索、咬住敌人
    foe.damageDealt / 5 // 受击惩罚：对冲 contact 分，防止「贴脸送死刷视野」的次优解
  );
}

/** 适应度：固定种子集（所有个体同种子）→ 跨代严格可比；多种子平均降方差
 *  （历史 bug：曾用数组下标 idx 定种子，同一模型跨代用不同种子评估，分数混入"种子运气"） */
async function fitness(model: ModelJson): Promise<number> {
  let s = 0;
  for (const id of OPPONENTS) {
    const bot = BUILTIN_BOTS.find((b) => b.id === id)!;
    for (const sd of SEEDS) s += await evalOnce(model, bot, sd);
  }
  return s / (OPPONENTS.length * SEEDS.length);
}

async function main() {
  const t0 = performance.now();
  let population: ModelJson[] = [];
  for (let i = 0; i < POP; i++) population.push(makeRandomModel(HIDDEN, i + 1));
  let best: { score: number; model: ModelJson } | null = null;

  for (let gen = 1; gen <= GENS; gen++) {
    const scored = await Promise.all(population.map((m) => fitness(m)));
    const order = population
      .map((m, i) => ({ m, s: scored[i] }))
      .sort((a, b) => b.s - a.s);
    const top = order[0];
    if (!best || top.s > best.score) best = { score: top.s, model: top.m };
    console.log(
      `[gen ${String(gen).padStart(3)}/${GENS}] 最优=${top.s.toFixed(1)} 全局最优=${best.score.toFixed(1)} 用时=${((performance.now() - t0) / 1000).toFixed(0)}s`,
    );

    // 下一代：精英保留 + 精英变异 + 少量新鲜血液
    const elites = order.slice(0, Math.max(2, Math.floor(POP / 4))).map((x) => x.m);
    const next: ModelJson[] = [...elites];
    let e = 0;
    while (next.length < POP - 1) {
      next.push(mutateModel(elites[e % elites.length], 0.3, 0.15, gen * 1000 + next.length));
      e++;
    }
    next.push(makeRandomModel(HIDDEN, gen * 7919)); // 保持多样性
    population = next;
  }

  mkdirSync(resolve(OUT, '..'), { recursive: true });
  writeFileSync(OUT, JSON.stringify(best!.model));
  console.log(`\n✓ 进化完成：全局最优适应度 ${best!.score.toFixed(1)}`);
  console.log(`  模型已导出：${OUT}`);
  console.log(`  上传方式：坦克工坊 → 🧠 模型策略（RL） → 上传 ${OUT} → 创建坦克`);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
