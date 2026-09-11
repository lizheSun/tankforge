// 内置策略模板（初始化时种子写入 tf_strategy_templates 表）
import { BUILD_PRESETS } from '../src/game/build';

const HELPERS = `
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function wrap(d) { while (d > 180) d -= 360; while (d <= -180) d += 360; return d; }
`;

export const STRATEGY_TEMPLATES: { name: string; description: string; code: string; presetIdx: number }[] = [
  {
    name: '莽夫冲锋',
    description: '看见谁就冲谁，炮口跟上就开火。简单直接，适合入门。',
    presetIdx: 1,
    code: `// 莽夫冲锋：直冲直射，简单直接
function decide(ctx) {
  const e = ctx.view.enemies.slice().sort((a, b) => a.dist - b.dist)[0];
  const aim = (x, y) => Math.atan2(y - ctx.self.pos.y, x - ctx.self.pos.x) * 180 / Math.PI;
  if (!e) {
    const c = aim(600, 400); // 没看见人：去地图中心
    return [{ t: 'throttle', v: 0.8 }, { t: 'steer', v: clamp(c - ctx.self.heading, -1, 1) / 60 }, { t: 'turretTo', deg: c }];
  }
  const a = aim(e.pos.x, e.pos.y);
  const acts = [
    { t: 'throttle', v: 1 },
    { t: 'steer', v: clamp(a - ctx.self.heading, -1, 1) / 60 },
    { t: 'turretTo', deg: a },
  ];
  if (Math.abs(wrap(a - ctx.self.turret)) < 12 && ctx.self.cooldownMs <= 0) acts.push({ t: 'fire' });
  return acts;
}
${HELPERS}`,
  },
  {
    name: '游走射手',
    description: '保持 ~380 距离风筝，自动算提前量，低血果断撤退。推荐配游侠 Build。',
    presetIdx: 3,
    code: `// 游走射手：控距 380 风筝 + 提前量 + 低血撤退
function decide(ctx) {
  const e = ctx.view.enemies.slice().sort((a, b) => a.dist - b.dist)[0];
  const aim = (x, y) => Math.atan2(y - ctx.self.pos.y, x - ctx.self.pos.x) * 180 / Math.PI;
  if (!e) return [{ t: 'throttle', v: 0.6 }];
  const toE = aim(e.pos.x, e.pos.y);
  let deg = toE;
  if (e.vel) { // 有敌速度（辅助/自动瞄具）：预估提前量
    const tf = e.dist / ctx.self.stats.shellSpeed;
    deg = aim(e.pos.x + e.vel.dx * tf, e.pos.y + e.vel.dy * tf);
  }
  const low = ctx.self.hp / ctx.self.maxHp < 0.4;
  const move = low ? toE + 180 : (e.dist < 320 ? toE + 180 : e.dist > 430 ? toE : toE + 90);
  return [
    { t: 'throttle', v: 1 },
    { t: 'steer', v: clamp(move - ctx.self.heading, -1, 1) / 60 },
    { t: 'turretTo', deg },
  ].concat(Math.abs(wrap(deg - ctx.self.turret)) < 6 && ctx.self.cooldownMs <= 0 ? [{ t: 'fire' }] : []);
}
${HELPERS}`,
  },
  {
    name: '贴脸刺客',
    description: '全速贴近 150 距离切向环绕，让对手炮塔跟不上你的转向。推荐配游侠 Build。',
    presetIdx: 3,
    code: `// 贴脸刺客：贴近 150 切向环绕，高射速近身磨血
function decide(ctx) {
  const e = ctx.view.enemies.slice().sort((a, b) => a.dist - b.dist)[0];
  const aim = (x, y) => Math.atan2(y - ctx.self.pos.y, x - ctx.self.pos.x) * 180 / Math.PI;
  if (!e) return [{ t: 'throttle', v: 0.7 }];
  const toE = aim(e.pos.x, e.pos.y);
  const move = e.dist > 150 ? toE : toE + 90; // 远了直冲，贴上后环绕
  let deg = toE;
  if (e.vel) {
    const tf = e.dist / ctx.self.stats.shellSpeed;
    deg = aim(e.pos.x + e.vel.dx * tf, e.pos.y + e.vel.dy * tf);
  }
  return [
    { t: 'throttle', v: 1 },
    { t: 'steer', v: clamp(move - ctx.self.heading, -1, 1) / 45 },
    { t: 'turretTo', deg },
  ].concat(Math.abs(wrap(deg - ctx.self.turret)) < 20 && ctx.self.cooldownMs <= 0 ? [{ t: 'fire' }] : []);
}
${HELPERS}`,
  },
  {
    name: '重甲堡垒',
    description: '朝中线稳步推进、远程对射不后退，靠血量硬换。推荐配重装甲 Build。',
    presetIdx: 2,
    code: `// 重甲堡垒：稳步推进中线，提前量对射，绝不后退
function decide(ctx) {
  const e = ctx.view.enemies.slice().sort((a, b) => a.dist - b.dist)[0];
  const aim = (x, y) => Math.atan2(y - ctx.self.pos.y, x - ctx.self.pos.x) * 180 / Math.PI;
  if (!e) {
    const c = aim(600, 400);
    return [{ t: 'throttle', v: 0.5 }, { t: 'steer', v: clamp(c - ctx.self.heading, -1, 1) / 45 }, { t: 'turretTo', deg: c }];
  }
  const toE = aim(e.pos.x, e.pos.y);
  let deg = toE;
  if (e.vel) {
    const tf = e.dist / ctx.self.stats.shellSpeed;
    deg = aim(e.pos.x + e.vel.dx * tf, e.pos.y + e.vel.dy * tf);
  }
  return [
    { t: 'throttle', v: e.dist > 260 ? 0.8 : 0.2 },
    { t: 'steer', v: clamp(toE - ctx.self.heading, -1, 1) / 45 },
    { t: 'turretTo', deg },
  ].concat(Math.abs(wrap(deg - ctx.self.turret)) < 8 && ctx.self.cooldownMs <= 0 ? [{ t: 'fire' }] : []);
}
${HELPERS}`,
  },
];

/** 模板行（写库用）：build 取推荐预设的能力点 */
export function templateRows(): { name: string; description: string; code: string; build_json: string }[] {
  return STRATEGY_TEMPLATES.map((t) => ({
    name: t.name,
    description: t.description,
    code: t.code,
    build_json: JSON.stringify(BUILD_PRESETS[t.presetIdx].points),
  }));
}
