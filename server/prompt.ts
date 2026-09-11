// 标准策略生成 Prompt：游戏规则 + 地图信息 + Build 体系 + 策略模板 + 代码规范
// 目标：用户把这段 Prompt 粘贴给任意 LLM/Agent，即可产出可运行的 decide(ctx) 策略代码
import { BUILD_PRESETS } from '../src/game/build';
import { BUILTIN_BOTS } from '../src/game/bots';
import { MAP_IDS, buildMap } from '../src/game/map';
import { AIM_ASSIST_CP, AIM_AUTO_CP, CP_BUDGET, TIER } from '../src/game/constants';
import type { BuildPoints, TileType } from '../src/game/types';

export interface PromptTemplate {
  name: string;
  description: string;
  code: string;
  build?: BuildPoints | null;
}

function mapSection(): string {
  return MAP_IDS.map((id) => {
    const m = buildMap(id);
    const counts: Record<string, number> = {};
    for (const row of m.tiles) for (const t of row as TileType[]) counts[t] = (counts[t] ?? 0) + 1;
    return `### ${m.name}（${id}）— ${m.desc}
- 48×32 瓦片（每格 25px），左右 + 上下完全镜像对称，四周实心墙
- 地形统计：实心墙 ${counts.SOLID ?? 0} 格 / 可破坏薄墙 ${counts.BREAKABLE ?? 0} 格 / 草丛 ${counts.GRASS ?? 0} 格
- 薄墙 50 耐久可被炮弹打碎，碎后变残骸（可通行、可透视）；草丛内坦克不可见（开火/被击中暴露 500ms）`;
  }).join('\n\n');
}

function buildSection(): string {
  const rows = [
    `| 模块 | 基础值 | 每级(1CP) | 上限 |`,
    `|---|---|---|---|`,
    `| 装甲 | HP ${TIER.armor.base} | +${TIER.armor.per} HP | ${TIER.armor.max} 级 |`,
    `| 引擎 | 移速 ${TIER.engine.base}px/s | +${TIER.engine.per} | ${TIER.engine.max} 级 |`,
    `| 履带 | 车体转速 ${TIER.tracks.base}°/s | +${TIER.tracks.per}°/s | ${TIER.tracks.max} 级 |`,
    `| 装填 | ${TIER.fireRate.base}ms | −${-TIER.fireRate.per}ms | ${TIER.fireRate.max} 级 |`,
    `| 伤害 | ${TIER.damage.base}/发 | +${TIER.damage.per} | ${TIER.damage.max} 级 |`,
    `| 炮塔 | 回转 ${TIER.turret.base}°/s | +${TIER.turret.per}°/s | ${TIER.turret.max} 级 |`,
    `| 弹速 | ${TIER.shellSpeed.base}px/s | +${TIER.shellSpeed.per} | ${TIER.shellSpeed.max} 级 |`,
    `| 视野 | ${TIER.view.base}px | +${TIER.view.per} | ${TIER.view.max} 级 |`,
  ].join('\n');
  return `${rows}

瞄具（互斥，不占档位）：辅助 assist ${AIM_ASSIST_CP}CP（敌方位置无噪声 + 提供速度 vel）/ 自动 auto ${AIM_AUTO_CP}CP（引擎接管炮塔自动提前量，需发 turretAuto 意图）。
总预算 ${CP_BUDGET} CP。官方预设：${BUILD_PRESETS.map((p) => `${p.name}（${p.desc}）`).join('、')}。`;
}

