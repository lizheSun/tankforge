import {
  AIM_ASSIST_CP,
  AIM_AUTO_CP,
  CP_BUDGET,
  TIER,
} from './constants';
import type { BuildPoints, ResolvedStats } from './types';

export function emptyBuild(): BuildPoints {
  return {
    armor: 0,
    engine: 0,
    tracks: 0,
    fireRate: 0,
    damage: 0,
    turret: 0,
    shellSpeed: 0,
    view: 0,
    aimAssist: false,
    aimAuto: false,
    comm: 0,
  };
}

export function cpSpent(b: BuildPoints): number {
  return (
    b.armor +
    b.engine +
    b.tracks +
    b.fireRate +
    b.damage +
    b.turret +
    b.shellSpeed +
    b.view +
    (b.aimAssist ? AIM_ASSIST_CP : 0) +
    (b.aimAuto ? AIM_AUTO_CP : 0) +
    b.comm
  );
}

/** 越界 / 超预算返回错误信息；合法返回 null */
export function validateBuild(b: BuildPoints): string | null {
  const t = TIER;
  const isBadNum = (v: number) => !Number.isFinite(v) || !Number.isInteger(v) || v < 0;
  if (['armor', 'engine', 'tracks', 'fireRate', 'damage', 'turret', 'shellSpeed', 'view', 'comm'].some((k) =>
    isBadNum(b[k as keyof BuildPoints] as number),
  ))
    return '能力点必须为非负整数';
  if (typeof b.aimAssist !== 'boolean' || typeof b.aimAuto !== 'boolean') return '瞄具档必须为布尔值';
  if (b.armor > t.armor.max || b.engine > t.engine.max || b.tracks > t.tracks.max) return '属性档位超上限';
  if (b.fireRate > t.fireRate.max || b.damage > t.damage.max || b.turret > t.turret.max) return '火控档位超上限';
  if (b.shellSpeed > t.shellSpeed.max || b.view > t.view.max || b.comm > t.comm.max) return '属性档位超上限';
  if (b.aimAuto && b.aimAssist) return 'assist 与 auto 互斥';
  const spent = cpSpent(b);
  if (spent > CP_BUDGET) return `能力点超预算：${spent}/${CP_BUDGET}`;
  return null;
}

export function resolveStats(b: BuildPoints): ResolvedStats {
  const t = TIER;
  const aim: ResolvedStats['aim'] = b.aimAuto ? 'auto' : b.aimAssist ? 'assist' : 'manual';
  return {
    hpMax: t.armor.base + b.armor * t.armor.per,
    moveSpeed: t.engine.base + b.engine * t.engine.per,
    turnRate: t.tracks.base + b.tracks * t.tracks.per,
    fireIntervalMs: Math.max(200, t.fireRate.base + b.fireRate * t.fireRate.per),
    damage: t.damage.base + b.damage * t.damage.per,
    turretSpeed: t.turret.base + b.turret * t.turret.per,
    shellSpeed: t.shellSpeed.base + b.shellSpeed * t.shellSpeed.per,
    viewRadius: t.view.base + b.view * t.view.per,
    aim,
    commSlots: t.comm.base + b.comm * t.comm.per,
  };
}

export interface BuildPreset {
  name: string;
  desc: string;
  points: BuildPoints;
}

/** 官方预设 build（BATTLE_SPEC §4 示例原型 + 默认/重坦/游侠） */
export const BUILD_PRESETS: BuildPreset[] = [
  { name: '默认原型', desc: '0CP 平衡参照', points: emptyBuild() },
  {
    name: '玻璃炮',
    desc: '伤害+4 装填+4 → DPS 42.9',
    points: { ...emptyBuild(), damage: 4, fireRate: 4, aimAssist: true, view: 1, shellSpeed: 1, tracks: 1 },
  },
  {
    name: '重装甲',
    desc: 'HP 190 抗线缠斗',
    points: { ...emptyBuild(), armor: 6, tracks: 2, engine: 2, aimAssist: true, fireRate: 1 },
  },
  {
    name: '游侠',
    desc: '高速侦察风筝',
    points: { ...emptyBuild(), engine: 4, tracks: 3, view: 3, aimAssist: true, damage: 1 },
  },
  {
    name: '神枪手(auto)',
    desc: '自瞄+火控 3CP',
    points: { ...emptyBuild(), aimAuto: true, fireRate: 1, damage: 1, tracks: 1, armor: 1, engine: 1 },
  },
];
