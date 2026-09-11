# 战斗系统技术规格（Battle Specification）

> 细化对象：REQUIREMENTS.md §5 战斗基础规则、§6.2 属性 Build 能力点体系、FR3 决策策略契约。
> 版本：v0.1（草案） · 日期：2026-09-07 · 状态：待评审
> 本文档是引擎、SDK、编辑器加点 UI 三方共同遵守的**唯一数值与契约来源**。任何改动需同步三端并升级 `rules_snapshot` 版本。

---

## 1. 单位约定与确定性

| 项 | 约定 |
|---|---|
| 逻辑长度 | 1 内部像素（px），地图 1200×800 即逻辑尺寸，不随渲染缩放 |
| 时间 | 物理步进 `dt = 1000/60 ms`（60 tick/s）；决策节拍每 `5` tick（12 Hz，`dt_dec=83.3ms`） |
| 角度 | 度(°)，`0° = +x`，逆时针为正；范围归一化到 `[-180,180)` |
| 数值精度 | 引擎内部整数微元或 IEEE-754 double，**全程同一平台与构建产物**；回放 golden 测试守护 |
| 随机数 | 全平台使用种子化 PRNG `xoshiro256**`，策略代码不得自取随机源，只能调用 `ctx.rng()`（确定性、不可预测对手） |
| 规则快照 | 每个对局记录 `rules_snapshot` 版本（数值/平衡表冻结），保证历史回放按旧规则重演 |

---

## 2. 地图规格

### 2.1 坐标与瓦片
- 逻辑网格：`48 × 32` tiles，tile = 25px → 战场 1200×800。
- 坐标 `(0,0)` 左上；`x ∈ [0,1200)`，`y ∈ [0,800)`。碰撞体均以 AABB（墙）与圆（坦克/弹丸）参与。
- 边界四边为不可穿越实墙。

### 2.2 瓦片类型
| 类型 | 可通行 | 可摧毁 | 视觉 | 规则 |
|---|---|---|---|---|
| `EMPTY` | ✅ | – | 地面网格 | |
| `SOLID` | ❌ | ❌ | 金属墙 | 阻挡坦克、弹丸、视线 |
| `BREAKABLE` | ❌ | ✅（耐久 50） | 半透明能量墙 | 弹丸命中扣耐久（=基础伤害），耐久≤0 变 `RUIN`（可通行） |
| `RUIN` | ✅ | – | 残骸 | 破坏后的空场 |
| `GRASS` | ✅ | – | 草丛 | 中心在草内的坦克对敌方**不可见**；开火/被击中后暴露 500ms；弹丸可正常穿越命中（盲射有效） |

### 2.3 出生点
- 1v1：A 生于左上象限、B 生于右下象限，镜像对称，至少 3 个候选出生位做镜像随机（同一种子）。
- 团战：按 `地图出生区配置`，每队在本侧若干候选位随机，避免初始贴脸。

### 2.4 地图文件 schema（`map.tankmap.json`，版本化）
```jsonc
{
  "format": 1,
  "id": "arena_open",
  "name": "开阔竞技场",
  "tiles": [ "48x32 字符串数组, 每字符对应瓦片类型" ],
  "spawns": { "red": [[120,120],[160,200]], "blue": [[1080,680],[1040,600]] },
  "rules": { "ammoLimited": false, "friendlyFire": false, "durationMs": 180000 },
  "visual": { "sky": "#06080F", "accent": "#00E5FF" }
}
```
- V1 预置 3 张：开阔竞技场（少掩体，练瞄准）、巷战街区（多 SOLID，练走位）、迷宫试验场（多 BREAKABLE + GRASS，练侦察/破墙）。
- 每张图在发布前通过 `validate(map)`：出生区可通行、无完全对称死局、可破坏墙可达。

---

## 3. 单位运动学模型

- 坦克模型：**车体圆 r=16px**，中心 `(x,y)`；车体朝向 `heading`（决定前进方向）；炮塔独立朝向 `turret`，绕车体中心旋转，炮口在 `center + 24px @ turret 方向`。
- 运动（每物理 tick 离散积分）：
  1. 车体转向按 **最大转向速度** 施加（目标速度由 throttle/steer 意图换算）；
  2. 前进/倒车速度按 `throttle ∈ [-1,1] × maxSpeed` 立即作用于当 tick（V1 无惯性蓄速，减少不确定性；若实测手感差再引入 lerp）；
  3. 位移后做**碰撞解算**：与 SOLID/BREAKABLE/边界冲突则贴边滑行（push-out 到最近无碰撞位置），并产生 `WALL_HIT` 事件；
  4. 坦克间互相碰撞：视为弹性分离，双方均被推开（不可重叠），产生 `COLLISION` 事件。
