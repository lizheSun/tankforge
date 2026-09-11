// ============================================================
// TANKFORGE · 策略包（.zip）真实流程
// 包结构：manifest.json + brain/main.js + (可选 assets)
// manifest.build 直接声明 BuildPoints（能力点分配）
// 校验规则同 docs/BATTLE_SPEC.md §4（CP ≤ 12、档位不超限）
// ============================================================
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { emptyBuild, resolveStats, validateBuild, cpSpent } from '../game/build';
import type { BuildPoints, ResolvedStats } from '../game/types';

export const PACK_FORMAT = 1;
export const PACK_MAX_BYTES = 2 * 1024 * 1024; // 压缩包上限 2MB

export interface StrategyPack {
  fileName: string;
  name: string;
  version: string;
  author: string;
  desc: string;
  brainFile: string;
  code: string;
  points: BuildPoints;
  entries: string[];
  cp: number;
}

export interface StrategyPackStats extends ResolvedStats {
  cp: number;
  dps: number;
  ttkOnDefault: number; // 打默认坦克(HP100)的理想击杀秒数
}

export function packStats(p: StrategyPack): StrategyPackStats {
  const s = resolveStats(p.points);
  const dps = s.damage / (s.fireIntervalMs / 1000);
  return {
    ...s,
    cp: cpSpent(p.points),
    dps,
    ttkOnDefault: 100 / dps,
  };
}

// ------------------------------------------------------------
// 解析（上传 / 载入）
// ------------------------------------------------------------

function readUtf8(files: Record<string, Uint8Array>, path: string): string | null {
  const key = Object.keys(files).find(
    (k) => k.replace(/\\/g, '/') === path || k.replace(/\\/g, '/') === `./${path}`,
  );
  if (!key) return null;
  return strFromU8(files[key]);
}

type NumericPointKey = { [K in keyof BuildPoints]: BuildPoints[K] extends number ? K : never }[keyof BuildPoints];
const POINT_KEYS: NumericPointKey[] = [
  'armor',
  'engine',
  'tracks',
  'fireRate',
  'damage',
  'turret',
  'shellSpeed',
  'view',
  'comm',
];

function parsePoints(raw: unknown): { points?: BuildPoints; error?: string } {
  if (raw == null) return { points: emptyBuild() };
  if (typeof raw !== 'object') return { error: 'build 必须是对象' };
  const o = raw as Record<string, unknown>;
  const b = emptyBuild();
  for (const k of POINT_KEYS) {
    const v = o[k];
    if (v != null) {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return { error: `build.${k} 须为非负整数` };
      b[k] = v;
    }
  }
  for (const k of ['aimAssist', 'aimAuto'] as const) {
    const v = o[k];
    if (v != null) {
      if (typeof v !== 'boolean') return { error: `build.${k} 须为布尔值` };
      b[k] = v;
    }
  }
  const err = validateBuild(b);
  return err ? { error: err } : { points: b };
}

export interface PackParseResult {
  pack: StrategyPack | null;
  errors: string[];
}

