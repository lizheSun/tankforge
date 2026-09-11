// ============================================================
// M1 出口验收：N 局内置策略自动对打 + 确定性双跑 + golden 基线
// 用法：npx tsx scripts/stress.ts [局数=100] [strict]
//   非 strict：仅当“同 seed 双跑不一致 / 交火率过低”才算失败
//   strict：与 golden 基线不一致也算失败（引擎漂移检测）
// ============================================================
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILD_PRESETS, resolveStats } from '../src/game/build';
import { masterDecide, rookieDecide, veteranDecide } from '../src/game/bots';
import { buildMap } from '../src/game/map';
import { MatchRunner, type SideDriver } from '../src/game/runner';
import type { Team } from '../src/game/types';
import { matchFingerprint } from '../src/replay/replay';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN = resolve(__dirname, '../golden/stress-baseline.json');

type BotId = 'rookie' | 'veteran' | 'master';
const PAIRS: Array<{ tag: string; red: BotId; blue: BotId }> = [
  { tag: 'master-vs-veteran', red: 'master', blue: 'veteran' },
  { tag: 'veteran-vs-rookie', red: 'veteran', blue: 'rookie' },
  { tag: 'master-vs-rookie', red: 'master', blue: 'rookie' },
];
// 与 demo UI（config 初始值）一致的 build 预设索引
const PRESET_IDX: Record<BotId, number> = { rookie: 0, veteran: 3, master: 4 };
const STATS: Record<BotId, ReturnType<typeof resolveStats>> = {
  rookie: resolveStats(BUILD_PRESETS[PRESET_IDX.rookie].points),
  veteran: resolveStats(BUILD_PRESETS[PRESET_IDX.veteran].points),
  master: resolveStats(BUILD_PRESETS[PRESET_IDX.master].points),
};

function botOf(team: Team, id: BotId): SideDriver {
  const fn = id === 'rookie' ? rookieDecide : id === 'veteran' ? veteranDecide : masterDecide;
  return { team, name: id.toUpperCase(), kind: 'bot', decide: fn };
}

interface Row {
  tag: string;
  seed: number;
  winner: string;
  reason: string;
  tick: number;
  shots: number;
  hits: number;
  fingerprint: string;
}

async function runOnce(tag: string, pair: (typeof PAIRS)[number], seed: number): Promise<Row> {
  const map = buildMap('arena_ruins');
  const red = botOf('red', pair.red);
  const blue = botOf('blue', pair.blue);
  const runner = new MatchRunner({
    config: {
      tiles: map.tiles,
      seed,
      durationMs: 60_000,
      friendlyFire: false,
      spawns: [
        { id: 'red', team: 'red', name: red.name, buildName: pair.red, stats: STATS[pair.red], pos: { x: 140, y: 140 }, heading: 45 },
        { id: 'blue', team: 'blue', name: blue.name, buildName: pair.blue, stats: STATS[pair.blue], pos: { x: 1060, y: 660 }, heading: 225 },
      ],
    },
    red,
    blue,
  });
  await runner.runToEnd();
  const res = runner.m.result!;
  const tanks = [...runner.m.tanks.values()];
  return {
    tag,
    seed,
    winner: res.winner ?? 'draw',
    reason: res.reason ?? 'none',
    tick: runner.m.tick,
    shots: tanks.reduce((s, t) => s + t.shotsFired, 0),
    hits: tanks.reduce((s, t) => s + t.hits, 0),
    fingerprint: matchFingerprint(runner),
  };
}

async function main() {
  const n = Math.max(1, Number(process.argv[2]) || 100);
  const strict = process.argv.includes('strict');
  const t0 = performance.now();
  const rows: Row[] = [];
  let detFail = 0;
  let noFight = 0;
  let draws = 0;

  for (let i = 0; i < n; i++) {
    const seed = i + 1;
    const pair = PAIRS[i % PAIRS.length];
    const a = await runOnce(pair.tag, pair, seed);
    const b = await runOnce(pair.tag, pair, seed);
    rows.push(a);
    if (a.fingerprint !== b.fingerprint) {
      detFail++;
      console.error(`✗ 确定性漂移 @${pair.tag} seed=${seed}`);
    }
    if (a.shots === 0) noFight++;
    if (a.winner === 'draw') draws++;
  }

  const golden: Record<string, string> = {};
  for (const r of rows) golden[`${r.tag}#${r.seed}`] = r.fingerprint;
  mkdirSync(dirname(GOLDEN), { recursive: true });
  writeFileSync(resolve(__dirname, '../golden/stress-latest.json'), JSON.stringify(golden, null, 2));

  let drift = 0;
  if (existsSync(GOLDEN)) {
    const prev = JSON.parse(readFileSync(GOLDEN, 'utf-8')) as Record<string, string>;
    drift = Object.keys(golden).filter((k) => prev[k] && prev[k] !== golden[k]).length;
  } else {
    writeFileSync(GOLDEN, JSON.stringify(golden, null, 2));
    console.log(`已生成 golden 基线：${GOLDEN}`);
  }

  const sum = rows.reduce((s, r) => ({ shots: s.shots + r.shots, hits: s.hits + r.hits }), { shots: 0, hits: 0 });
  console.log(`\n[结果] 局数=${n} · 用时=${((performance.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  确定性双跑不一致: ${detFail}  零交火局: ${noFight}  决出胜负: ${n - draws}  平局: ${draws}`);
  console.log(`  与 golden 基线漂移: ${drift}${strict ? '（strict 模式）' : ''}`);
  console.log(`  交战统计(总和): shots=${sum.shots} hits=${sum.hits}`);

  const fail = detFail > 0 || noFight > n * 0.05 || (strict && drift > 0);
  if (fail) {
    console.error('✗ M1 压力验收未通过');
    process.exit(1);
  }
  console.log(`✓ M1 通过：${n} 局稳定自动对打 · 同 seed 指纹一致 · ${strict ? 'golden 零漂移' : 'golden 漂移仅提示（加 strict 校验）'}`);
  process.exit(0);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
