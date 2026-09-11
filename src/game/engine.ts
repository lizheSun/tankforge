import {
  BARREL_OFFSET,
  COLLISION_SUBSTEP,
  COMM_MSG_MAX_LEN,
  GRASS_EXPOSE_MS,
  MAP_H,
  MAP_H_TILES,
  MAP_W,
  MAP_W_TILES,
  MANUAL_NOISE_DEG,
  SHELL_MAX_LIFE_MS,
  TANK_RADIUS,
  TIMER_WARNING_MS,
} from './constants';
import { hasLOS } from './map';
import { Rng } from './rng';
import type {
  Action,
  AllyInfo,
  Ctx,
  CommMsg,
  GameEvent,
  MatchResult,
  MatchSnapshot,
  ResolvedStats,
  ShellState,
  TankResult,
  TankState,
  Team,
  TileType,
  WorldEvent,
} from './types';

const DEG = Math.PI / 180;
export const TICK_RATE_PX = 60;
// NaN 防护：脚本返回非法数值时归零，避免污染整个引擎状态
const clamp1 = (v: number) => (Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0);

export function normalizeDeg(d: number): number {
  if (!Number.isFinite(d)) return 0;
  let a = d % 360;
  if (a > 180) a -= 360;
  if (a <= -180) a += 360;
  return a;
}
export function angleDiff(a: number, b: number): number {
  return normalizeDeg(b - a);
}
export const degToRad = (d: number) => d * DEG;

export interface TankSpawn {
  id: string;
  team: Team;
  name: string;
  buildName: string;
  stats: ResolvedStats;
  pos: { x: number; y: number };
  heading: number;
}

export interface MatchConfig {
  tiles: TileType[][];
  seed: number;
  durationMs: number;
  friendlyFire: boolean;
  spawns: TankSpawn[];
}

export interface EngineMatch {
  tick: number;
  ms: number;
  over: boolean;
  tanks: Map<string, TankState>;
  shells: ShellState[];
  shellSeq: number;
  tiles: TileType[][];
  wallHp: Map<number, number>;
  rng: Rng;
  world: WorldEvent[];
  result: MatchResult | null;
  /** 是否发生过程序判负（崩溃/失联），用于结算 reason=disconnect */
  disconnected: boolean;
  cfg: { durationMs: number; friendlyFire: boolean };
  exposeUntil: Map<string, number>;
  lastPos: Map<string, { x: number; y: number }>; // 上一物理 tick 位置（速度估计）
  teamOfSpawner: Record<string, Team>; // 保留(扩展)
  /** 每队实际出车数（mode 派生：>1 视为 team） */
  teamSize: Record<Team, number>;
  /** 队友通信待投递信箱：tankId -> 消息（帧对齐，跨决策帧投递） */
  inbox: Map<string, CommMsg[]>;
  /** 每决策帧通信带宽使用计数（避免帧间漂移） */
  commUse: Map<string, { frame: number; count: number }>;
}

function mkTank(s: TankSpawn, m: EngineMatch): TankState {
  const t: TankState = {
    id: s.id,
    team: s.team,
    name: s.name,
    buildName: s.buildName,
    points: undefined as never,
    stats: s.stats,
    pos: { ...s.pos },
    heading: s.heading,
    turret: s.heading,
    hp: s.stats.hpMax,
    cooldownMs: 0,
    alive: true,
    intent: { throttle: 0, steerSigned: 0, steerTarget: null, turretTarget: null, turretAuto: false, fireHeld: false },
    events: [],
    hist: [],
    lastScan: new Map(),
    shotsFired: 0,
    hits: 0,
    damageDealt: 0,
    distTravelled: 0,
    timeAliveMs: 0,
    kills: 0,
    sanctions: 0,
    killTick: -1,
  };
  m.tanks.set(t.id, t);
  m.lastPos.set(t.id, { ...s.pos });
  return t;
}