- 弹丸：圆 r=4px，瞬时出膛速度恒定（弹速属性），不做重力/摩擦。每 tick 做 swept 检测（上一位置→新位置线段），防高速穿模。

---

## 4. 属性 Build：能力点（CP）数值表

> 预算 12 CP。同一模块内档位成本 1 CP/档，**模块有档数上限**（禁全属性堆满）。
> 加点最小单位 1 档，编辑器实时预览。所有数值在 `rules_snapshot` 内冻结。

| 模块 | 属性 | 基线 | 每档增量 | 最大档 | 最大后值 | 单档成本 |
|---|---|---|---|---|---|---|
| 装甲 | 血量上限 HP | 100 | +15 | 6 | 190 | 1 |
| 动力 | 最大移动速度 | 120 px/s | +20 | 4 | 200 px/s | 1 |
| 履带 | 车体最大转向 | 90 °/s | +20 | 3 | 150 °/s | 1 |
| 火控A | 攻击间隔（装填） | 0.8 s | −0.06 s | 4 | 0.56 s | 1 |
| 火控B | 单发基础伤害 | 12 | +3 | 4 | 24 | 1 |
| 火控C | 炮塔转速 | 150 °/s | +30 | 3 | 240 °/s | 1 |
| 火控D | 弹速 | 480 px/s | +90 | 2 | 660 px/s | 1 |
| 传感A | 视野半径 | 320 px | +40 | 3 | 440 px | 1 |
| 传感B | 自瞄 assist 档 | 关 | — | — | 开 | 1 |
| 传感C | 自瞄 auto 档（含 assist） | 关 | — | — | 开 | 3 |
| 战术 | 队友通信带宽（团战生效） | 1 条/tick | +1 | 2 | 3 条/tick | 1 |

派生公式（编辑器实时计算）：
- `DPS = 基础伤害 / 攻击间隔`
- `理想TTK = HP_target / DPS`（命中率 100%）
- 机动指数 = 移速 × 转向 / 基线的几何均分；供"六边形雷达图"展示。

平衡基线速查（用于审查 build 是否失衡，非强制）：
| Build 原型 | 分配（CP） | 结果 | 定位 |
|---|---|---|---|
| 默认 | 0 | HP100 · DPS 15 · 移速120 | 平衡参照 |
| 玻璃炮 | 伤害4(4) + 装填4(4) + 瞄准assist(1) + 视野1(1) + 弹速1(1) + 转向1(1) | HP100 · DPS **42.9** · 需 5 发/2.8s 击毁默认坦克 | 高风险高爆发 |
| 重装甲 | HP6(6) + 履带2(2) + 动力2(2) + 辅助1(1) + 装填1(1) | HP190 · DPS 12.5 · 机动良好 | 抗线/缠斗 |
| 游侠 | 移速4(4) + 转向3(3) + 视野3(3) + 辅助1(1) + 伤害1(1) | 移速200/转向150/视野440 · DPS 18.75 | 侦察风筝 |

校验规则（上传时拒绝并提示）：
- CP 合计 ≤ 12；各模块 ≤ 最大档。
- assist 与 auto 互斥（auto 隐含 assist）。
- **公平模式（天梯）**双方 CP=12；自定义房可 `unlimitedCP:true`，结果不计天梯分。

---

## 5. 弹道与命中结算

- **开火条件**：`fire` 意图到达且 `cooldown==0`；一意图最多触发 1 发；开火事件对全战场广播（含开火方，用于草丛暴露）。
- **弹道**：出膛位置 `炮口`、方向 `turret`、速度 = 弹速属性；最长存续 3s（超时静默销毁，`SHELL_EXPIRED`）。
- **命中顺序**（同 tick 内按距离近→远结算）：
  1. 命中敌方坦克：结算伤害（基础伤害全值，无距离衰减），广播 `HIT_RECEIVED/HIT_DEALT`；
  2. 命中 SOLID：弹丸销毁；命中 BREAKABLE：扣耐久并销毁；
  3. 命中 GRASS 内坦克：与 1 相同（盲射可命中，草丛只影响"可见/锁定"）。
  4. 命中己方坦克：仅当房间开启 `friendlyFire`（默认关；关时穿越己方）。
- HP ≤ 0 → 坦克 `DESTROYED`，退出碰撞体，广播击杀；**弹丸穿透**：一发不结算多目标（命中即止）。
- 蓄力/威力选择：V1 不引入（伤害=固定属性），降低预判不确定性；作为 M3+ 的可选规则项。

