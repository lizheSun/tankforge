import { BUILD_PRESETS, cpSpent, emptyBuild, resolveStats, type BuildPreset } from '../game/build';
import { BUILTIN_BOTS } from '../game/bots';
import { MAP_IDS } from '../game/map';
import type { BuildPoints, ResolvedStats, Team } from '../game/types';
import type { ReplaySideRecord } from '../replay/replay';

export type DriverKind = 'bot' | 'script' | 'pack';
export type BotId = 'rookie' | 'veteran' | 'master';

export interface StrategyPackMeta {
  fileName: string;
  name: string;
  version: string;
  author: string;
  desc: string;
  brainFile: string;
  cp: number;
}

export interface SideSetup {
  team: Team;
  kind: DriverKind;
  botId: BotId;
  /** 决策代码：script / pack 有效（pack 载入时快照进此处） */
  code: string;
  /** 预设 build 索引；当 points 非空时忽略此索引（自定义 build） */
  buildIdx: number;
  /** 非空 = 自定义能力点（pack 上传或回放载入） */
  points: BuildPoints | null;
  /** kind === 'pack' 时的元信息 */
  pack: StrategyPackMeta | null;
  /** 对局内显示名覆盖（如线上赛事的坦克实名；不填走 kind 默认名） */
  name?: string | null;
}

export interface BattleSetupData {
  /** 每侧独立成员（每车独立驾驶员/Worker/记忆；1v1 = 单元素数组） */
  red: SideSetup[];
  blue: SideSetup[];
  mapId: string;
  durationMs: number;
  seed: number;
}

export const TEAM_SIZE_MIN = 1;
export const TEAM_SIZE_MAX = 5;

/** 深拷贝 side（每车实例独立，Worker 各自持有记忆） */
export function cloneSide(s: SideSetup): SideSetup {
  return {
    ...s,
    code: s.code,
    points: s.points ? { ...s.points } : null,
    pack: s.pack ? { ...s.pack } : null,
  };
}

/** 以 seed 为模板生成 n 辆（同策略多挂载，各自独立实例） */
export function makeRoster(seedSide: SideSetup, n: number): SideSetup[] {
  const list: SideSetup[] = [];
  for (let i = 0; i < n; i++) list.push(cloneSide(seedSide));
  return list;
}

export const sideSize = (d: BattleSetupData, team: Team) => (team === 'red' ? d.red : d.blue).length;
export const totalTanks = (d: BattleSetupData) => d.red.length + d.blue.length;

export const DEFAULT_CODE = `// 你是坦克大脑：每 5 tick（约 83ms）被调用一次
// 可读：ctx.self / ctx.view.enemies / ctx.events / ctx.timeLeftMs / ctx.rng()
// 返回意图 Action[]：
//   {t:'throttle',v:-1..1} {t:'steer',v:-1..1} {t:'steerTo',deg}
//   {t:'turretTo',deg}     {t:'fire'}  {t:'turretAuto'}(需auto自瞄档)
function decide(ctx) {
  const e = ctx.view.enemies
    .slice()
    .sort((a, b) => a.dist - b.dist)[0];
  if (!e) return [{ t: 'throttle', v: 0.3 }, { t: 'turretTo', deg: ctx.self.heading }];
  // 朝目标方向行驶
  const aim = Math.atan2(e.pos.y - ctx.self.pos.y, e.pos.x - ctx.self.pos.x) * 180 / Math.PI;
  const acts = [];
  acts.push({ t: 'throttle', v: 1 });
  acts.push({ t: 'steer', v: clamp(aim - ctx.self.heading, -1, 1) / 60 });
  acts.push({ t: 'turretTo', deg: aim });
  // 视线大致对准就开火
  if (Math.abs(wrap(aim - ctx.self.turret)) < 14 && ctx.self.cooldownMs <= 0) acts.push({ t: 'fire' });
  return acts;
}
// ---------- 工具（可自行添加函数）----------
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function wrap(d) { while (d > 180) d -= 360; while (d <= -180) d += 360; return d; }
`;

