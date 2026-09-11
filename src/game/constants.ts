// Rules Snapshot v1：数值表唯一来源（docs/BATTLE_SPEC.md §4）
export const RULES_VERSION = 1;

export const TICK_RATE = 60; // 物理 tick/s
export const DT_MS = 1000 / TICK_RATE; // 16.666...
export const DECISION_PERIOD = 5; // 每 5 tick 一次决策
export const DEFAULT_DURATION_MS = 180_000;
export const TIMER_WARNING_MS = 30_000;
export const DECISION_TIMEOUT_SANCTION_TICKS = 30; // 连续 N tick 无响应计 1 次
export const MAX_SANCTIONS = 100; // 判失联
export const SHELL_MAX_LIFE_MS = 3000;
export const GRASS_EXPOSE_MS = 500;
export const MANUAL_NOISE_DEG = 6;

// --- CP 数值表（模块档位成本均为 1，除传感C=3） ---
export const CP_BUDGET = 12;

export const TIER = {
  armor: { max: 6, per: 15, base: 100 },
  engine: { max: 4, per: 20, base: 120 },
  tracks: { max: 3, per: 20, base: 90 },
  fireRate: { max: 4, per: -60, base: 800 }, // ms
  damage: { max: 4, per: 3, base: 12 },
  turret: { max: 3, per: 30, base: 150 },
  shellSpeed: { max: 2, per: 90, base: 480 },
  view: { max: 3, per: 40, base: 320 },
  comm: { max: 2, per: 1, base: 1 },
} as const;

export const AIM_AUTO_CP = 3;
export const AIM_ASSIST_CP = 1;

// --- 几何 / 物理 ---
export const TILE = 25;
export const MAP_W_TILES = 48;
export const MAP_H_TILES = 32;
export const MAP_W = MAP_W_TILES * TILE; // 1200
export const MAP_H = MAP_H_TILES * TILE; // 800
export const TANK_RADIUS = 16;
export const SHELL_RADIUS = 4;
export const BARREL_OFFSET = 24;
export const BREAKABLE_HP = 50;
export const COLLISION_SUBSTEP = 6; // px
export const MAX_DECIDE_MS = 100;
export const COMM_MSG_MAX_LEN = 64; // 单条队友通信上限
export const COMM_DELAY_FRAMES = 1; // 消息延迟 1 个决策周期投递（跨帧，确定性）

export const TANK_COLOR = {
  red: { main: '#ff3b30', glow: 'rgba(255,59,48,0.55)', name: '红方' },
  blue: { main: '#00e5ff', glow: 'rgba(0,229,255,0.55)', name: '蓝方' },
} as const;

export const TILE_COLOR: Record<string, string> = {
  SOLID: '#2b3a55',
  BREAKABLE: '#8a2be2',
  RUIN: '#3a2b55',
  GRASS: '#0d5c46',
};