---

## 6. 观测模型（信息不对称设计）

### 6.1 可见性规则
- 敌方坦克"可见"当且仅当：双方距离 ≤ 己方视野半径，**且** 视线（车体中心连线）不被 SOLID 完全阻挡，**且** 目标不在 GRASS 内（草丛中敌方不可见；敌方开火/被命中后暴露 500ms）。
- 可观测信息（可见时）：`id/team`、位置、车体朝向、炮塔朝向、`hp`（精确值，公平起见 V1 不做血条离散化）、是否正在开火冷却。
- 不可观测：对方策略代码、Build 具体参数（只能从机动/火力节奏反推）、意图队列、记忆区。

### 6.2 探测噪声（瞄准档位差异化的落点）
| 瞄准档 | 传感器返回的敌方位角/航向测量误差 | 炮塔控制 | CP |
|---|---|---|---|
| manual（手瞄） | 方位角 ±6° 高斯噪声 | 完全自控（可用 `turretTo` 数值） | 0 |
| assist（辅助） | 0（无噪声），额外提供敌我相对速度与角速度 | 作者自行实现解算/伺服 | 1 |
| auto（自动） | 0，且引擎接管炮塔伺服 + **lead 提前量解算** | 作者只需 `fire` 决策 | 3 |

> 设计意图：manual 需要作者自己处理"测量误差 + 弹道提前量"，模拟观察不精确；assist 提供干净数据但 lead 自理；auto 交给引擎但占用 3 CP（本可投给火力/生存）。三者对应不同难度曲线与"瞄准策略"诉求（用户原始需求中的"瞄准策略"即在此维度的策略层体现）。

- auto 对 GRASS 内目标仍可基于 `lastKnown + 预测` 盲射（炮弹物理命中照常）。
- 事件 `SCAN_ACQUIRED / SCAN_LOST` 标记可见性变化。

---

## 7. 决策循环与策略契约（SDK）

### 7.1 时序
- 物理 60Hz 全速推进；每 5 tick 产生一次**决策帧**。
- 决策帧流程：`事件聚合 → 快照构建(ctx) → 沙箱调用 decide(ctx) → 意图校验 → 队列执行（随后 5 tick 内逐步消费）→ 等待下帧`。
- 非同步事件（被击中/首见目标）可触发**可选回调** `onEvent`，不打断 decide 主循环。

### 7.2 入口
```ts
// 策略包 manifest 中声明 strategy.type: "rule"
export function decide(ctx: Ctx): Action[];
// 可选：事件订阅（rule 模式）
export function onEvent(evt: Event, ctx: Ctx): void;
// 可选：提交前冒烟自检（沙箱内运行，供报告）
export function selfTest(ctx: Ctx): string | null;
```

### 7.3 `Ctx`（只读快照，全部字段随决策帧新鲜）
```ts
interface Ctx {
  tick: number;                 // 全局 tick
  clockMs: number;              // 对局已进行毫秒
  self: {
    id: string; team: 'red'|'blue';
    pos: Vec2; heading: number; turret: number;   // turret 相对世界角
    hp: number; maxHp: number;
    cooldownMs: number;         // 剩余装填
    speed: number;              // 当前实际速率(px/s 有符号)
    stats: { hp, maxSpeed, turnRate, fireIntervalMs, damage, shellSpeed, turretSpeed, viewRadius, aim: 'manual'|'assist'|'auto' };
  };
  view: {                        // 仅包含"可见"对象（§6）
    enemies: EnemyInfo[];        // 可见敌方；草丛内目标可能以 lastKnown 形式缺失
    allies: AllyInfo[];          // 团战：同队且己方可见范围内（队友默认全可见，若规则开战争迷雾则同 §6）
  };
  events: Event[];              // 自上次决策帧以来入队的事件（消费即清）
  memory: KV;                   // 记忆区（可写，上限见 §7.6）
  inbox: CommMsg[];            // 队友发来的通信消息（跨决策帧投递，见 §7.6）
  comm: { slots: number; used: number }; // 本决策帧通信带宽（配额 / 已用）
  map: { w: number; h: number; tiles: TileType[] }; // 静态只读（编辑器注入，含 size 足够决策用）
  mode: '1v1'|'team';
  timeLeftMs: number;
  rng(): number;                // [0,1) 确定性 PRNG
}
interface EnemyInfo {
  id: string; team: 'red'|'blue';
  bearingDeg: number | null;    // 相对自身车体方位（含瞄准档噪声）
  dist: number;
  pos: Vec2;                    // 含噪声的观测位置（作者应使用带噪声读数而非直接 pos 作弊）；
  heading: number;              // 车体朝向估计
  hp: number; lastSeenTick: number;
  vel: { dx: number; dy: number } | null;  // 仅 assist/auto（manual 为 null）
}
```

