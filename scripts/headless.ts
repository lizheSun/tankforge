// M1 冒烟测试：完整跑一局 1v1，校验胜负/统计/确定性
import { BUILD_PRESETS, resolveStats } from '../src/game/build';
import { masterDecide, rookieDecide, veteranDecide } from '../src/game/bots';
import { MAX_SANCTIONS } from '../src/game/constants';
import { buildMap } from '../src/game/map';
import { MatchRunner, type SideDriver } from '../src/game/runner';
import type { Action } from '../src/game/types';

function botOf(team: 'red' | 'blue', id: 'rookie' | 'veteran' | 'master'): SideDriver {
  const fn = id === 'rookie' ? rookieDecide : id === 'veteran' ? veteranDecide : masterDecide;
  return { team, name: id.toUpperCase(), kind: 'bot', decide: fn };
}

/** 各 bot 默认 preset 索引（BUILD_PRESETS） */
const PRESET_BY_NAME: Record<string, number> = { ROOKIE: 0, VETERAN: 3, MASTER: 4 };

async function runOne(
  tag: string,
  red: SideDriver,
  blue: SideDriver,
  seed: number,
  opts: { redPreset?: number; bluePreset?: number; decisionTimeoutMs?: number } = {},
) {
  const map = buildMap('arena_ruins');
  const redPreset = opts.redPreset ?? PRESET_BY_NAME[red.name];
  const bluePreset = opts.bluePreset ?? PRESET_BY_NAME[blue.name];
  const statsFor = (i: number) => resolveStats(BUILD_PRESETS[i].points);
  const runner = new MatchRunner({
    config: {
      tiles: map.tiles,
      seed,
      durationMs: 90_000,
      friendlyFire: false,
      spawns: [
        { id: 'red', team: 'red', name: red.name, buildName: BUILD_PRESETS[redPreset].name, stats: statsFor(redPreset), pos: { x: 140, y: 140 }, heading: 45 },
        { id: 'blue', team: 'blue', name: blue.name, buildName: BUILD_PRESETS[bluePreset].name, stats: statsFor(bluePreset), pos: { x: 1060, y: 660 }, heading: 225 },
      ],
    },
    red,
    blue,
    decisionTimeoutMs: opts.decisionTimeoutMs,
  });
  const t0 = performance.now();
  await runner.runToEnd();
  const m = runner.m;
  const res = m.result!;
  const tanks = [...m.tanks.values()].map((t) => ({
    n: t.name,
    hp: t.hp,
    shots: t.shotsFired,
    hits: t.hits,
    dmg: t.damageDealt,
    sanctions: t.sanctions,
    alive: t.alive,
  }));
  console.log(
    `[${tag}] ${(performance.now() - t0).toFixed(0)}ms ticks=${m.tick} 胜者=${res.winner ?? '平'} 原因=${res.reason}`,
  );
  console.log('  ' + JSON.stringify(tanks));
  return { m, res };
}

async function main() {
  // 1) 菜鸟 vs 老兵：应互相交火并有明确战果（否则巡逻/视野逻辑有 bug）
  const g1 = await runOne('veteran(蓝) vs rookie(红)', botOf('red', 'rookie'), botOf('blue', 'veteran'), 42);
  const g1Tanks = [...g1.m.tanks.values()];
  const totalShots = g1Tanks.reduce((s, t) => s + t.shotsFired, 0);
  if (totalShots === 0) {
    console.error('✗ 双方零交火：巡逻/接敌逻辑失效');
    process.exit(1);
  }

  // 2) 大师 vs 老兵（auto 自瞄 build）
  const g2 = await runOne('master(红/auto) vs veteran(蓝)', botOf('red', 'master'), botOf('blue', 'veteran'), 7);
  const master = [...g2.m.tanks.values()].find((t) => t.name === 'MASTER')!;
  if (master.sanctions > 0) {
    console.error(`✗ MASTER 出现 ${master.sanctions} 次违规（aim 档配置不符）`);
    process.exit(1);
  }

  // 3) 降级回归：MASTER 挂非 auto（assist 游侠）Build → 不得发 turretAuto，全程 0 违规、不失联
  const g3 = await runOne('master(红/assist降级) vs veteran(蓝)', botOf('red', 'master'), botOf('blue', 'veteran'), 99, {
    redPreset: 3,
  });
  const masterAssist = [...g3.m.tanks.values()].find((t) => t.name === 'MASTER')!;
  if (masterAssist.sanctions > 0) {
    console.error(`✗ MASTER 挂 assist Build 累计 ${masterAssist.sanctions} 次非法意图（降级未生效，将判失联）`);
    process.exit(1);
  }

  // 4) 确定性：同 seed 同配置两次完全一致
  const a = await runOne('DET-A', botOf('red', 'master'), botOf('blue', 'veteran'), 2026);
  const b = await runOne('DET-B(同seed)', botOf('red', 'master'), botOf('blue', 'veteran'), 2026);
  const sig = (x: { m: ReturnType<typeof createRun>['m']; res: ReturnType<typeof createRun>['res'] }) =>
    JSON.stringify({
      w: x.res.winner,
      reason: x.res.reason,
      tanks: [...x.m.tanks.values()].map((t) => [
        t.hp,
        t.damageDealt,
        t.shotsFired,
        t.hits,
        Math.round(t.pos.x),
        Math.round(t.pos.y),
        t.sanctions,
      ]),
    });
  if (sig(a) !== sig(b)) {
    console.error('✗ 确定性校验失败');
    process.exit(1);
  }
  // 5) 失联回归：脚本 decide() 永不返回 → 每帧 NOOP + 连续无响应累计 sanction，100 次判失联，引擎不卡死
  const hung: SideDriver = {
    team: 'red',
    name: 'HUNG',
    kind: 'script',
    decide: () => new Promise<Action[]>(() => {}),
  };
  const g5 = await runOne('hung(红/失联) vs veteran(蓝)', hung, botOf('blue', 'veteran'), 11, {
    redPreset: 3,
    decisionTimeoutMs: 2,
  });
  const hungTank = [...g5.m.tanks.values()].find((t) => t.name === 'HUNG')!;
  if (hungTank.alive || hungTank.sanctions < MAX_SANCTIONS || g5.res.winner !== 'blue') {
    console.error(
      `✗ 失联机制未生效：alive=${hungTank.alive} sanctions=${hungTank.sanctions} winner=${g5.res.winner}`,
    );
    process.exit(1);
  }

  console.log('✓ 冒烟通过：交火正常 / auto 无违规 / assist 降级无违规不失联 / 失联超时判罚生效 / 确定性一致');
  process.exit(0);
}

function createRun() {
  return { m: null as never, res: null as never };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
