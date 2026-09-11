// ============================================================
// M3 团战内核验收（engine-first slice）：
// 1) 布阵：所有图 × 2v2~5v5 出生点空白、对称、间距合规
// 2) 全流程：2v2 / 3v3 × 全部地图 跑完并正常结算（全灭/超时皆可）
// 3) 队友观测：team 模式下 ctx.mode='team'，alive 时能看到 S-1 个队友
// 4) 队友通信：red0 广播 ping#n，red1 在下一决策帧起按序收到
// 5) 确定性：同 seed 双跑指纹一致
// 用法：npx tsx scripts/team.ts
// ============================================================
import { BUILD_PRESETS, resolveStats, type BuildPreset } from '../src/game/build';
import { masterDecide, rookieDecide, veteranDecide } from '../src/game/bots';
import { MAP_IDS, buildMap } from '../src/game/map';
import { teamSpawns, TEAM_SIZE_MIN, TEAM_SIZE_MAX } from '../src/game/formation';
import { MatchRunner, type RunnerDriver } from '../src/game/runner';
import type { Action, Ctx, ResolvedStats, Team, TileType } from '../src/game/types';
import { matchFingerprint } from '../src/replay/replay';

type BotId = 'rookie' | 'veteran' | 'master';
const PRESET_IDX: Record<BotId, number> = { rookie: 0, veteran: 3, master: 4 };
const STATS: Record<BotId, ResolvedStats> = {
  rookie: resolveStats(BUILD_PRESETS[PRESET_IDX.rookie].points),
  veteran: resolveStats(BUILD_PRESETS[PRESET_IDX.veteran].points),
  master: resolveStats(BUILD_PRESETS[PRESET_IDX.master].points),
};
const DECIDE: Record<BotId, (ctx: Ctx) => Action[]> = {
  rookie: rookieDecide,
  veteran: veteranDecide,
  master: masterDecide,
};

function lineup(size: number): BotId[] {
  if (size === 2) return ['master', 'veteran'];
  if (size === 3) return ['master', 'veteran', 'rookie'];
  return Array.from({ length: size }, (_, i) => (i % 2 === 0 ? 'master' : 'veteran'));
}

function circleClear(tiles: TileType[][], x: number, y: number): boolean {
  // 与引擎一致：出生点在出生后 1 tick 不应撞墙（直接查瓦片）
  const tx = Math.floor(x / 25);
  const ty = Math.floor(y / 25);
  const w = tiles[ty]?.[tx];
  return w === 'EMPTY' || w === 'GRASS' || w === 'RUIN';
}

function buildTeamMatch(opts: { mapId: string; size: number; seed: number; durationMs: number; probe?: (ctx: Ctx) => void }) {
  const map = buildMap(opts.mapId);
  const spawns = [];
  const drivers: RunnerDriver[] = [];
  for (const team of ['red', 'blue'] as Team[]) {
    const slots = teamSpawns(map.tiles, opts.size, team);
    const bots = lineup(opts.size);
    for (let i = 0; i < opts.size; i++) {
      const id = `${team}${i}`;
      const bot = bots[i];
      spawns.push({
        id,
        team,
        name: bot.toUpperCase(),
        buildName: BUILD_PRESETS[PRESET_IDX[bot]].name,
        stats: STATS[bot],
        pos: { x: slots[i].x, y: slots[i].y },
        heading: slots[i].heading,
      });
      drivers.push({
        id,
        name: bot.toUpperCase(),
        kind: 'bot',
        decide: (ctx) => {
          opts.probe?.(ctx);
          return DECIDE[bot](ctx);
        },
      });
    }
  }
  return new MatchRunner({
    config: { tiles: map.tiles, seed: opts.seed, durationMs: opts.durationMs, friendlyFire: false, spawns },
    drivers,
  });
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
  console.log(`  ✓ ${msg}`);
}