export function createMatch(cfg: MatchConfig): EngineMatch {
  const m: EngineMatch = {
    tick: 0,
    ms: 0,
    over: false,
    tanks: new Map(),
    shells: [],
    shellSeq: 0,
    tiles: cfg.tiles,
    wallHp: new Map(),
    rng: new Rng(cfg.seed),
    world: [],
    result: null,
    disconnected: false,
    cfg: { durationMs: cfg.durationMs, friendlyFire: cfg.friendlyFire },
    exposeUntil: new Map(),
    lastPos: new Map(),
    teamOfSpawner: {},
    teamSize: { red: 0, blue: 0 },
    inbox: new Map(),
    commUse: new Map(),
  };
  for (const s of cfg.spawns) {
    m.teamSize[s.team]++;
    mkTank(s, m);
  }
  // BREAKABLE 耐久
  for (let y = 0; y < MAP_H_TILES; y++)
    for (let x = 0; x < MAP_W_TILES; x++)
      if (m.tiles[y][x] === 'BREAKABLE') m.wallHp.set(y * MAP_W_TILES + x, 50);
  m.world.push({ tick: 0, ms: 0, text: `对局开始 · seed=${cfg.seed}`, team: null, kind: 'info' });
  return m;
}

// ---------- 观测 ----------
function tileOf(m: EngineMatch, x: number, y: number): TileType {
  const tx = Math.floor(x / 25);
  const ty = Math.floor(y / 25);
  if (tx < 0 || ty < 0 || tx >= MAP_W_TILES || ty >= MAP_H_TILES) return 'SOLID';
  return m.tiles[ty][tx];
}

function isGrass(m: EngineMatch, x: number, y: number): boolean {
  return tileOf(m, x, y) === 'GRASS';
}

/** 坦克是否在草丛中可被看到（暴露判定） */
function exposed(m: EngineMatch, t: TankState): boolean {
  return (m.exposeUntil.get(t.id) ?? 0) >= m.ms;
}

/** 敌方观测（噪声依据瞄准档） */
export function viewEnemies(m: EngineMatch, self: TankState): Ctx['view']['enemies'] {
  const list: Ctx['view']['enemies'] = [];
  const noiseDeg = self.stats.aim === 'manual' ? MANUAL_NOISE_DEG : 0;
  for (const o of m.tanks.values()) {
    if (o.team === self.team || !o.alive) continue;
    const dx = o.pos.x - self.pos.x;
    const dy = o.pos.y - self.pos.y;
    const dist = Math.hypot(dx, dy);
    if (dist > self.stats.viewRadius || dist < 1e-6) continue;
    if (isGrass(m, o.pos.x, o.pos.y) && !exposed(m, o)) continue;
    if (!hasLOS(m.tiles, self.pos.x, self.pos.y, o.pos.x, o.pos.y)) continue;
    let obsX = o.pos.x;
    let obsY = o.pos.y;
    let bearing = normalizeDeg(Math.atan2(dy, dx) / DEG - self.heading);
    if (noiseDeg > 0) {
      const ang = m.rng.gauss(noiseDeg);
      const world = (self.heading + bearing + ang) * DEG;
      obsX = self.pos.x + Math.cos(world) * dist;
      obsY = self.pos.y + Math.sin(world) * dist;
      bearing = normalizeDeg(bearing + ang);
    }
    let vel: Ctx['view']['enemies'][number]['vel'] = null;
    if (self.stats.aim !== 'manual' && o.hist.length >= 2) {
      const a = o.hist[o.hist.length - 2];
      const b = o.hist[o.hist.length - 1];
      vel = { dx: (b.x - a.x) * TICK_RATE_PX, dy: (b.y - a.y) * TICK_RATE_PX };
    }
    list.push({
      id: o.id,
      team: o.team,
      bearingDeg: bearing,
      dist,
      pos: { x: obsX, y: obsY },
      heading: o.heading,
      hp: o.hp,
      lastSeenTick: m.tick,
      vel,
    });
  }
  // SCAN_ACQUIRED / SCAN_LOST：可见性状态转移（lastScan 记录最近可见敌集合）
  const seen = new Set(list.map((e) => e.id));
  for (const o of m.tanks.values()) {
    if (o.team === self.team || !o.alive) continue;
    const was = self.lastScan.has(o.id);
    const now = seen.has(o.id);
    if (now && !was) {
      pushEvt(m, self.id, { type: 'SCAN_ACQUIRED', tick: m.tick, ms: m.ms, data: { targetId: o.id } });
    } else if (!now && was) {
      pushEvt(m, self.id, { type: 'SCAN_LOST', tick: m.tick, ms: m.ms, data: { targetId: o.id } });
    }
  }
  for (const id of seen) self.lastScan.set(id, { tick: m.tick, dir: 0 });
  for (const id of [...self.lastScan.keys()]) if (!seen.has(id)) self.lastScan.delete(id);
  return list;
}