export function parseStrategyPackZip(buf: ArrayBuffer, fileName = 'strategy.zip'): PackParseResult {
  const errors: string[] = [];
  if (buf.byteLength > PACK_MAX_BYTES) {
    return { pack: null, errors: [`策略包超过 ${PACK_MAX_BYTES / 1024 / 1024}MB 上限`] };
  }
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(buf));
  } catch (e) {
    return { pack: null, errors: [`无法解压 zip：${e instanceof Error ? e.message : String(e)}`] };
  }
  const norm = Object.fromEntries(
    Object.entries(files).map(([k, v]) => [k.replace(/\\/g, '/').replace(/^\.\//, ''), v]),
  );
  const manifestRaw = readUtf8(norm, 'manifest.json');
  if (manifestRaw == null) {
    return { pack: null, errors: ['未找到 manifest.json（必须位于压缩包根目录）'] };
  }
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(manifestRaw);
  } catch (e) {
    return { pack: null, errors: [`manifest.json 不是合法 JSON：${e instanceof Error ? e.message : String(e)}`] };
  }
  if (manifest.format !== PACK_FORMAT) errors.push(`manifest.format 须为 ${PACK_FORMAT}`);
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) errors.push('缺少策略包名称 manifest.name');
  if (typeof manifest.version !== 'string' || !manifest.version.trim()) errors.push('缺少版本号 manifest.version');

  const brainFile =
    typeof manifest.brain === 'string' && manifest.brain.trim()
      ? manifest.brain.trim().replace(/^\.\//, '')
      : 'brain/main.js';
  const code = readUtf8(norm, brainFile);
  if (code == null) errors.push(`未找到 brain 入口：${brainFile}`);

  const buildRes = parsePoints(manifest.build);
  if (buildRes.error) errors.push(`build 配置不合法：${buildRes.error}`);

  if (errors.length) return { pack: null, errors };

  const author = typeof manifest.author === 'string' ? manifest.author : '';
  const desc = typeof manifest.desc === 'string' ? manifest.desc : '';
  const points = buildRes.points!;
  const pack: StrategyPack = {
    fileName,
    name: manifest.name as string,
    version: manifest.version as string,
    author,
    desc,
    brainFile,
    code: code as string,
    points,
    entries: Object.keys(norm).sort(),
    cp: cpSpent(points),
  };
  return { pack, errors };
}

// ------------------------------------------------------------
// 生成模板包（可下载 .zip 供作者编写后重新上传）
// ------------------------------------------------------------

export const SAMPLE_BRAIN_CODE = `// brain/main.js — 「哨兵-9」官方示例战术
// 每 5 tick(≈83ms) 调用一次 decide(ctx) → 返回 Action[]
// 可用：ctx.self / ctx.view.enemies / ctx.events / ctx.timeLeftMs / ctx.rng()
// Action：{t:'throttle',v} {t:'steer',v} {t:'steerTo',deg} {t:'turretTo',deg} {t:'turretAuto'} {t:'fire'}

const RAD2DEG = 180 / Math.PI;
function wrap(d) { while (d > 180) d -= 360; while (d <= -180) d += 360; return d; }
function clamp1(v) { return Math.max(-1, Math.min(1, v)); }

// 简易记忆：跨帧状态用函数内部变量在 Worker 内保持（同一 worker 全局存活）
let lastTargetSeen = -1;

function decide(ctx) {
  const es = ctx.view.enemies.slice().sort((a, b) => a.dist - b.dist);
  const e = es[0];
  if (!e) {
    // 未发现目标：按时间改变巡逻航向，保持索敌
    const ph = ctx.clockMs / 1000 % 12 < 6 ? 45 : 225;
    return [
      { t: 'throttle', v: 0.65 },
      { t: 'steerTo', deg: ph },
      { t: 'turretTo', deg: ctx.self.heading },
    ];
  }
  lastTargetSeen = ctx.tick;
  const toTarget = Math.atan2(e.pos.y - ctx.self.pos.y, e.pos.x - ctx.self.pos.x) * RAD2DEG;

  // 火力压制 + 低血后撤
  const retreat = ctx.self.hp / ctx.self.maxHp < 0.35;
  const acts = [];
  if (retreat) {
    acts.push({ t: 'throttle', v: 1 });
    acts.push({ t: 'steerTo', deg: wrap(toTarget + 180) });
  } else {
    // 侧滑逼近：在 150~260px 保持压制圈
    const drift = e.dist < 150 ? -1 : 1;
    acts.push({ t: 'throttle', v: 1 });
    acts.push({ t: 'steerTo', deg: wrap(toTarget + 40 * drift) });
  }
  // 炮塔始终指向目标，误差 <8° 且装填完毕即开火
  acts.push({ t: 'turretTo', deg: toTarget });
  if (ctx.self.cooldownMs <= 0 && Math.abs(wrap(toTarget - ctx.self.turret)) < 8) acts.push({ t: 'fire' });
  return acts;
}
`;

function buildObj(p: BuildPoints): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const k of POINT_KEYS) o[k] = p[k];
  o.aimAssist = p.aimAssist;
  o.aimAuto = p.aimAuto;
  return o;
}

export function makeTemplatePack(over: Partial<Pick<StrategyPack, 'name' | 'version' | 'author' | 'desc'>> = {}): StrategyPack {
  const points: BuildPoints = { ...emptyBuild(), damage: 4, fireRate: 4, aimAssist: true, view: 1, shellSpeed: 1, tracks: 1 };
  return {
    fileName: 'sentinel-9.zip',
    name: over.name ?? '哨兵-9',
    version: over.version ?? '1.0.0',
    author: over.author ?? '',
    desc: over.desc ?? '示例策略包：压制圈走位 + 低血后撤 + 冷却即射（assist 自算提前量进阶示例见注释）',
    brainFile: 'brain/main.js',
    code: SAMPLE_BRAIN_CODE,
    points,
    entries: ['manifest.json', 'brain/main.js'],
    cp: cpSpent(points),
  };
}

/** 打包 zip 字节（用于「下载模板 / 导出我的策略包」） */
export function buildPackZip(p: StrategyPack): Uint8Array {
  const manifest = {
    format: PACK_FORMAT,
    name: p.name,
    version: p.version,
    author: p.author,
    desc: p.desc,
    brain: p.brainFile,
    build: buildObj(p.points),
  };
  return zipSync({
    'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
    [p.brainFile]: strToU8(p.code),
  });
}

export function downloadBytes(bytes: Uint8Array, fileName: string) {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const blob = new Blob([buf], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
