// ============================================================
// TANKFORGE · 确定性战斗引擎 — 公共类型
// 依据 docs/BATTLE_SPEC.md（引擎内数值零浮点漂移由 golden 测试守护）
// ============================================================

export type Team = 'red' | 'blue';

export type AimLevel = 'manual' | 'assist' | 'auto';

export interface Vec2 {
  x: number;
  y: number;
}

/** 坦克属性 Build（CP 分配原始档位） */
export interface BuildPoints {
  armor: number; // 装甲 -> HP
  engine: number; // 动力 -> 移速
  tracks: number; // 履带 -> 车体转向
  fireRate: number; // 火控A -> 攻击间隔
  damage: number; // 火控B -> 基础伤害
  turret: number; // 火控C -> 炮塔转速
  shellSpeed: number; // 火控D -> 弹速
  view: number; // 传感A -> 视野半径
  aimAssist: boolean; // 传感B
  aimAuto: boolean; // 传感C（隐含 assist）
  comm: number; // 战术 -> 通信带宽
}

/** 解析后的最终属性（Rules Snapshot 决定公式） */
export interface ResolvedStats {
  hpMax: number;
  moveSpeed: number;
  turnRate: number;
  fireIntervalMs: number;
  damage: number;
  turretSpeed: number;
  shellSpeed: number;
  viewRadius: number;
  aim: AimLevel;
  commSlots: number;
}

// ------------------------------------------------------------
// 决策层契约（策略作者视角）
// ------------------------------------------------------------

export type Action =
  | { t: 'throttle'; v: number } // -1..1
  | { t: 'steer'; v: number } // -1..1 左正右负
  | { t: 'steerTo'; deg: number } // 车体朝向世界角
  | { t: 'turretTo'; deg: number } // 炮塔世界角
  | { t: 'turretAuto' } // 仅 aim=auto
  | { t: 'fire' }
  | { t: 'comm'; msg: string; to?: 'all' | string }; // 队友通信广播（带宽=commSlots 条/决策帧）

export interface EnemyInfo {
  id: string;
  team: Team;
  bearingDeg: number | null; // 相对车体方位（按瞄准档噪声）
  dist: number;
  pos: Vec2; // 观测位（manual 含噪声）
  heading: number;
  hp: number;
  lastSeenTick: number;
  vel: { dx: number; dy: number } | null; // assist/auto
}

/**
 * 队友信息：来源两路 ——
 *  sensor：本车视野半径内（同敌方观测规则：视距/视线/草丛）
 *  net：战术数据链（commSlots≥1 即默认开通），跨全图共享队友当前姿态，
 *       升级 comm 提高带宽与信息丰富度（详见 engine.buildAllies）
 */
export interface AllyInfo {
  id: string;
  team: Team;
  name: string;
  /** 空 = 敌方坦克已摧毁（正常不会出现在列表，仅兼容占位） */
  pos: Vec2;
  hp: number;
  maxHp: number;
  heading: number | null; // net 档位足够时提供
  /** 自传感器捕获（视野内直接观测） */
  sensor: boolean;
  /** 战术数据链共享（跨地图，无视掩体） */
  net: boolean;
  dist: number | null; // sensor 才有效
  bearingDeg: number | null; // sensor 才有效
  lastTick: number; // 信息刷新帧
}

/** 队友通信消息（进入 Ctx.inbox，跨决策帧投递） */
export interface CommMsg {
  fromId: string;
  fromName: string;
  tick: number; // 发送帧
  text: string;
}

export type GameEventType =
  | 'HIT_RECEIVED'
  | 'HIT_DEALT'
  | 'SHOT_FIRED'
  | 'SCAN_ACQUIRED'
  | 'SCAN_LOST'
  | 'COLLISION'
  | 'WALL_HIT'
  | 'BREAKABLE_DOWN'
  | 'ALLIED_DOWN'
  | 'ENEMY_DOWN'
  | 'MATCH_START'
  | 'MATCH_END'
  | 'TIMER_WARNING';

export interface GameEvent {
  type: GameEventType;
  tick: number;
  ms: number;
  data: Record<string, unknown>;
}

export interface Ctx {
  tick: number;
  clockMs: number;
  timeLeftMs: number;
  self: {
    id: string;
    team: Team;
    name: string;
    pos: Vec2;
    heading: number;
    turret: number;
    hp: number;
    maxHp: number;
    cooldownMs: number;
    speed: number;
    stats: ResolvedStats;
  };
  view: {
    enemies: EnemyInfo[];
    allies: AllyInfo[];
  };
  /** 本决策帧已收到 / 可用的队友通信消息（跨决策帧投递） */
  inbox: CommMsg[];
  /** 通信带宽（本决策帧已用条数 / 配额） */
  comm: { slots: number; used: number };
  events: GameEvent[];
  map: { w: number; h: number };
  mode: '1v1' | 'team';
  rng(): number;
}

// 策略入口（内置 bot 与用户脚本共用）
export type DecideFn = (ctx: Ctx) => Action[];

// ------------------------------------------------------------
// 引擎内部状态
// ------------------------------------------------------------

export interface Intent {
  throttle: number;
  steerSigned: number; // 手转 -1..1
  steerTarget: number | null; // 优先级高于 steerSigned
  turretTarget: number | null; // 数值角度
  turretAuto: boolean; // 需 aim=auto
  fireHeld: boolean;
}

export interface TankState {
  id: string;
  team: Team;
  name: string;
  buildName: string;
  points: BuildPoints;
  stats: ResolvedStats;
  pos: Vec2;
  heading: number;
  turret: number;
  hp: number;
  cooldownMs: number;
  alive: boolean;
  intent: Intent;
  events: GameEvent[]; // 等待投递给 driver 的事件
  // 观测历史（用于敌方速度估计）
  hist: Vec2[];
  lastScan: Map<string, { tick: number; dir: number }>;
  // 统计
  shotsFired: number;
  hits: number;
  damageDealt: number;
  distTravelled: number;
  timeAliveMs: number;
  kills: number;
  sanctions: number;
  killTick: number;
}

export interface ShellState {
  id: number;
  ownerId: string;
  team: Team;
  pos: Vec2;
  dir: number; // deg
  speed: number;
  damage: number;
  bornMs: number;
  prev: Vec2;
}

export type TileType = 'EMPTY' | 'SOLID' | 'BREAKABLE' | 'RUIN' | 'GRASS';

export type Phase = 'running' | 'over';

export type SideResult = 'win' | 'lose' | 'draw';

export interface TankResult {
  id: string;
  team: Team;
  name: string;
  buildName: string;
  hp: number;
  alive: boolean;
  damageDealt: number;
  shotsFired: number;
  hits: number;
  accuracy: number;
  distTravelled: number;
  timeAliveMs: number;
  kills: number;
  sanctions: number;
}

export interface MatchResult {
  phase: Phase;
  winner: Team | null;
  draw: boolean;
  reason: 'kill' | 'timeout' | 'disconnect' | null;
  teamTotalDamage: Record<Team, number>;
  teamAlive: Record<Team, number>;
  teamHpLeft: Record<Team, number>;
  tankResults: TankResult[];
}

export interface MatchSnapshot {
  w: number;
  h: number;
  ms: number;
  tick: number;
  tanks: TankState[];
  shells: ShellState[];
  wallHp: Map<number, number>; // tileIndex -> remaining
  result: MatchResult | null;
}

export interface WorldEvent {
  tick: number;
  ms: number;
  text: string;
  team: Team | null;
  kind: 'info' | 'hit' | 'down' | 'end';
}