// ---------- 队友观测（自传感器 ∪ 战术数据链） ----------

/** 队友是否正处在本车 FOV 内（视距 + 视线 + 草丛） */
function allyInSight(m: EngineMatch, self: TankState, o: TankState): boolean {
  const dist = Math.hypot(o.pos.x - self.pos.x, o.pos.y - self.pos.y);
  if (dist > self.stats.viewRadius || dist < 1e-6) return false;
  if (isGrass(m, o.pos.x, o.pos.y) && !exposed(m, o)) return false;
  return hasLOS(m.tiles, self.pos.x, self.pos.y, o.pos.x, o.pos.y);
}

export function viewAllies(m: EngineMatch, self: TankState): AllyInfo[] {
  const list: AllyInfo[] = [];
  const rank = self.stats.commSlots; // 战术数据链等级：1 基础 / 2 姿态 / 3 高带宽（消息配额另算）
  for (const o of m.tanks.values()) {
    if (o.id === self.id || o.team !== self.team || !o.alive) continue;
    const dx = o.pos.x - self.pos.x;
    const dy = o.pos.y - self.pos.y;
    const dist = Math.hypot(dx, dy);
    const sensor = allyInSight(m, self, o);
    const net = rank >= 1; // 默认开通战术数据链
    if (!sensor && !net) continue;
    let bearingDeg: number | null = null;
    if (sensor) bearingDeg = normalizeDeg(Math.atan2(dy, dx) / DEG - self.heading);
    list.push({
      id: o.id,
      team: o.team,
      name: o.name,
      pos: { x: o.pos.x, y: o.pos.y },
      hp: o.hp,
      maxHp: o.stats.hpMax,
      heading: sensor || rank >= 2 ? o.heading : null,
      sensor,
      net: net && !sensor,
      dist: sensor ? dist : null,
      bearingDeg,
      lastTick: m.tick,
    });
  }
  return list;
}