async function main() {
  // ---- 1) 布阵合法性 ----
  console.log('\n[1] 布阵合法性（全部地图 × 2v2~5v5）');
  for (const mapId of MAP_IDS) {
    const map = buildMap(mapId);
    for (let size = TEAM_SIZE_MIN; size <= TEAM_SIZE_MAX; size++) {
      const red = teamSpawns(map.tiles, size, 'red');
      const blue = teamSpawns(map.tiles, size, 'blue');
      assert(red.length === size && blue.length === size, `${mapId} ${size}v${size} 出生点数量`);
      for (const s of red) assert(circleClear(map.tiles, Math.round(s.x), Math.round(s.y)), `${mapId} red 出生点空白`);
      for (const s of blue) assert(circleClear(map.tiles, Math.round(s.x), Math.round(s.y)), `${mapId} blue 出生点空白`);
      for (let i = 0; i < size; i++) {
        for (let j = i + 1; j < size; j++) {
          const d = Math.hypot(red[i].x - red[j].x, red[i].y - red[j].y);
          assert(d > 32 * 2 + 10, `${mapId} red ${i}-${j} 间距 ${d.toFixed(0)}px`);
        }
      }
      // 中心镜像对称
      for (const s of red) {
        const mirror = blue.find((b) => Math.abs(b.x - (1200 - s.x)) < 1 && Math.abs(b.y - (800 - s.y)) < 1);
        assert(!!mirror, `${mapId} 红蓝镜像对应`);
      }
    }
  }

  // ---- 2) 全流程 + 观测断言 ----
  console.log('\n[2] 团战全流程（2v2/3v3 × 全部地图）');
  const probes: string[] = [];
  for (const size of [2, 3]) {
    for (const mapId of MAP_IDS) {
      const runner = buildTeamMatch({
        mapId,
        size,
        seed: 42,
        durationMs: 60_000,
        probe: (ctx) => {
          if (ctx.tick === 5 && ctx.mode !== 'team') probes.push(`${ctx.self.id} 模式=${ctx.mode}`);
          if (ctx.tick === 10 && ctx.self.id === 'red0') probes.push(`${mapId} ${size}v${size} red0 allies=${ctx.view.allies.length}`);
        },
      });
      await runner.runToEnd();
      const res = runner.m.result;
      assert(!!res, `${mapId} ${size}v${size} 有结算`);
      assert((res!.tankResults?.length ?? 0) === size * 2, `${mapId} ${size}v${size} tankResults 覆盖全部坦克`);
      const shots = [...runner.m.tanks.values()].reduce((s, t) => s + t.shotsFired, 0);
      assert(shots > 0, `${mapId} ${size}v${size} 发生交火（shots=${shots}）`);
      console.log(`    ↳ ${mapId} ${size}v${size} 胜者=${res!.winner ?? '平'} 原因=${res!.reason} @tick ${runner.m.tick}`);
    }
  }
  assert(probes.length === 6, `所有 6 局 mode 均为 team（探针=${probes.length}）`);
  for (const p of probes) if (p.includes('模式=')) assert(!p.includes('模式=1v1'), p);
  assert(probes.some((p) => p.includes('allies=1')), 'team 模式 tick10 能观测到 1 名队友');
  console.log(`    ↳ ${probes.join(' | ')}`);

  // ---- 3) 队友通信 ----
  console.log('\n[3] 队友通信（广播 ping → 下一决策帧按序投递）');
  {
    const map = buildMap('open_field');
    const size = 2;
    const recv: Array<{ from: string; text: string; tick: number }> = [];
    let sent = 0;
    const S = resolveStats(BUILD_PRESETS[4].points);
    const drivers: RunnerDriver[] = [];
    const spawns = [];
    for (const team of ['red', 'blue'] as Team[]) {
      const slots = teamSpawns(map.tiles, size, team);
      for (let i = 0; i < size; i++) {
        const id = `${team}${i}`;
        spawns.push({ id, team, name: `${team}${i}`, buildName: 'x', stats: S, pos: { x: slots[i].x, y: slots[i].y }, heading: slots[i].heading });
      }
    }
    drivers.push(
      {
        id: 'red0',
        name: 'sender',
        kind: 'bot',
        decide: () => {
          sent++;
          return [{ t: 'comm', msg: `ping#${sent}`, to: 'all' }];
        },
      },
      {
        id: 'red1',
        name: 'recv',
        kind: 'bot',
        decide: (ctx) => {
          for (const m of ctx.inbox) recv.push({ from: m.fromId, text: m.text, tick: m.tick });
          return [];
        },
      },
      { id: 'blue0', name: 'idle', kind: 'bot', decide: () => [] },
      { id: 'blue1', name: 'idle', kind: 'bot', decide: () => [] },
    );
    const runner = new MatchRunner({
      config: { tiles: map.tiles, seed: 7, durationMs: 60_000, friendlyFire: false, spawns },
      drivers,
    });
    await runner.stepN(120); // 2s
    assert(recv.length > 0, `red1 收到 ${recv.length} 条通信`);
    assert(recv.every((m) => m.from === 'red0'), '消息来源均为 red0');
    const nums = recv.map((m) => Number(/ping#(\d+)/.exec(m.text)?.[1] ?? NaN)).filter((n) => !Number.isNaN(n));
    assert(nums.length > 0 && nums.every((n, i) => i === 0 || n > nums[i - 1]), '消息按发送序送达');
    assert(recv.every((m) => m.text.startsWith('ping#')), '文本内容正确');
    console.log(`    ↳ 收到 ${recv.length} 条 · 首条@tick ${recv[0].tick} · 末尾#${nums[nums.length - 1]}`);
  }

  // ---- 4) 确定性 ----
  console.log('\n[4] 团战确定性（2v2 同 seed 双跑指纹一致）');
  {
    const a = buildTeamMatch({ mapId: 'arena_ruins', size: 2, seed: 2026, durationMs: 45_000 });
    const b = buildTeamMatch({ mapId: 'arena_ruins', size: 2, seed: 2026, durationMs: 45_000 });
    await a.runToEnd();
    await b.runToEnd();
    assert(matchFingerprint(a) === matchFingerprint(b), '2v2 双跑指纹一致');
  }

  console.log('\n✓ M3 团战内核验收通过');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
