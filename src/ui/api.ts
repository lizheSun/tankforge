/** 后端 API 客户端（开发期走 Vite 代理，生产同源直连） */
async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api${url}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data: unknown = null;
  try {
    data = await r.json();
  } catch {
    /* 非 JSON 响应 */
  }
  const err = (data as { error?: string } | null)?.error;
  if (!r.ok || err) throw new Error(err || `请求失败（HTTP ${r.status}）`);
  return data as T;
}

export const api = {
  get: <T>(url: string) => call<T>('GET', url),
  post: <T>(url: string, body?: unknown) => call<T>('POST', url, body ?? {}),
  put: <T>(url: string, body?: unknown) => call<T>('PUT', url, body ?? {}),
};

// ---- 类型 ----
export interface DbConfigDto {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}
export interface TankMeta {
  id: number;
  name: string;
  created_at: string;
  updated_at: string;
}
export interface TournamentMeta {
  id: number;
  title: string;
  type: 'ladder' | 'battle-royale';
  start_time: string | null;
  end_time: string | null;
  created_at: string;
  roster_count: number;
  battle_count: number;
}
export interface RosterItem {
  tank_name: string;
  is_npc: number;
  bot_id: string | null;
}
export interface TeamDto {
  id: number;
  name: string;
  members: string[];
}
export interface BattleRow {
  id: number;
  red_name: string;
  blue_name: string;
  winner: string | null;
  reason: string | null;
  ticks: number;
  created_at: string;
}
export interface BattleTankStatDto {
  name: string;
  hp: number;
  alive: boolean;
  shots: number;
  hits: number;
  dmg: number;
  kills: number;
  sanctions: number;
  accuracy: number;
}
export interface BattleOutcomeDto {
  winner: 'red' | 'blue' | null;
  reason: string;
  ticks: number;
  seed: number;
  tanks: BattleTankStatDto[];
}
export interface TankSpecDto {
  name: string;
  code: string | null;
  botId: string | null;
  build: import('../game/types').BuildPoints;
}
/** 开战响应：结果 + 双方策略（多对多为数组）+ seed（前端重演出对战画面） */
export interface BattleLaunchDto extends BattleOutcomeDto {
  red: TankSpecDto[];
  blue: TankSpecDto[];
}
/** 观看历史对战 */
export interface WatchDto {
  seed: number;
  red: TankSpecDto[];
  blue: TankSpecDto[];
}
export interface TemplateDto {
  name: string;
  description: string;
  code: string;
  build_json: import('../game/types').BuildPoints | null;
  /** 数据库不可用回退时提供（前端映射预设） */
  presetIdx?: number;
}
export interface LeaderRow {
  name: string;
  npc: boolean;
  battles: number;
  wins: number;
  draws: number;
  losses: number;
  kills: number;
  shots: number;
  hits: number;
  accuracy: number;
  /** 天梯积分 = 胜×3 + 平×1 + 击杀×1 + 命中率×5 */
  score: number;
}