// ---------- 决策动作 ----------
export function applyActions(m: EngineMatch, tankId: string, actions: Action[]): string[] {
  const t = m.tanks.get(tankId);
  const errs: string[] = [];
  if (!t || !t.alive) return errs;
  if (!Array.isArray(actions)) {
    t.sanctions++;
    errs.push('INVALID_ACTION');
    return errs;
  }
  for (const a of actions) {
    if (!a || typeof a.t !== 'string') {
      t.sanctions++;
      errs.push('INVALID_ACTION');
      continue;
    }
    if (a.t === 'throttle') {
      if (!Number.isFinite(a.v)) {
        t.sanctions++;
        errs.push('OUT_OF_RANGE');
        continue;
      }
      t.intent.throttle = clamp1(a.v);
    } else if (a.t === 'steer') {
      if (!Number.isFinite(a.v)) {
        t.sanctions++;
        errs.push('OUT_OF_RANGE');
        continue;
      }
      t.intent.steerSigned = clamp1(a.v);
      t.intent.steerTarget = null;
    } else if (a.t === 'steerTo') {
      if (!Number.isFinite(a.deg)) {
        t.sanctions++;
        errs.push('OUT_OF_RANGE');
        continue;
      }
      t.intent.steerTarget = normalizeDeg(a.deg);
      t.intent.steerSigned = 0;
    } else if (a.t === 'turretTo') {
      if (!Number.isFinite(a.deg)) {
        t.sanctions++;
        errs.push('OUT_OF_RANGE');
        continue;
      }
      t.intent.turretTarget = normalizeDeg(a.deg);
      t.intent.turretAuto = false;
    } else if (a.t === 'turretAuto') {
      if (t.stats.aim !== 'auto') {
        t.sanctions++;
        errs.push('MODE_UNAVAILABLE');
      } else {
        t.intent.turretAuto = true;
        t.intent.turretTarget = null;
      }
    } else if (a.t === 'fire') {
      t.intent.fireHeld = true;
    } else if (a.t === 'comm') {
      const msg = typeof a.msg === 'string' ? a.msg.trim() : '';
      if (!msg || msg.length > COMM_MSG_MAX_LEN) {
        t.sanctions++;
        errs.push('COMM_INVALID');
      } else {
        const cu = m.commUse.get(t.id);
        const frame = m.tick;
        const count = cu && cu.frame === frame ? cu.count : 0;
        if (count >= t.stats.commSlots) {
          t.sanctions++;
          errs.push('COMM_BANDWIDTH');
        } else {
          m.commUse.set(t.id, { frame, count: count + 1 });
          broadcastComm(m, t, msg, a.to);
        }
      }
    } else {
      // 未知意图类型
      t.sanctions++;
      errs.push('INVALID_ACTION');
    }
  }
  return errs;
}

/** 广播队友通信：写入各队友 inbox，跨决策帧投递（send tick < 收方 buildCtx tick） */
function broadcastComm(m: EngineMatch, sender: TankState, text: string, to?: 'all' | string) {
  const msg: CommMsg = { fromId: sender.id, fromName: sender.name, tick: m.tick, text };
  for (const o of m.tanks.values()) {
    if (o.id === sender.id || o.team !== sender.team || !o.alive) continue;
    if (to && to !== 'all' && o.id !== to) continue;
    const q = m.inbox.get(o.id) ?? [];
    q.push(msg);
    m.inbox.set(o.id, q);
  }
}

function pushEvt(m: EngineMatch, tankId: string, e: GameEvent) {
  const t = m.tanks.get(tankId);
  if (t) t.events.push(e);
}

// ---------- 单物理 tick ----------
export function step(m: EngineMatch): void {
  m.tick++;
  m.ms += 1000 / 60;
  // 先扣装填/计时再物理（开火当 tick 不应立刻扣减冷却，避免射击间隔系统性偏短 1 tick）
  for (const t of m.tanks.values()) {
    if (t.alive) t.timeAliveMs += 1000 / 60;
    t.cooldownMs = Math.max(0, t.cooldownMs - 1000 / 60);
  }
  for (const t of m.tanks.values()) if (t.alive) physicsTick(m, t);
  updateShells(m);
  checkEnd(m);
}

