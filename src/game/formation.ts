// ============================================================
// TANKFORGE · NvN 团战布阵（确定性对称生成）
// 红方在西北出生区按距离锚点排序取 S 个“无墙空白点”，
// 蓝方以地图中心镜像 → 任意镜像对称图保证公平、且镜像后仍空白。
// ============================================================
import { MAP_H, MAP_W, TANK_RADIUS, TILE } from './constants';
import type { Team, TileType } from './types';

export const TEAM_SIZE_MIN = 2;
export const TEAM_SIZE_MAX = 5;

export interface SpawnSlot {
  x: number;
  y: number;
  heading: number;
}

const DEG = Math.PI / 180;

/** 圆是否与 SOLID/BREAKABLE 相交（与引擎 circleHitsWall 同口径） */
function circleHitsWall(tiles: TileType[][], cx: number, cy: number, r: number): boolean {
  const wTiles = tiles[0].length;
  const hTiles = tiles.length;
  const minTx = Math.max(0, Math.floor((cx - r) / TILE));
  const maxTx = Math.min(wTiles - 1, Math.floor((cx + r) / TILE));
  const minTy = Math.max(0, Math.floor((cy - r) / TILE));
  const maxTy = Math.min(hTiles - 1, Math.floor((cy + r) / TILE));
  for (let ty = minTy; ty <= maxTy; ty++) {
    for (let tx = minTx; tx <= maxTx; tx++) {
      const w = tiles[ty][tx];
      if (w !== 'SOLID' && w !== 'BREAKABLE') continue;
      const nx = Math.max(tx * TILE, Math.min(cx, tx * TILE + TILE));
      const ny = Math.max(ty * TILE, Math.min(cy, ty * TILE + TILE));
      if ((cx - nx) ** 2 + (cy - ny) ** 2 < r * r) return true;
    }
  }
  return false;
}

/** 车体+余量安全（不穿墙、不出界、不与其他出生位重叠） */
function cellClear(
  tiles: TileType[][],
  x: number,
  y: number,
  taken: SpawnSlot[],
  minSep: number,
): boolean {
  const r = TANK_RADIUS;
  if (x - r < 2 || y - r < 2 || x + r > MAP_W - 2 || y + r > MAP_H - 2) return false;
  if (circleHitsWall(tiles, x, y, r + 3)) return false;
  for (const t of taken) if ((t.x - x) ** 2 + (t.y - y) ** 2 < minSep * minSep) return false;
  return true;
}

const headingToCenter = (x: number, y: number) => Math.atan2(MAP_H / 2 - y, MAP_W / 2 - x) / DEG;

/** 出生车距下限（两车体 32px + 44px 余量，避免开局贴脸） */
const SPAWN_SEP = TANK_RADIUS * 2 + 44;

/** 生成西北象限候选格（距红方锚点 (150,150) 由近及远），经空白过滤后取 S 个 */
function redSlots(tiles: TileType[][], size: number): SpawnSlot[] {
  const anchor = { x: 150, y: 150 };
  // 两层扫描区：先密集近场，不足再扩到整个左上 1/4 战场
  const rings: Array<{ x0: number; x1: number; y0: number; y1: number; step: number }> = [
    { x0: 100, x1: 340, y0: 100, y1: 280, step: 60 },
    { x0: 70, x1: 560, y0: 70, y1: 360, step: 60 },
  ];
  const picked: SpawnSlot[] = [];
  const chosen = new Set<string>();
  for (const ring of rings) {
    const cand: Array<{ x: number; y: number; d2: number }> = [];
    for (let y = ring.y0; y <= ring.y1; y += ring.step) {
      for (let x = ring.x0; x <= ring.x1; x += ring.step) {
        const d2 = (x - anchor.x) ** 2 + (y - anchor.y) ** 2;
        cand.push({ x, y, d2 });
      }
    }
    cand.sort((a, b) => a.d2 - b.d2);
    for (const c of cand) {
      if (picked.length >= size) return picked;
      const key = `${Math.round(c.x)},${Math.round(c.y)}`;
      if (chosen.has(key)) continue;
      if (cellClear(tiles, c.x, c.y, picked, SPAWN_SEP)) {
        chosen.add(key);
        picked.push({ x: c.x, y: c.y, heading: headingToCenter(c.x, c.y) });
      }
    }
  }
  // 理论地图都被撑爆时兜底：以锚点为中心 45° 螺旋回退外扩
  let fallback = 0;
  while (picked.length < size && fallback < 300) {
    fallback++;
    const ang = (fallback * 137.5) % 360; // 黄金角螺旋
    const rad = 40 + fallback * 4;
    const x = anchor.x + Math.cos((ang * Math.PI) / 180) * rad;
    const y = anchor.y + Math.sin((ang * Math.PI) / 180) * rad;
    if (cellClear(tiles, x, y, picked, SPAWN_SEP)) {
      picked.push({ x: Math.round(x), y: Math.round(y), heading: headingToCenter(x, y) });
    }
  }
  if (picked.length < size) throw new Error(`布阵失败：${size} 车找不到足够空白出生点`);
  return picked;
}

/** 团战出生位：红方取西北、蓝方按地图中心镜像 */
export function teamSpawns(tiles: TileType[][], size: number, team: Team): SpawnSlot[] {
  const red = redSlots(tiles, size);
  if (team === 'red') return red;
  return red.map((s) => ({
    x: MAP_W - s.x,
    y: MAP_H - s.y,
    heading: headingToCenter(MAP_W - s.x, MAP_H - s.y),
  }));
}

export function validateTeamSize(n: number): boolean {
  return n >= TEAM_SIZE_MIN && n <= TEAM_SIZE_MAX;
}