### 7.4 `Action[]`（意图，引擎校验后执行，可下多意图按序消费）
```ts
type Action =
  | { t: 'throttle'; v: number }          // -1..1 相对最大速度，前进为正
  | { t: 'steer'; v: number }             // -1..1 车体转向，左正右负；与 steerTo 互斥
  | { t: 'steerTo'; deg: number }         // 指定世界朝向，引擎自动伺服
  | { t: 'turretTo'; deg: number }        // 指定炮塔世界角；auto 档可传 'auto'
  | { t: 'turretAuto' }                   // 仅 aim=auto 可用；引擎接管 lead 解算
  | { t: 'fire' }                         // 装填就绪即开火（每次意图 ≤1 发/冷却内）
  | { t: 'comm'; msg: string; to?: 'all' | string }; // 队友通信：单条 ≤64B，带宽=comm 档（条/决策帧）
```

### 7.5 校验与错误码（计 `sanction`，累计 100 次判失联）
| 错误 | 场景 |
|---|---|
| `MODE_UNAVAILABLE` | 非 auto 瞄具档却发 `turretAuto` |
| `COMM_INVALID` | `comm` 消息为空 / 超 64B |
| `COMM_BANDWIDTH` | `comm` 超出本决策帧带宽配额（comm 档）|
| `TIMEOUT` | 决策超 100ms：该帧 NOOP（不应用返回）；连续 30 tick 无响应计 1 次 |
| `CRASH` | 抛异常/语法错误（当场判负，计入信用分）|
| `SANCTION_100` | 累计 100 次非法意图 → 失联判负 |

**静默容错（丢弃/钳制，不计 sanction）**：
- `throttle`/`steer` 越界自动钳制到 [-1,1]；`steerTo`/`turretTo` 角度自动归一化。
- 冷却中 `fire`：挂起为装填触发（fireHeld），装填完成即发射，无惩罚也无额外收益。
- 超时后迟到的决策返回：该帧已按 NOOP 处理，迟到结果被丢弃（下个决策帧重新决策）。

**规避要点（按 Build 能力发意图，不要硬发）：**
- 发 `turretAuto` 前先读 `ctx.self.stats.aim`，仅在 `aim === 'auto'` 时发送；非 auto 请改用 `turretTo` 手动直瞄或自算 lead（官方 MASTER bot 亦如此降级，不会因 Build 换档而自毁）。
- `comm` 单条 ≤ 64 B，且每决策帧条数受 comm 档配额限制；超限即计 sanction。
- 决策须在 100ms 内返回：死循环/挂起脚本每帧 NOOP，连续 30 tick 无响应计 1 次违规，累计 100 次判失联。
- 一次违规只丢该条意图并 +1 `sanction`，100 次才失联判负，因此脚本 bug 不会瞬间自爆——但对局日志会逐条审计，上传前可用 `selfTest` 冒烟自检。

### 7.6 记忆区与通信
- `memory`：键值存储，总配额 4 KB；单帧写入 ≤ 256 B、写频率 ≤ 10 次/决策帧；跨帧保留到对局结束；回放 Debug 层可展示其演化。
- `comm`：仅同队可见；跨决策帧投递（发送帧的下一决策帧 `inbox` 收到）；敌方**永不**收到任何队内消息；攻击方可按"团战通信监听"能力（战术模块 3CP）窃听？—— **V1 不做窃听**，保留为开放项。

---

## 8. 事件 Schema（`Event`）

| type | 触发 | 关键字段 |
|---|---|---|
| `HIT_RECEIVED` | 自己被击中 | `damage, fromId, tick` |
| `HIT_DEALT` | 己方弹丸命中敌方 | `damage, targetId, tick` |
| `SHOT_FIRED` | 己方开火 | `tick`（用于草丛暴露计时）|
| `SCAN_ACQUIRED` | 目标变为可见 | `targetId` |
| `SCAN_LOST` | 目标消失/进草丛 | `targetId` |
| `COLLISION` | 撞到坦克 | `otherId` |
| `WALL_HIT` | 撞到墙/边界 | `normal` |
| `SHELL_IMPACT` | 己方弹丸撞墙/障碍 | `x,y,blockType` |
| `BREAKABLE_DOWN` | 己方打碎可破坏墙 | `x,y` |
| `ALLIED_DOWN / ENEMY_DOWN` | 阵营减员 | `id` |
| `MATCH_START / MATCH_END` | 开局/结束 | `result` |
| `TIMER_WARNING` | 剩余 30s/10s | `timeLeftMs` |