function physicsTick(m: EngineMatch, t: TankState) {
  const it = t.intent;
  // 车体转向
  if (it.steerTarget !== null) {
    const diff = angleDiff(t.heading, it.steerTarget);
    const stepAmt = t.stats.turnRate / 60;
    if (Math.abs(diff) <= stepAmt) t.heading = it.steerTarget;
    else t.heading += Math.sign(diff) * stepAmt;
  } else if (it.steerSigned !== 0) {
    t.heading += it.steerSigned * (t.stats.turnRate / 60);
  }
  t.heading = normalizeDeg(t.heading);

  // 炮塔
  if (it.turretAuto) {
    autoAim(m, t);
  } else if (it.turretTarget !== null) {
    const diff = angleDiff(t.turret, it.turretTarget);
    const stepAmt = t.stats.turretSpeed / 60;
    if (Math.abs(diff) <= stepAmt) t.turret = it.turretTarget;
    else t.turret += Math.sign(diff) * stepAmt;
  }
  t.turret = normalizeDeg(t.turret);

  // 位移 + 碰撞
  const speed = it.throttle * t.stats.moveSpeed;
  const dx = Math.cos(t.heading * DEG) * (speed / 60);
  const dy = Math.sin(t.heading * DEG) * (speed / 60);
  const r = TANK_RADIUS;
  let nx = t.pos.x + dx;
  let ny = t.pos.y + dy;
  const hitWall = () => pushEvt(m, t.id, { type: 'WALL_HIT', tick: m.tick, ms: m.ms, data: {} });
  if (circleHitsWall(m, nx, t.pos.y, r)) {
    nx = t.pos.x;
    hitWall();
  }
  if (circleHitsWall(m, t.pos.x, ny, r)) {
    ny = t.pos.y;
    hitWall();
  }
  if (circleHitsWall(m, nx, ny, r)) {
    nx = t.pos.x;
    ny = t.pos.y;
    hitWall();
  }
  nx = Math.max(r, Math.min(MAP_W - r, nx));
  ny = Math.max(r, Math.min(MAP_H - r, ny));
  // 坦克间推开（不得把任一方挤进墙/推出界：冲突则放弃本帧推开，避免嵌墙卡死）
  for (const o of m.tanks.values()) {
    if (o === t || !o.alive) continue;
    const d2 = (nx - o.pos.x) ** 2 + (ny - o.pos.y) ** 2;
    const rr = r + TANK_RADIUS;
    if (d2 < rr * rr && d2 > 1e-6) {
      const d = Math.sqrt(d2);
      const push = (rr - d) / 2;
      const ux = (nx - o.pos.x) / d;
      const uy = (ny - o.pos.y) / d;
      const tx = nx + ux * push;
      const ty = ny + uy * push;
      const ox = o.pos.x - ux * push;
      const oy = o.pos.y - uy * push;
      const inBounds = (x: number, y: number) => x >= r && x <= MAP_W - r && y >= r && y <= MAP_H - r;
      if (inBounds(tx, ty) && inBounds(ox, oy) && !circleHitsWall(m, tx, ty, r) && !circleHitsWall(m, ox, oy, r)) {
        nx = tx;
        ny = ty;
        o.pos.x = ox;
        o.pos.y = oy;
      }
    }
  }
  const ox = t.pos.x;
  const oy = t.pos.y;
  m.lastPos.set(t.id, { x: ox, y: oy });
  t.pos = { x: nx, y: ny };
  t.hist.push({ x: nx, y: ny });
  if (t.hist.length > 40) t.hist.shift();
  t.distTravelled += Math.hypot(nx - ox, ny - oy);

  // 开火
  if (it.fireHeld && t.cooldownMs <= 0) {
    const rad = t.turret * DEG;
    const muzzle = { x: t.pos.x + Math.cos(rad) * BARREL_OFFSET, y: t.pos.y + Math.sin(rad) * BARREL_OFFSET };
    m.shells.push({
      id: ++m.shellSeq,
      ownerId: t.id,
      team: t.team,
      pos: muzzle,
      prev: muzzle,
      dir: t.turret,
      speed: t.stats.shellSpeed,
      damage: t.stats.damage,
      bornMs: m.ms,
    });
    t.shotsFired++;
    t.cooldownMs = t.stats.fireIntervalMs;
    it.fireHeld = false;
    m.exposeUntil.set(t.id, m.ms + GRASS_EXPOSE_MS);
    pushEvt(m, t.id, { type: 'SHOT_FIRED', tick: m.tick, ms: m.ms, data: {} });
  }
}