export function buildStrategyPrompt(templates: PromptTemplate[]): string {
  const tpl = templates
    .map((t) => {
      const build = t.build
        ? `推荐 Build：${JSON.stringify({ ...t.build, aimAssist: t.build.aimAssist ? 1 : 0, aimAuto: t.build.aimAuto ? 1 : 0 })}`
        : '推荐 Build：默认原型（0CP）';
      return `### 模板：${t.name} — ${t.description}\n${build}\n\`\`\`js\n${t.code.trim()}\n\`\`\``;
    })
    .join('\n\n');

  const bots = BUILTIN_BOTS.map((b) => `${b.name}（${b.desc}）`).join('、');

  return `# TANKFORGE 坦克 AI 策略生成任务

你是顶级游戏 AI 策略工程师。请为下面的坦克对战平台，编写你认为**最优**的决策策略代码。

## 1. 游戏概述
- 1v1 坦克对战，双方各 1 辆坦克，全程 AI 自动交战；你的对手是内置 AI（${bots}）或其他玩家上传的策略
- 引擎 60 tick/s；每 5 tick（约 83ms）调用一次你的 \`decide(ctx)\`，返回一组"意图"
- 单局 90 秒；把对方 HP 打到 0 即胜；超时按 存活数 > 剩余HP > 累计伤害 裁定
- 地图 1200×800 像素，坐标原点在左上角：x 向右增大、y 向下增大；**角度为世界角度，0°=正右，90°=正下**（atan2(dy, dx) * 180 / PI）

## 2. 你能读什么（ctx，只读快照）
\`\`\`js
ctx.self = {
  id, team, pos: {x, y}, heading, turret,       // 车体朝向 / 炮塔朝向（世界角度）
  hp, maxHp, cooldownMs, speed,
  stats: { hpMax, moveSpeed, turnRate, fireIntervalMs, damage, shellSpeed, turretSpeed, viewRadius,
           aim: 'manual'|'assist'|'auto', commSlots }
}
ctx.view.enemies   // 只包含当前真"可见"的敌人（进入视野半径 + 无墙遮挡 + 不在草丛）：
  = [{ id, dist, pos: {x, y},          // manual 瞄具的 pos 带 ±6° 噪声；assist/auto 精确
      heading, hp, lastSeenTick,
      vel: {dx, dy} | null }]          // 敌方速度 px/s，仅 assist/auto 提供
ctx.view.allies    // 1v1 为空
ctx.events        // 事件：HIT_RECEIVED / HIT_DEALT / SHOT_FIRED / SCAN_ACQUIRED / SCAN_LOST /
                   //        COLLISION / WALL_HIT / BREAKABLE_DOWN / ALLIED_DOWN / ENEMY_DOWN
ctx.timeLeftMs, ctx.tick, ctx.clockMs, ctx.rng()   // rng() 返回 [0,1) 随机数
\`\`\`

## 3. 可以返回的意图（Action 数组，一次可返回多条，按序消费）
\`\`\`js
{ t: 'throttle', v }        // 油门 -1(倒车) ~ +1(全速)
{ t: 'steer', v }           // 车体转向 -1(左满舵) ~ +1(右满舵)
{ t: 'steerTo', deg }       // 车体转向世界角度 deg
{ t: 'turretTo', deg }      // 炮塔转向世界角度 deg（炮塔与车体独立）
{ t: 'turretAuto' }         // 仅 aim==='auto' 可用：引擎接管瞄准（其他瞄具发这个 = 违规）
{ t: 'fire' }               // 开火（装填中会挂起，装填完成自动射出）
{ t: 'comm', msg, to? }     // 队友通信（1v1 无用）
\`\`\`

## 4. 属性与 Build 体系（12 CP）
${buildSection()}

## 5. 物理与判定要点
- 炮弹从炮口沿炮塔朝向直线飞行，命中判定半径 20px，最长飞行 3 秒
- **打移动目标需要提前量**：预估弹丸飞行时间 tf = dist / shellSpeed，瞄准 pos + vel × tf（可迭代 2~3 次收敛）
- 无友军伤害（炮弹穿过队友）；撞墙会被挡住；草丛隐蔽（开火/被击中暴露 500ms）
- 单次决策限时 100ms；死循环/超时 = 该帧不行动并累计违规，违规 100 次判失联摧毁；抛异常 = 当场判负

## 6. 地图信息（${MAP_IDS.length} 张官方地图，对局随机其一）
${mapSection()}

## 7. 参考策略模板（内置，理解后可以超越）
${tpl}

## 8. 输出要求（严格遵守）
1. 只输出**一段完整 JavaScript**：顶层可定义辅助函数与 \`let\` 状态变量（跨决策帧保留），必须存在 \`function decide(ctx) { ... }\`，返回意图数组（可以为 \`[]\`）
2. 禁止：import / require / DOM / fetch / setTimeout / XMLHttpRequest / WebSocket / Date.now（用 ctx.rng() 和 ctx.tick 替代随机与时间）
3. 可用：Math / JSON / 普通对象与数组；代码在沙箱中运行，任何异常都判负
4. 意图数值会被钳制（throttle/steer 到 [-1,1]、角度自动归一化），但请输出规范值
5. 你的目标是 90 秒内击毁对手。请综合考虑：接敌 / 控距 / 提前量 / 草丛博弈 / 低血处理 / 薄墙利用

现在，请直接输出你认为最优的策略代码（不要多余解释）。`;
}
