// ============================================================
// M2 回放 round-trip：跑一局 → 导出回放 JSON → 载入重建 → 同种子重演
// 验证：重演指纹 === 存档指纹（确定性复现）
// 用法：npx tsx scripts/replaycheck.ts [seed]
// ============================================================
import { BUILD_PRESETS, resolveStats } from '../src/game/build';
import { masterDecide, veteranDecide } from '../src/game/bots';
import { buildMap } from '../src/game/map';
import { MatchRunner, type SideDriver } from '../src/game/runner';
import type { BuildPoints, Team } from '../src/game/types';
import { buildReplay, matchFingerprint, parseReplayJson, type ReplaySideRecord } from '../src/replay/replay';

const MAP = 'arena_ruins';
const P = { red: BUILD_PRESETS[4], blue: BUILD_PRESETS[3] }; // master / veteran 预设

function botDriver(team: Team, kind: 'master' | 'veteran'): SideDriver {
  return { team, name: kind.toUpperCase(), kind: 'bot', decide: kind === 'master' ? masterDecide : veteranDecide };
}

function spawns(redPoints: BuildPoints, bluePoints: BuildPoints) {
  return {
    red: { stats: resolveStats(redPoints), x: 150, y: 150, heading: 45 },
    blue: { stats: resolveStats(bluePoints), x: 1050, y: 650, heading: 225 },
  };
}

function record(team: Team, name: string, points: BuildPoints, buildName: string): ReplaySideRecord {
  return {
    team,
    kind: 'bot',
    botId: (name === 'MASTER' ? 'master' : 'veteran') as ReplaySideRecord['botId'],
    name,
    buildName,
    points,
    code: null,
    pack: null,
  };
}

async function main() {
  const seed = Number(process.argv[2]) || 424242;
  const map = buildMap(MAP);
  const first = spawns(P.red.points, P.blue.points);

  // —— 第一局（录制）——
  const r1 = new MatchRunner({
    config: { tiles: map.tiles, seed, durationMs: 90_000, friendlyFire: false, spawns: [
      { id: 'red', team: 'red', name: 'MASTER', buildName: P.red.name, stats: first.red.stats, pos: { x: first.red.x, y: first.red.y }, heading: first.red.heading },
      { id: 'blue', team: 'blue', name: 'VETERAN', buildName: P.blue.name, stats: first.blue.stats, pos: { x: first.blue.x, y: first.blue.y }, heading: first.blue.heading },
    ] },
    red: botDriver('red', 'master'),
    blue: botDriver('blue', 'veteran'),
  });
  await r1.runToEnd();
  const fp1 = matchFingerprint(r1);
  const replay = buildReplay({
    title: `roundtrip #${seed}`,
    mapId: MAP,
    seed,
    durationMs: 90_000,
    red: [record('red', 'MASTER', P.red.points, P.red.name)],
    blue: [record('blue', 'VETERAN', P.blue.points, P.blue.name)],
    runner: r1,
  });

  // —— JSON 序列化后载入（模拟下载→上传）——
  const text = JSON.stringify(replay);
  const loaded = parseReplayJson(text);
  if (!loaded.replay) throw new Error('回放载入失败: ' + loaded.errors.join('; '));
  const rep = loaded.replay;
  const redRec = rep.setup.red[0];
  const blueRec = rep.setup.blue[0];
  const second = spawns(redRec.points, blueRec.points);

  // —— 第二局（重演）——
  const r2 = new MatchRunner({
    config: { tiles: map.tiles, seed: rep.setup.seed, durationMs: rep.setup.durationMs, friendlyFire: false, spawns: [
      { id: 'red', team: 'red', name: redRec.name, buildName: redRec.buildName, stats: second.red.stats, pos: { x: second.red.x, y: second.red.y }, heading: second.red.heading },
      { id: 'blue', team: 'blue', name: blueRec.name, buildName: blueRec.buildName, stats: second.blue.stats, pos: { x: second.blue.x, y: second.blue.y }, heading: second.blue.heading },
    ] },
    red: botDriver('red', 'master'),
    blue: botDriver('blue', 'veteran'),
  });
  await r2.runToEnd();
  const fp2 = matchFingerprint(r2);

  console.log(`seed=${seed}`);
  console.log(`  存档指纹: ${fp1}`);
  console.log(`  重演指纹: ${fp2}`);
  if (fp1 !== fp2) {
    console.error('✗ 回放重演漂移：无法复现原局');
    process.exit(1);
  }
  console.log(`✓ 回放 round-trip 通过：${rep.outcome.winner ?? 'draw'}(${rep.outcome.reason}) @tick ${rep.outcome.tick} · 指纹逐项一致`);
  process.exit(0);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