/** auto 档：对最近可见敌做弹道提前量伺服 */
function autoAim(m: EngineMatch, t: TankState) {
  const enemies = viewEnemies(m, t);
  let best: Ctx['view']['enemies'][number] | null = null;
  for (const e of enemies) if (!best || e.dist < best.dist) best = e;
  if (!best) return;
  const est = best.vel ?? { dx: 0, dy: 0 };
  let tFly = best.dist / t.stats.shellSpeed;
  for (let i = 0; i < 4; i++) {
    const px = best.pos.x + est.dx * tFly;
    const py = best.pos.y + est.dy * tFly;
    tFly = Math.hypot(px - t.pos.x, py - t.pos.y) / t.stats.shellSpeed;
  }
  const aimAng = Math.atan2(best.pos.y + est.dy * tFly - t.pos.y, best.pos.x + est.dx * tFly - t.pos.x) / DEG;
  const diff = angleDiff(t.turret, aimAng);
  const stepAmt = t.stats.turretSpeed / 60;
  t.turret += Math.sign(diff) * Math.min(stepAmt, Math.abs(diff));
  t.turret = normalizeDeg(t.turret);
}

function circleHitsWall(m: EngineMatch, cx: number, cy: number, r: number): boolean {
  const minTx = Math.max(0, Math.floor((cx - r) / 25));
  const maxTx = Math.min(MAP_W_TILES - 1, Math.floor((cx + r) / 25));
  const minTy = Math.max(0, Math.floor((cy - r) / 25));
  const maxTy = Math.min(MAP_H_TILES - 1, Math.floor((cy + r) / 25));
  for (let ty = minTy; ty <= maxTy; ty++) {
    for (let tx = minTx; tx <= maxTx; tx++) {
      const w = m.tiles[ty][tx];
      if (w !== 'SOLID' && w !== 'BREAKABLE') continue;
      const nx = Math.max(tx * 25, Math.min(cx, tx * 25 + 25));
      const ny = Math.max(ty * 25, Math.min(cy, ty * 25 + 25));
      if ((cx - nx) ** 2 + (cy - ny) ** 2 < r * r) return true;
    }
  }
  return false;
}

function updateShells(m: EngineMatch) {
  const survivors: ShellState[] = [];
  for (const s of m.shells) {
    s.prev = { ...s.pos };
    const stepLen = s.speed / 60;
    s.pos.x += Math.cos(s.dir * DEG) * stepLen;
    s.pos.y += Math.sin(s.dir * DEG) * stepLen;
    let dead = false;
    if (m.ms - s.bornMs > SHELL_MAX_LIFE_MS || s.pos.x < 0 || s.pos.y < 0 || s.pos.x > MAP_W || s.pos.y > MAP_H) {
      dead = true;
    }
    // 细分
    const sub = Math.max(1, Math.ceil(stepLen / COLLISION_SUBSTEP));
    for (let i = 1; i <= sub && !dead; i++) {
      const px = s.prev.x + ((s.pos.x - s.prev.x) * i) / sub;
      const py = s.prev.y + ((s.pos.y - s.prev.y) * i) / sub;
      const wt = tileOf(m, px, py);
      if (wt === 'SOLID') dead = true;
      else if (wt === 'BREAKABLE') {
        dead = true;
        const tx = Math.floor(px / 25);
        const ty = Math.floor(py / 25);
        const key = ty * MAP_W_TILES + tx;
        const remain = (m.wallHp.get(key) ?? 50) - s.damage;
        m.wallHp.set(key, remain);
        m.world.push({ tick: m.tick, ms: m.ms, text: '可破坏墙体承伤', team: null, kind: 'info' });
        if (remain <= 0) {
          m.tiles[ty][tx] = 'RUIN';
          m.world.push({ tick: m.tick, ms: m.ms, text: '墙体被击碎！', team: null, kind: 'info' });
          pushEvt(m, s.ownerId, { type: 'BREAKABLE_DOWN', tick: m.tick, ms: m.ms, data: { x: tx, y: ty } });
        }
      }
      if (dead) break;
      for (const o of m.tanks.values()) {
        if (!o.alive || o.id === s.ownerId) continue;
        if (!m.cfg.friendlyFire && o.team === s.team) continue;
        const d2 = (px - o.pos.x) ** 2 + (py - o.pos.y) ** 2;
        if (d2 <= (TANK_RADIUS + 4) ** 2) {
          dead = true;
          applyHit(m, s, o);
          break;
        }
      }
    }
    if (!dead) survivors.push(s);
  }
  m.shells = survivors;
}

