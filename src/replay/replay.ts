// ============================================================
// TANKFORGE · 回放文件
// demo/自定义策略对局 → 可下载 .tfreplay.json
// 回放 = 确定性重演：文件中保存 地图/种子/时长/双方策略(含代码与Build点)，
// 载入后用同一种子重跑，得到逐 tick 一致的结果（对局指纹校验）。
// ============================================================
import { cpSpent, validateBuild } from '../game/build';
import { snapshot } from '../game/engine';
import type { MatchRunner } from '../game/runner';
import type { BuildPoints, MatchResult, Team } from '../game/types';

export const REPLAY_FORMAT = 'tankforge-replay';
export const REPLAY_VERSION = 2;
export const ENGINE_VERSION = '0.1.0';

export type SideDriverKind = 'bot' | 'script' | 'pack';

export interface ReplaySideRecord {
  team: Team;
  kind: SideDriverKind;
  botId: 'rookie' | 'veteran' | 'master' | null;
  /** 对局内显示名 */
  name: string;
  buildName: string;
  points: BuildPoints;
  code: string | null; // bot=null
  pack: { name: string; version: string; author: string; brainFile: string } | null;
}

export interface ReplayFile {
  format: typeof REPLAY_FORMAT;
  version: number;
  engine: string;
  savedAt: string;
  title: string;
  setup: {
    mapId: string;
    seed: number;
    durationMs: number;
    /** v2+ 数组（每车一记录；v1 单侧已归一化为单元素数组） */
    red: ReplaySideRecord[];
    blue: ReplaySideRecord[];
  };
  outcome: {
    winner: Team | null;
    draw: boolean;
    reason: MatchResult['reason'];
    tick: number;
    ms: number;
  };
  /** 终局状态指纹：重演后必须一致 */
  fingerprint: string;
}

// ------------------------------------------------------------
// 确定性指纹（非加密用途；同步、跨平台稳定）
// ------------------------------------------------------------

function hashString(input: string): string {
  // FNV-1a 双盐 64bit 折叠为 hex
  const fnv = (seed: number): number => {
    let h = seed >>> 0;
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  };
  const a = fnv(0x811c9dc5).toString(16).padStart(8, '0');
  const b = fnv(0x01000193).toString(16).padStart(8, '0');
  const c = fnv(0xdeadbeef).toString(16).padStart(8, '0');
  return `${a}${b}${c}`.slice(0, 24);
}

/** 终局指纹：双方坦克终态 + 墙体耐久 + 结算 → 规范 JSON → 哈希 */
export function matchFingerprint(runner: MatchRunner): string {
  const m = runner.m;
  const snap = snapshot(m);
  const tanks = snap.tanks
    .slice()
    .sort((a, b) => (a.team === b.team ? 0 : a.team < b.team ? -1 : 1))
    .map((t) => ({
      team: t.team,
      hp: Math.round(t.hp * 1000) / 1000,
      alive: t.alive,
      x: Math.round(t.pos.x * 1000) / 1000,
      y: Math.round(t.pos.y * 1000) / 1000,
      heading: Math.round(t.heading * 1000) / 1000,
      turret: Math.round(t.turret * 1000) / 1000,
      dmg: Math.round(t.damageDealt * 1000) / 1000,
      shots: t.shotsFired,
      hits: t.hits,
      dist: Math.round(t.distTravelled * 1000) / 1000,
      sanctions: t.sanctions,
      killTick: t.killTick,
    }));
  const walls = [...snap.wallHp.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, v]) => v > 0)
    .slice(0, 400);
  const canonical = JSON.stringify({ tanks, walls, result: snap.result });
  return hashString(canonical);
}

export function fingerprintFromResultJson(json: string): string {
  return hashString(json);
}

// ------------------------------------------------------------
// 构造 / 序列化
// ------------------------------------------------------------

