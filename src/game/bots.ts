import { angleDiff, normalizeDeg } from './engine';
import type { Action, Ctx } from './types';

const RAD2DEG = 180 / Math.PI;
const clamp1 = (v: number) => Math.max(-1, Math.min(1, v));
const CENTER = { x: 600, y: 400 };

function nearest(ctx: Ctx) {
  return ctx.view.enemies.slice().sort((a, b) => a.dist - b.dist)[0];
}
function worldAim(ctx: Ctx, x: number, y: number): number {
  return normalizeDeg(Math.atan2(y - ctx.self.pos.y, x - ctx.self.pos.x) * RAD2DEG);
}
function steerToward(ctx: Ctx, aimWorld: number): number {
  return clamp1(angleDiff(ctx.self.heading, aimWorld) / 60);
}
/** 无可见目标：向战场中心巡逻，制造接敌机会 */
function patrolCenter(ctx: Ctx, throttle = 0.7): Action[] {
  const aim = worldAim(ctx, CENTER.x, CENTER.y);
  return [{ t: 'throttle', v: throttle }, { t: 'steer', v: steerToward(ctx, aim) }];
}

// ------------------------------------------------------------
// ROOKIE-7 · manual · 直线冲锋，冷却即射（最弱门槛 Bot）
// ------------------------------------------------------------
export function rookieDecide(ctx: Ctx): Action[] {
  const t = nearest(ctx);
  const a: Action[] = [];
  if (!t) {
    return [...patrolCenter(ctx, 0.8), { t: 'turretTo', deg: worldAim(ctx, CENTER.x, CENTER.y) }];
  }
  const aim = worldAim(ctx, t.pos.x, t.pos.y);
  a.push({ t: 'throttle', v: 1 });
  a.push({ t: 'steer', v: steerToward(ctx, aim) });
  a.push({ t: 'turretTo', deg: aim });
  if (Math.abs(angleDiff(ctx.self.turret, aim)) < 14 && ctx.self.cooldownMs <= 0) {
    a.push({ t: 'fire' });
  }
  return a;
}

// ------------------------------------------------------------
// VETERAN-5 · assist · 侧向环绕 + 控距 + 低血后撤
// ------------------------------------------------------------
export function veteranDecide(ctx: Ctx): Action[] {
  const t = nearest(ctx);
  if (!t) {
    return patrolCenter(ctx, 0.7);
  }
  const a: Action[] = [];
  const toTarget = Math.atan2(t.pos.y - ctx.self.pos.y, t.pos.x - ctx.self.pos.x) * RAD2DEG;
  const orbitSign = Math.sin(ctx.clockMs / 900) >= 0 ? 1 : -1;
  // 切线环绕角（对目标向量 ±90°）
  let moveAngle = normalizeDeg(toTarget + 90 * orbitSign);
  const desired = 250;
  const dErr = t.dist - desired;
  // 太远则切入目标方向，太近则远离；压向 0 时保持环绕
  const corr = clamp1(dErr / 400) * 40;
  if (Math.abs(dErr) > 120) moveAngle = normalizeDeg(toTarget - Math.sign(dErr) * 20);
  else moveAngle = normalizeDeg(moveAngle + corr);
  const retreat = ctx.self.hp / ctx.self.maxHp < 0.45;
  const finalMove = retreat ? normalizeDeg(toTarget + 180) : moveAngle;
  a.push({ t: 'throttle', v: 1 });
  a.push({ t: 'steer', v: steerToward(ctx, finalMove) });
  // assist：数据无噪声，自算提前量
  let aim = toTarget;
  if (t.vel) {
    const est = t.vel;
    const sp = ctx.self.stats.shellSpeed;
    let tf = t.dist / sp;
    for (let i = 0; i < 3; i++) {
      const px = t.pos.x + est.dx * tf;
      const py = t.pos.y + est.dy * tf;
      tf = Math.hypot(px - ctx.self.pos.x, py - ctx.self.pos.y) / sp;
    }
    aim = Math.atan2(t.pos.y + est.dy * tf - ctx.self.pos.y, t.pos.x + est.dx * tf - ctx.self.pos.x) * RAD2DEG;
  }
  a.push({ t: 'turretTo', deg: normalizeDeg(aim) });
  if (Math.abs(angleDiff(ctx.self.turret, normalizeDeg(aim))) < 6) a.push({ t: 'fire' });
  return a;
}

// ------------------------------------------------------------
// MASTER-1 · auto · 引擎接管瞄准，火力全开 + 半血脱战
// ------------------------------------------------------------
export function masterDecide(ctx: Ctx): Action[] {
  const t = nearest(ctx);
  if (!t) {
    return patrolCenter(ctx, 0.9);
  }
  const a: Action[] = [];
  const toTarget = Math.atan2(t.pos.y - ctx.self.pos.y, t.pos.x - ctx.self.pos.x) * RAD2DEG;
  const lowHp = ctx.self.hp / ctx.self.maxHp < 0.3;
  const close = t.dist < 200;
  if (lowHp || close) {
    // 低血远离目标；被贴脸则面向目标倒车拉开距离（保持炮口对敌）
    const flee = !close;
    a.push({ t: 'throttle', v: flee ? 1 : -1 });
    a.push({ t: 'steer', v: steerToward(ctx, normalizeDeg(flee ? toTarget + 180 : toTarget)) });
  } else {
    // 大圈环绕压制
    const circle = Math.sin(ctx.clockMs / 1200) * 0.7;
    a.push({ t: 'throttle', v: 1 });
    a.push({ t: 'steer', v: clamp1(angleDiff(ctx.self.heading, normalizeDeg(toTarget + 110 * circle)) / 45) });
  }
  // 依 Build 瞄具档降级：auto 用引擎接管；否则直瞄（避免非 auto Build 触发 MODE_UNAVAILABLE 违规判失联）
  if (ctx.self.stats.aim === 'auto') {
    a.push({ t: 'turretAuto' });
    a.push({ t: 'fire' });
  } else {
    const aimDeg = normalizeDeg(toTarget);
    a.push({ t: 'turretTo', deg: aimDeg });
    if (Math.abs(angleDiff(ctx.self.turret, aimDeg)) < 6) a.push({ t: 'fire' });
  }
  return a;
}

export interface BuiltinBot {
  id: string;
  name: string;
  tag: string;
  desc: string;
  decide: (ctx: Ctx) => Action[];
  defaultBuild: number; // BUILD_PRESETS 索引
}

export const BUILTIN_BOTS: BuiltinBot[] = [
  { id: 'rookie', name: 'ROOKIE-7', tag: 'manual', desc: '直线冲锋 · 手瞄 · 冷却即射', decide: rookieDecide, defaultBuild: 0 },
  { id: 'veteran', name: 'VETERAN-5', tag: 'assist', desc: '侧向环绕 · 控距 · 低血后撤', decide: veteranDecide, defaultBuild: 3 },
  { id: 'master', name: 'MASTER-1', tag: 'auto', desc: '自瞄压制 · 火控加满', decide: masterDecide, defaultBuild: 4 },
];