function applyHit(m: EngineMatch, s: ShellState, victim: TankState) {
  const owner = m.tanks.get(s.ownerId);
  const dmg = Math.min(s.damage, victim.hp);
  victim.hp = Math.max(0, victim.hp - dmg);
  m.exposeUntil.set(victim.id, m.ms + GRASS_EXPOSE_MS);
  m.world.push({
    tick: m.tick,
    ms: m.ms,
    text: `${owner?.name ?? '?'} 命中 ${victim.name} -${dmg}`,
    team: owner?.team ?? null,
    kind: 'hit',
  });
  if (owner) {
    owner.hits++;
    owner.damageDealt += dmg;
    pushEvt(m, owner.id, { type: 'HIT_DEALT', tick: m.tick, ms: m.ms, data: { damage: dmg, targetId: victim.id } });
  }
  pushEvt(m, victim.id, { type: 'HIT_RECEIVED', tick: m.tick, ms: m.ms, data: { damage: dmg, fromId: s.ownerId } });
  if (victim.hp <= 0) {
    if (owner) owner.kills++;
    destroyTank(m, victim);
  }
}

function destroyTank(m: EngineMatch, t: TankState) {
  if (!t.alive) return;
  t.alive = false;
  t.killTick = m.tick;
  m.world.push({ tick: m.tick, ms: m.ms, text: `${t.name} 被击毁！`, team: t.team, kind: 'down' });
  for (const o of m.tanks.values()) {
    if (o.id === t.id) continue;
    pushEvt(m, o.id, {
      type: o.team === t.team ? 'ALLIED_DOWN' : 'ENEMY_DOWN',
      tick: m.tick,
      ms: m.ms,
      data: { id: t.id },
    });
  }
  checkEnd(m);
}

/** 外部判负：代码崩溃 / 失联 */
export function forceDestroy(m: EngineMatch, id: string, reason: string) {
  const t = m.tanks.get(id);
  if (!t || !t.alive) return;
  m.disconnected = true; // 结算 reason 记为 disconnect（区分战术击杀与判负）
  m.world.push({ tick: m.tick, ms: m.ms, text: `${t.name} 失联判负：${reason}`, team: t.team, kind: 'down' });
  destroyTank(m, t);
}

function checkEnd(m: EngineMatch) {
  if (m.over) return;
  let redAlive = 0;
  let blueAlive = 0;
  for (const t of m.tanks.values()) {
    if (t.alive) t.team === 'red' ? redAlive++ : blueAlive++;
  }
  // 失联/崩溃导致的清零用 disconnect 结算；双方同 tick 清零判平局
  const reason: 'kill' | 'disconnect' = m.disconnected ? 'disconnect' : 'kill';
  if (redAlive === 0 && blueAlive === 0) return finish(m, null, reason);
  if (redAlive === 0) return finish(m, 'blue', reason);
  if (blueAlive === 0) return finish(m, 'red', reason);
  if (m.ms >= m.cfg.durationMs) return finish(m, null, 'timeout');
  if (m.cfg.durationMs - m.ms <= 30_000 && m.cfg.durationMs - m.ms > 29_950 && !m.world.some((w) => w.text.includes('剩余 30s'))) {
    m.world.push({ tick: m.tick, ms: m.ms, text: '剩余 30s：按存活/HP/伤害裁定', team: null, kind: 'info' });
  }
}