事件每 tick 只对"应知方"投递（观测外事件不泄漏）。

---

## 9. 胜负与结算公式

### 9.1 判定优先级（逐条 check，先命中先定）
1. 1v1：任一方 `hp≤0` → 对方胜。
2. 团战：任一方存活数为 0 → 对方胜。
3. `clock ≥ durationMs`（默认 180s）超时 → 按序比较：
   - ① 存活坦克数大者胜；
   - ② 队伍总剩余 HP 比高者胜（百分比，防满血小坦克作弊）；
   - ③ 队伍累计造成伤害大者胜；
   - ④ 若仍平 → **平局**（双方记平，不掉天梯分）。
4. 双方都"失联/崩溃"且无伤害：判平。

### 9.2 结算统计（per tank，存 `matches` 与回放）
`damageDealt / shotsFired / accuracy(=hits/shots) / distanceTravelled / timeAliveMs / kills / deaths / sanctions / maxHitChain`
结算 UI：双方卡 + 雷达图对比 + 关键事件时间线。

---

## 10. 引擎 API（对开发者，非策略作者）
```
createMatch({ packA, packB, mapId, seed, mode, rulesOverrides }) → matchId
   → load（解包+静态校验+冒烟通过后才可开）
   → run（确定性循环，产出 ReplayStream + 实时观战推送）
   → settle → 结果落库 + 天梯分更新 + 回放归档
replay(matchId) → 按 rules_snapshot 重演（golden 校验 hash）
```
- `ReplayStream`：每 tick 紧凑二进制（位置/朝向/事件/决策动作），protobuf 编码。
- 对局 hash = sha256(种子 + 双方包版本 + map + rules_snapshot + 终局状态)，用于对账与防篡改。

---

## 11. 内置官方 Bot（冒烟测试 + 新手陪练 + 门槛验收）

| Bot | Build | 瞄准 | 行为简述 | 用途 |
|---|---|---|---|---|
| ROOKIE-7 | 默认(0CP) | manual | 直线冲向最后已知敌位，冷却即打 | 最弱门槛：上传即赢它验证闭环 |
| VETERAN-5 | 移速2+转向2(4CP) | assist | 侧移走位 + 半血后撤 + 边退边打 | 新手必须认真对待 |
| MASTER-1 | auto(3CP)+装填1+伤害1+履带1+装甲1 | auto | 预判射击 + 进出掩体 + 血线管理 | 天梯 Top 陪练 & SDK 完整示例 |

冒烟测试 = 新包 vs ROOKIE-7：能取胜 3/5 局 → 通过可发布；否则给出失败回放片段供作者自检。

---

## 12. 工程验收用例（对照 REQUIREMENTS §12）

| # | 场景 | 断言 |
|---|---|---|
| E1 | 相同 seed + 相同双包重跑 | 每 tick 状态 hash 一致（确定性） |
| E2 | 弹速 660 且 4px 半径穿过 2px 墙缝 | 不穿模（swept 检测） |
| E3 | 玻璃炮 build vs 默认 build（官方 bot 无操作直射） | 玻璃炮 5 发击毁，验证 24dmg/0.56s |
| E4 | 纯 manual bot 只发 `turretAuto` | 被 `MODE_UNAVAILABLE` 拒绝并计 sanction |
| E5 | 上传 `while(true){}` | 单帧超时→NOOP→累计失联判负，不拖垮引擎 |
| E6 | GRASS 中静止 3s | 敌方 `SCAN_LOST`，开火后恢复可见 500ms |
| E7 | 团战 3v3 一队全灭 | 对方胜；结算统计字段非空 |
| E8 | 超时 180s 无人死亡 | 按 §9.1(3) 顺序判胜并输出 tie-break 明细 |
| E9 | 任意对局结束 | `replay` 按旧 rules_snapshot 可重演且 hash 一致 |
| E10 | 非法意图累积 100 | 判失联，日志可审计 |

---

## 13. 开放数值项（P0 平衡阶段需实测）

1. 草丛暴露 500ms 是否过短/过长；
2. manual ±6° 噪声是否让新包太难（提供辅助量规/校准示例）；
3. BREAKABLE 耐久 50 对伤害 12~24 的攻破节奏；
4. 180s 时限在重甲镜像局是否过短；
5. GRASS 是否应该提供"半可见(敌人仅知 lastKnown 方向)"而非全隐。
