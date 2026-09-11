import { BARREL_OFFSET, MAP_H, MAP_W, TANK_COLOR, TANK_RADIUS, TILE } from '../game/constants';
import type { MatchSnapshot, TankState, Team, TileType } from '../game/types';

interface Particle {
  x: number;
  y: number;
  life: number;
  max: number;
  color: string;
  size: number;
  speed: number;
  kind: 'explosion' | 'spark';
}

const TAU = Math.PI * 2;

export class BattleRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private scale = 1;
  private offX = 0;
  private offY = 0;
  private particles: Particle[] = [];
  private prevAlive = new Set<string>();
  private flash = new Map<string, number>();
  private time = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.resize();
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssW = this.canvas.clientWidth || 960;
    const cssH = this.canvas.clientHeight || 640;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.scale = Math.min(cssW / MAP_W, cssH / MAP_H);
    this.offX = (cssW - MAP_W * this.scale) / 2;
    this.offY = (cssH - MAP_H * this.scale) / 2;
  }

  private toScreen(x: number, y: number) {
    return { x: this.offX + x * this.scale, y: this.offY + y * this.scale };
  }
  private r(v: number) {
    return v * this.scale;
  }

  frame(snap: MatchSnapshot, tiles: TileType[][], dtMs: number) {
    this.time += dtMs;
    this.updateParticles(dtMs);
    const c = this.ctx;
    c.clearRect(0, 0, this.canvas.clientWidth, this.canvas.clientHeight);
    // 战场底
    c.fillStyle = '#070b16';
    c.fillRect(0, 0, this.canvas.clientWidth, this.canvas.clientHeight);
    c.save();
    c.translate(this.offX, this.offY);
    c.scale(this.scale, this.scale);

    this.drawTiles(snap, tiles);
    this.drawGrid();
    this.drawShells(snap);
    for (const t of snap.tanks) this.drawTank(snap, t);
    this.drawParticles();

    c.restore();

    // 检测击毁 -> 爆炸粒子
    const aliveNow = new Set(snap.tanks.filter((t) => t.alive).map((t) => t.id));
    for (const t of snap.tanks) {
      if (!t.alive && this.prevAlive.has(t.id)) this.explode(t.pos.x, t.pos.y, t.team);
    }
    this.prevAlive = aliveNow;
  }

  private drawTiles(snap: MatchSnapshot, tiles: TileType[][]) {
    const c = this.ctx;
    for (let ty = 0; ty < tiles.length; ty++) {
      for (let tx = 0; tx < tiles[ty].length; tx++) {
        const w = tiles[ty][tx];
        const x = tx * TILE;
        const y = ty * TILE;
        if (w === 'EMPTY') continue;
        if (w === 'GRASS') {
          c.fillStyle = 'rgba(24,86,60,0.35)';
          c.fillRect(x, y, TILE, TILE);
          c.fillStyle = 'rgba(70,160,110,0.25)';
          for (let i = 0; i < 3; i++) {
            c.fillRect(x + 4 + ((tx * 7 + i * 9) % 14), y + 5 + ((ty * 11 + i * 13) % 16), 3, 5);
          }
          continue;
        }
        if (w === 'RUIN') {
          c.fillStyle = '#241d33';
          c.fillRect(x, y, TILE, TILE);
          continue;
        }
        if (w === 'SOLID') {
          c.fillStyle = '#1b2436';
          c.fillRect(x, y, TILE, TILE);
          c.fillStyle = '#3d5582';
          c.fillRect(x + 2, y + 2, TILE - 4, TILE - 4);
          c.strokeStyle = 'rgba(120,190,255,0.25)';
          c.strokeRect(x + 0.5, y + 0.5, TILE - 1, TILE - 1);
          continue;
        }
        if (w === 'BREAKABLE') {
          const key = ty * 48 + tx;
          const hp = snap.wallHp.get(key) ?? 50;
          const frac = Math.max(0, hp / 50);
          c.fillStyle = 'rgba(40,20,60,1)';
          c.fillRect(x, y, TILE, TILE);
          c.fillStyle = `rgba(${150 + (1 - frac) * 60}, ${80 * frac}, 220, ${0.35 + 0.5 * frac})`;
          c.fillRect(x + 3, y + 3, TILE - 6, TILE - 6);
          if (frac < 1) {
            c.strokeStyle = `rgba(200,120,255,${0.9 - frac * 0.5})`;
            c.beginPath();
            for (let yy = y + 4; yy < y + TILE - 3; yy += 5) {
              c.moveTo(x + 3, yy);
              c.lineTo(x + TILE - 3, yy + 2);
            }
            c.stroke();
          }
        }
      }
    }
  }

  private drawGrid() {
    const c = this.ctx;
    c.strokeStyle = 'rgba(0,229,255,0.04)';
    c.lineWidth = 1;
    c.beginPath();
    for (let x = 0; x <= MAP_W; x += 100) {
      c.moveTo(x, 0);
      c.lineTo(x, MAP_H);
    }
    for (let y = 0; y <= MAP_H; y += 100) {
      c.moveTo(0, y);
      c.lineTo(MAP_W, y);
    }
    c.stroke();
  }

  private drawShells(snap: MatchSnapshot) {
    const c = this.ctx;
    for (const s of snap.shells) {
      const owner = snap.tanks.find((t) => t.id === s.ownerId);
      const color = owner ? TANK_COLOR[owner.team].main : '#fff';
      c.strokeStyle = color;
      c.globalAlpha = 0.9;
      c.lineWidth = 3;
      c.beginPath();
      c.moveTo(s.prev.x, s.prev.y);
      c.lineTo(s.pos.x, s.pos.y);
      c.stroke();
      c.globalAlpha = 1;
      c.fillStyle = color;
      c.shadowColor = color;
      c.shadowBlur = 8;
      c.beginPath();
      c.arc(s.pos.x, s.pos.y, 3, 0, TAU);
      c.fill();
      c.shadowBlur = 0;
    }
  }

  private drawTank(snap: MatchSnapshot, t: TankState) {
    const c = this.ctx;
    const col = TANK_COLOR[t.team];
    const destroyed = !t.alive;
    const alpha = destroyed ? Math.max(0.15, 1 - (snap.ms - t.killTick * 16.666) / 900) : 1;
    c.save();
    c.globalAlpha = alpha;
    // 阴影
    c.fillStyle = 'rgba(0,0,0,0.35)';
    c.beginPath();
    c.ellipse(t.pos.x + 2, t.pos.y + 3, TANK_RADIUS, TANK_RADIUS * 0.8, 0, 0, TAU);
    c.fill();
    // 车体
    const body = this.bodyPath(t.pos.x, t.pos.y, t.heading);
    c.fillStyle = destroyed ? '#3a3f4d' : '#0d1420';
    c.fill(body);
    c.strokeStyle = col.main;
    c.lineWidth = 2;
    c.shadowColor = col.glow;
    c.shadowBlur = 10;
    c.stroke(body);
    c.shadowBlur = 0;
    // 炮管
    const ang = (t.turret * Math.PI) / 180;
    const mx = t.pos.x + Math.cos(ang) * BARREL_OFFSET;
    const my = t.pos.y + Math.sin(ang) * BARREL_OFFSET;
    c.strokeStyle = destroyed ? '#888' : col.main;
    c.lineWidth = 5;
    c.beginPath();
    c.moveTo(t.pos.x, t.pos.y);
    c.lineTo(mx, my);
    c.stroke();
    // 炮口闪烁
    if (t.cooldownMs > t.stats.fireIntervalMs - 140 && t.cooldownMs < t.stats.fireIntervalMs) {
      c.fillStyle = '#fff7cf';
      c.shadowColor = '#ffdd55';
      c.shadowBlur = 14;
      c.beginPath();
      c.arc(mx, my, 4, 0, TAU);
      c.fill();
      c.shadowBlur = 0;
    }
    // 车体朝向指示
    const hx = t.pos.x + Math.cos((t.heading * Math.PI) / 180) * 10;
    const hy = t.pos.y + Math.sin((t.heading * Math.PI) / 180) * 10;
    c.strokeStyle = '#8fa3c0';
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(t.pos.x, t.pos.y);
    c.lineTo(hx, hy);
    c.stroke();

    // 血条
    if (!destroyed) {
      const hpW = 46;
      const hpFrac = t.hp / t.stats.hpMax;
      const bx = t.pos.x - hpW / 2;
      const by = t.pos.y - TANK_RADIUS - 12;
      c.fillStyle = 'rgba(0,0,0,0.6)';
      c.fillRect(bx - 1, by - 1, hpW + 2, 6);
      c.fillStyle = '#3c1f24';
      c.fillRect(bx, by, hpW, 4);
      c.fillStyle = hpFrac > 0.4 ? col.main : '#ffd23c';
      c.fillRect(bx, by, hpW * hpFrac, 4);
      // 名称
      c.font = '600 10px Rajdhani, monospace';
      c.textAlign = 'center';
      c.fillStyle = '#cfe4ff';
      c.fillText(t.name.slice(0, 12), t.pos.x, by - 4);
    }
    c.restore();
  }

  private bodyPath(x: number, y: number, heading: number) {
    const p = new Path2D();
    const len = TANK_RADIUS * 1.55;
    const wid = TANK_RADIUS * 1.1;
    const h = (heading * Math.PI) / 180;
    const cos = Math.cos(h);
    const sin = Math.sin(h);
    // 矩形角点旋转
    const corners = [
      { x: len, y: wid },
      { x: len, y: -wid },
      { x: -len, y: -wid },
      { x: -len, y: wid },
    ];
    p.moveTo(x + corners[0].x * cos - corners[0].y * sin, y + corners[0].x * sin + corners[0].y * cos);
    for (let i = 1; i < 4; i++) {
      p.lineTo(x + corners[i].x * cos - corners[i].y * sin, y + corners[i].x * sin + corners[i].y * cos);
    }
    p.closePath();
    return p;
  }

  private explode(x: number, y: number, team: Team) {
    const col = TANK_COLOR[team].main;
    for (let i = 0; i < 26; i++) {
      this.particles.push({
        x,
        y,
        life: 0,
        max: 300 + Math.random() * 500,
        color: i % 3 === 0 ? '#ffd23c' : i % 2 ? col : '#fff',
        size: 2 + Math.random() * 5,
        speed: 40 + Math.random() * 160,
        kind: 'explosion',
      });
    }
  }

  private updateParticles(dt: number) {
    for (const p of this.particles) {
      p.life += dt;
      const a = (p.life / p.max) * Math.PI;
      p.x += Math.cos(a * 5 + p.size) * p.speed * (dt / 1000);
      p.y += Math.sin(a * 5 + p.size) * p.speed * (dt / 1000) * 0.8;
    }
    this.particles = this.particles.filter((p) => p.life < p.max);
  }

  private drawParticles() {
    const c = this.ctx;
    for (const p of this.particles) {
      const t = p.life / p.max;
      c.globalAlpha = 1 - t;
      c.fillStyle = p.color;
      c.beginPath();
      c.arc(p.x, p.y, p.size * (1 - t * 0.7), 0, TAU);
      c.fill();
    }
    c.globalAlpha = 1;
  }
}