function finish(m: EngineMatch, winner: Team | null, reason: 'kill' | 'timeout' | 'disconnect') {
  m.over = true;
  const teamAlive: Record<Team, number> = { red: 0, blue: 0 };
  const teamHpLeft: Record<Team, number> = { red: 0, blue: 0 };
  const teamTotalDamage: Record<Team, number> = { red: 0, blue: 0 };
  for (const t of m.tanks.values()) {
    if (t.alive) teamAlive[t.team]++;
    teamHpLeft[t.team] += (t.hp / t.stats.hpMax) * 100;
    teamTotalDamage[t.team] += t.damageDealt;
  }
  let draw = false;
  if (reason === 'timeout') {
    const cmp = (a: number, b: number) => (a === b ? 0 : a > b ? 1 : -1);
    let c = cmp(teamAlive.red, teamAlive.blue);
    if (c === 0) c = cmp(teamHpLeft.red, teamHpLeft.blue);
    if (c === 0) c = cmp(teamTotalDamage.red, teamTotalDamage.blue);
    if (c === 0) draw = true;
    winner = draw ? null : c > 0 ? 'red' : 'blue';
  }
  const tankResults: TankResult[] = [...m.tanks.values()].map((t) => ({
    id: t.id,
    team: t.team,
    name: t.name,
    buildName: t.buildName,
    hp: t.hp,
    alive: t.alive,
    damageDealt: t.damageDealt,
    shotsFired: t.shotsFired,
    hits: t.hits,
    accuracy: t.shotsFired ? t.hits / t.shotsFired : 0,
    distTravelled: Math.round(t.distTravelled),
    timeAliveMs: t.timeAliveMs,
    kills: t.kills,
    sanctions: t.sanctions,
  }));
  m.result = {
    phase: 'over',
    winner,
    draw,
    reason,
    teamTotalDamage,
    teamAlive,
    teamHpLeft,
    tankResults,
  };
  m.world.push({
    tick: m.tick,
    ms: m.ms,
    text: draw
      ? '对局结束：平局'
      : `对局结束：${winner === 'red' ? '红方' : '蓝方'}获胜（${reason === 'kill' ? '击毁对方' : '超时裁定'}）`,
    team: winner,
    kind: 'end',
  });
}

export function buildCtx(m: EngineMatch, t: TankState): Ctx {
  const enemies = viewEnemies(m, t);
  const allies = viewAllies(m, t);
  const events = t.events.splice(0, t.events.length);
  // 队友通信投递：只投递早于当前帧发送的消息（发送帧 == 当帧，下一决策帧才可见）
  const pending = m.inbox.get(t.id) ?? [];
  const inbox: CommMsg[] = [];
  const keep: CommMsg[] = [];
  for (const c of pending) (c.tick < m.tick ? inbox : keep).push(c);
  if (keep.length) m.inbox.set(t.id, keep);
  else m.inbox.delete(t.id);
  const used = (cu: { frame: number; count: number } | undefined) => (cu && cu.frame === m.tick ? cu.count : 0);
  const isTeam = m.teamSize.red > 1 || m.teamSize.blue > 1;
  return {
    tick: m.tick,
    clockMs: m.ms,
    timeLeftMs: Math.max(0, m.cfg.durationMs - m.ms),
    self: {
      id: t.id,
      team: t.team,
      name: t.name,
      pos: { ...t.pos },
      heading: t.heading,
      turret: t.turret,
      hp: t.hp,
      maxHp: t.stats.hpMax,
      cooldownMs: t.cooldownMs,
      speed: t.intent.throttle * t.stats.moveSpeed,
      stats: { ...t.stats },
    },
    view: { enemies, allies },
    inbox,
    comm: { slots: t.stats.commSlots, used: used(m.commUse.get(t.id)) },
    events,
    map: { w: MAP_W, h: MAP_H },
    mode: isTeam ? 'team' : '1v1',
    rng: () => m.rng.next(),
  };
}

export function snapshot(m: EngineMatch): MatchSnapshot {
  return {
    w: MAP_W,
    h: MAP_H,
    ms: m.ms,
    tick: m.tick,
    tanks: [...m.tanks.values()],
    shells: m.shells.map((s) => ({ ...s, pos: { ...s.pos }, prev: { ...s.prev } })),
    wallHp: new Map(m.wallHp),
    result: m.result,
  };
}