export function buildReplay(opts: {
  title: string;
  mapId: string;
  seed: number;
  durationMs: number;
  red: ReplaySideRecord[];
  blue: ReplaySideRecord[];
  runner: MatchRunner;
}): ReplayFile {
  const { runner } = opts;
  const res = runner.m.result ?? {
    winner: null,
    draw: true,
    reason: null,
    teamTotalDamage: { red: 0, blue: 0 },
    teamAlive: { red: 0, blue: 0 },
    teamHpLeft: { red: 0, blue: 0 },
    tankResults: [],
  };
  return {
    format: REPLAY_FORMAT,
    version: REPLAY_VERSION,
    engine: ENGINE_VERSION,
    savedAt: new Date().toISOString(),
    title: opts.title,
    setup: {
      mapId: opts.mapId,
      seed: opts.seed,
      durationMs: opts.durationMs,
      red: opts.red,
      blue: opts.blue,
    },
    outcome: {
      winner: res.winner,
      draw: res.draw,
      reason: res.reason,
      tick: runner.m.tick,
      ms: Math.round(runner.m.ms),
    },
    fingerprint: matchFingerprint(runner),
  };
}

// ------------------------------------------------------------
// 载入 / 校验
// ------------------------------------------------------------

export interface ReplayLoadResult {
  replay: ReplayFile | null;
  errors: string[];
}

export function saveReplayToFile(replay: ReplayFile) {
  const blob = new Blob([JSON.stringify(replay, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safe = replay.title.replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 60) || 'tankforge';
  a.href = url;
  a.download = `${safe}.tfreplay.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** v1 兼容：单侧记录视为 1 辆；校验每辆都携带 build 能力点 */
function sideListOf(raw: unknown): ReplaySideRecord[] | null {
  const list = Array.isArray(raw) ? raw : [raw];
  if (!list.length || list.some((x) => !x || typeof x !== 'object' || !(x as ReplaySideRecord).points)) return null;
  return list as ReplaySideRecord[];
}

export function parseReplayJson(text: string): ReplayLoadResult {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    return { replay: null, errors: [`回放文件不是合法 JSON：${e instanceof Error ? e.message : String(e)}`] };
  }
  const r = obj as Partial<ReplayFile>;
  const errs: string[] = [];
  if (r.format !== REPLAY_FORMAT) errs.push('不是 TANKFORGE 回放文件');
  else if ((r.version ?? 0) > REPLAY_VERSION) errs.push(`回放版本 v${r.version} 高于当前支持 v${REPLAY_VERSION}`);
  let redL: ReplaySideRecord[] | null = null;
  let blueL: ReplaySideRecord[] | null = null;
  if (!r.setup) errs.push('缺少 setup 段');
  else {
    redL = sideListOf(r.setup.red);
    blueL = sideListOf(r.setup.blue);
    if (!redL) errs.push('红方记录缺失/损坏（每辆需含 build 能力点）');
    if (!blueL) errs.push('蓝方记录缺失/损坏（每辆需含 build 能力点）');
    if (redL && blueL) {
      const bad = [...redL, ...blueL].find((s) => cpSpent(s.points) > 12);
      if (bad) errs.push('存在 build 能力点超过预算 12');
      const invalid = [...redL, ...blueL].find((s) => {
        if (typeof s.points !== 'object' || s.points === null) return true;
        const nums = ['armor', 'engine', 'tracks', 'fireRate', 'damage', 'turret', 'shellSpeed', 'view', 'comm'] as const;
        return (
          nums.some((k) => !Number.isFinite(s.points[k])) ||
          typeof s.points.aimAssist !== 'boolean' ||
          typeof s.points.aimAuto !== 'boolean' ||
          validateBuild(s.points) !== null
        );
      });
      if (invalid) errs.push('存在非法 build 能力点（档位越界/非数值/瞄具互斥）');
      const sizeOk = redL.length >= 1 && redL.length <= 5 && blueL.length >= 1 && blueL.length <= 5;
      if (!sizeOk) errs.push('每队成员数需在 1~5 之间');
    }
    if (typeof r.setup.seed !== 'number') errs.push('缺少 seed');
    if (typeof r.setup.mapId !== 'string') errs.push('缺少 mapId');
    if (typeof r.setup.durationMs !== 'number') errs.push('缺少 durationMs');
  }
  if (errs.length) return { replay: null, errors: errs };
  if (obj && typeof obj === 'object' && r.setup) {
    // v2 起统一规范为数组（单侧记录 = [record]）
    const s = (obj as { setup: Record<string, unknown> }).setup;
    s.red = redL;
    s.blue = blueL;
  }
  return { replay: r as ReplayFile, errors: [] };
}
