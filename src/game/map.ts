import { BREAKABLE_HP, MAP_H_TILES, MAP_W_TILES } from './constants';
import type { TileType } from './types';

export interface GameMap {
  id: string;
  name: string;
  desc: string;
  wTiles: number;
  hTiles: number;
  tiles: TileType[][]; // [y][x]
}

function emptyTiles(w: number, h: number): TileType[][] {
  return Array.from({ length: h }, () => Array.from({ length: w }, () => 'EMPTY' as TileType));
}

function mirrorX(map: GameMap) {
  for (let y = 0; y < map.hTiles; y++)
    for (let x = 0; x < Math.floor(map.wTiles / 2); x++)
      map.tiles[y][map.wTiles - 1 - x] = map.tiles[y][x];
}
function mirrorY(map: GameMap) {
  for (let y = 0; y < Math.floor(map.hTiles / 2); y++)
    for (let x = 0; x < map.wTiles; x++)
      map.tiles[map.hTiles - 1 - y][x] = map.tiles[y][x];
}

function border(map: GameMap, t: TileType = 'SOLID') {
  for (let x = 0; x < map.wTiles; x++) {
    map.tiles[0][x] = t;
    map.tiles[map.hTiles - 1][x] = t;
  }
  for (let y = 0; y < map.hTiles; y++) {
    map.tiles[y][0] = t;
    map.tiles[y][map.wTiles - 1] = t;
  }
}

function rect(map: GameMap, x0: number, y0: number, x1: number, y1: number, t: TileType) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) map.tiles[y][x] = t;
}

// 只需设计左上象限，然后两次镜像保证轴对称（左右/上下），使双方出生环境完全对称
function buildSym(fn: (m: GameMap) => void): GameMap {
  const m: GameMap = {
    id: '',
    name: '',
    desc: '',
    wTiles: MAP_W_TILES,
    hTiles: MAP_H_TILES,
    tiles: emptyTiles(MAP_W_TILES, MAP_H_TILES),
  };
  border(m);
  fn(m);
  mirrorX(m);
  mirrorY(m);
  return m;
}

export function buildMap(id: string): GameMap {
  if (id === 'arena_ruins') {
    const m = buildSym((mm) => {
      // 左上象限特征：中央近场的可破坏通道 + 立柱 + 草丛
      // 中央纵向可破坏墙（会在镜像后形成中线两侧双墙，留中缝）
      rect(mm, 10, 4, 11, 12, 'BREAKABLE'); // 中线附近，象限内部；镜像后保留中缝对称
      rect(mm, 6, 9, 7, 12, 'SOLID'); // 立柱群
      rect(mm, 13, 7, 14, 8, 'SOLID');
      rect(mm, 8, 2, 12, 3, 'GRASS'); // 左上草丛（红方可能出生附近）
    });
    m.id = 'arena_ruins';
    m.name = '废墟演兵场';
    m.desc = '中路可破坏墙 + 四角立柱 + 草丛隐蔽，侦察与破墙博弈';
    return m;
  }
  if (id === 'open_field') {
    const m = buildSym((mm) => {
      rect(mm, 6, 5, 6, 10, 'SOLID');
      rect(mm, 12, 8, 14, 8, 'GRASS');
      rect(mm, 9, 2, 10, 4, 'BREAKABLE');
    });
    m.id = 'open_field';
    m.name = '开阔竞技场';
    m.desc = '少掩体，练瞄准与走位';
    return m;
  }
  // 默认：镜像对称的经典图
  const m = buildSym((mm) => {
    rect(mm, 11, 5, 12, 13, 'BREAKABLE');
    rect(mm, 7, 6, 8, 9, 'SOLID');
    rect(mm, 5, 12, 9, 13, 'GRASS');
  });
  m.id = 'crossroads';
  m.name = '十字路口';
  m.desc = '经典对称战场';
  return m;
}

export const MAP_IDS = ['crossroads', 'arena_ruins', 'open_field'];

/** 瓦片是否阻挡坦克 */
export function blocksTank(t: TileType): boolean {
  return t === 'SOLID' || t === 'BREAKABLE';
}
/** 瓦片是否阻挡弹丸 */
export function blocksShell(t: TileType): boolean {
  return t === 'SOLID' || t === 'BREAKABLE';
}
/** 瓦片是否阻挡视线 */
export function blocksLOS(t: TileType): boolean {
  return t === 'SOLID' || t === 'BREAKABLE';
}

export function idx(x: number, y: number): number {
  return y * MAP_W_TILES + x;
}

/** 线段视线检测：从 a 到 b，若被遮挡返回 false */
export function hasLOS(tiles: TileType[][], ax: number, ay: number, bx: number, by: number): boolean {
  const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 6));
  for (let i = 1; i < steps; i++) {
    const px = ax + ((bx - ax) * i) / steps;
    const py = ay + ((by - ay) * i) / steps;
    const tx = Math.floor(px / 25);
    const ty = Math.floor(py / 25);
    if (tx < 0 || ty < 0 || tx >= MAP_W_TILES || ty >= MAP_H_TILES) continue;
    if (blocksLOS(tiles[ty][tx])) return false;
  }
  return true;
}

/** 让 BREAKABLE 的初始耐久可查询 */
export function breakableAt(tiles: TileType[][]): Map<number, number> {
  const hp = new Map<number, number>();
  for (let y = 0; y < MAP_H_TILES; y++)
    for (let x = 0; x < MAP_W_TILES; x++)
      if (tiles[y][x] === 'BREAKABLE') hp.set(idx(x, y), BREAKABLE_HP);
  return hp;
}