export function makeSide(team: Team): SideSetup {
  const redLike = team === 'red';
  return {
    team,
    kind: 'bot',
    botId: redLike ? 'master' : 'veteran',
    code: DEFAULT_CODE,
    buildIdx: redLike ? 4 : 3,
    points: null,
    pack: null,
  };
}

export function defaultCodeOf(team: Team): string {
  return DEFAULT_CODE;
}

export { BUILD_PRESETS, BUILTIN_BOTS, MAP_IDS };
export const BUILTIN_BOT_BY_ID = (id: BotId) => BUILTIN_BOTS.find((b) => b.id === id)!;
export const PRESET_BY_IDX = (i: number) => BUILD_PRESETS[i];

// ------------------------------------------------------------
// side 派生查询（UI + 布阵/Battle 共用，保证口径一致）
// ------------------------------------------------------------

export interface EffectiveBuild {
  name: string;
  desc: string;
  points: BuildPoints;
  presetIdx: number;
  cp: number;
}

/** 实际生效的 build（自定义 points 优先，否则 preset） */
export function sideBuild(s: SideSetup): EffectiveBuild {
  if (s.points) {
    const cp = cpSpent(s.points);
    return {
      name: s.pack ? `「${s.pack.name}」自带 Build` : '自定义 Build',
      desc: s.pack ? `策略包内置能力点 · ${cp}/12 CP` : `编辑器自定义能力点 · ${cp}/12 CP`,
      points: s.points,
      presetIdx: -1,
      cp,
    };
  }
  const p: BuildPreset = BUILD_PRESETS[s.buildIdx] ?? BUILD_PRESETS[0];
  return {
    name: p.name,
    desc: p.desc,
    points: p.points,
    presetIdx: s.buildIdx,
    cp: cpSpent(p.points),
  };
}

export function sideStats(s: SideSetup): ResolvedStats {
  return resolveStats(sideBuild(s).points);
}

/** 对局中展示名 */
export function sideDriverName(s: SideSetup): string {
  if (s.name) return s.name;
  if (s.kind === 'bot') return BUILTIN_BOT_BY_ID(s.botId).name;
  if (s.kind === 'pack') return s.pack ? s.pack.name : '自定义策略包';
  return s.team === 'red' ? '用户脚本·红' : '用户脚本·蓝';
}

/** 决策代码（script/pack） */
export function sideCodeOf(s: SideSetup): string {
  return s.code || DEFAULT_CODE;
}

/** 快照一个干净的 script/pack 侧（用于 zip 上传：代码 + 自带 build） */
export function packToSide(team: Team, name: string, code: string, points: BuildPoints, meta: StrategyPackMeta): SideSetup {
  return {
    team,
    kind: 'pack',
    botId: 'rookie',
    code,
    buildIdx: -1,
    points: { ...emptyBuild(), ...points },
    pack: meta,
  };
}

/** bot 内置侧（默认 build 跟随 bot 预设） */
export function botToSide(team: Team, botId: BotId, buildIdx: number): SideSetup {
  return { team, kind: 'bot', botId, code: DEFAULT_CODE, buildIdx, points: null, pack: null };
}

export function scriptToSide(team: Team, code: string, buildIdx: number): SideSetup {
  return { team, kind: 'script', botId: 'rookie', code, buildIdx, points: null, pack: null };
}

// ------------------------------------------------------------
// 回放 ↔ side（回放记录含精确 BuildPoints，跨 preset 版本稳定复现）
// ------------------------------------------------------------

export function sideFromReplay(r: ReplaySideRecord, team: Team): SideSetup {
  if (r.kind === 'bot' && r.botId) {
    return {
      team,
      kind: 'bot',
      botId: r.botId,
      code: DEFAULT_CODE,
      buildIdx: -1,
      points: { ...emptyBuild(), ...r.points },
      pack: null,
    };
  }
  return {
    team,
    kind: r.kind,
    botId: 'rookie',
    code: r.code ?? DEFAULT_CODE,
    buildIdx: -1,
    points: { ...emptyBuild(), ...r.points },
    pack: r.pack
      ? {
          fileName: 'replay-pack',
          name: r.pack.name,
          version: r.pack.version,
          author: r.pack.author,
          desc: '',
          brainFile: r.pack.brainFile,
          cp: cpSpent(r.points),
        }
      : null,
  };
}
