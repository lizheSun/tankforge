import { useEffect, useMemo, useRef, useState } from 'react';
import { BUILTIN_BOT_BY_ID, sideBuild, sideCodeOf, sideDriverName, sideStats, type BattleSetupData, type SideSetup } from './config';
import { snapshot, type TankSpawn } from '../game/engine';
import { teamSpawns } from '../game/formation';
import { buildMap } from '../game/map';
import { MatchRunner, type RunnerDriver } from '../game/runner';
import { createScriptDriver, type ScriptHandle } from '../sandbox/scriptDriver';
import { BattleRenderer } from '../render/renderer';
import {
  buildReplay,
  matchFingerprint,
  saveReplayToFile,
  type ReplayFile,
  type ReplaySideRecord,
} from '../replay/replay';
import type { MatchResult, Team, WorldEvent } from '../game/types';

export interface Props {
  setup: BattleSetupData;
  replay?: ReplayFile;
  onExit: () => void;
  /** 退出按钮文案（本地对战/赛事观战不同） */
  exitLabel?: string;
}

const SPEEDS = [1, 2, 4, 8];

/** 每个成员一辆坦克：独立 spawn id / 独立 Worker（脚本）/ 独立记忆 */
function buildMemberDriver(side: SideSetup, idx: number, name: string): { id: string; drv: RunnerDriver; handle: ScriptHandle | null } {
  const id = `${side.team}-${idx}`;
  if (side.kind === 'bot') {
    const bot = BUILTIN_BOT_BY_ID(side.botId);
    return { id, drv: { id, name, kind: 'bot', decide: (ctx) => bot.decide(ctx) }, handle: null };
  }
  const h = createScriptDriver(name, sideCodeOf(side));
  return { id, drv: { id, name, kind: 'script', decide: (ctx) => h.decide(ctx) }, handle: h };
}

function toReplaySide(s: SideSetup): ReplaySideRecord {
  const b = sideBuild(s);
  return {
    team: s.team,
    kind: s.kind === 'bot' ? 'bot' : s.kind === 'pack' ? 'pack' : 'script',
    botId: s.kind === 'bot' ? s.botId : null,
    name: sideDriverName(s),
    buildName: b.name,
    points: b.points,
    code: s.kind === 'bot' ? null : sideCodeOf(s),
    pack:
      s.kind === 'pack' && s.pack
        ? { name: s.pack.name, version: s.pack.version, author: s.pack.author, brainFile: s.pack.brainFile }
        : null,
  };
}

interface TankHud {
  name: string;
  hp: number;
  max: number;
  alive: boolean;
  dmg: number;
  shots: number;
  hits: number;
  sanctions: number;
}
interface HudData {
  ms: number;
  over: boolean;
  red: TankHud[];
  blue: TankHud[];
  logTail: WorldEvent[];
}

function logClass(w: WorldEvent): string {
  if (w.kind === 'end' || w.kind === 'down') return 'end';
  if (w.kind === 'hit') return w.team ?? 'info';
  return 'info';
}

export function Battle({ setup, replay, onExit, exitLabel }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [paused, setPaused] = useState(false);
  const [speed, setSpeed] = useState(2);
  const [hud, setHud] = useState<HudData | null>(null);
  const pausedRef = useRef(paused);
  const speedRef = useRef(speed);
  const runnerRef = useRef<MatchRunner | null>(null);
  const rendererRef = useRef<BattleRenderer | null>(null);
  const handlesRef = useRef<ScriptHandle[]>([]);
  pausedRef.current = paused;
  speedRef.current = speed;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = new BattleRenderer(canvas);
    rendererRef.current = renderer;

    const tiles = buildMap(setup.mapId);
    const redSlots = teamSpawns(tiles.tiles, setup.red.length, 'red');
    const blueSlots = teamSpawns(tiles.tiles, setup.blue.length, 'blue');
    const spawns: TankSpawn[] = [];
    const drivers: RunnerDriver[] = [];
    const handles: ScriptHandle[] = [];
    // 队内显示名去重（同基准克隆/轮换轮回时追加 #2/#3），保证 HUD key 与战报可区分
    const teamNames = new Map<Team, Map<string, number>>();
    const deployTeam = (team: Team, sides: SideSetup[], slots: ReturnType<typeof teamSpawns>) => {
      const seen = teamNames.get(team) ?? new Map<string, number>();
      teamNames.set(team, seen);
      sides.forEach((side, i) => {
        const base = sideDriverName(side);
        const k = seen.get(base) ?? 0;
        seen.set(base, k + 1);
        const name = k === 0 ? base : `${base} #${k + 1}`;
        const m = buildMemberDriver(side, i, name);
        spawns.push({
          id: m.id,
          team,
          name,
          buildName: sideBuild(side).name,
          stats: sideStats(side),
          pos: { x: slots[i].x, y: slots[i].y },
          heading: slots[i].heading,
        });
        drivers.push(m.drv);
        if (m.handle) handles.push(m.handle);
      });
    };
    deployTeam('red', setup.red, redSlots);
    deployTeam('blue', setup.blue, blueSlots);
    handlesRef.current = handles;

    const runner = new MatchRunner({
      config: {
        tiles: tiles.tiles,
        seed: setup.seed,
        durationMs: setup.durationMs,
        friendlyFire: false,
        spawns,
      },
      drivers,
    });
    runnerRef.current = runner;

    let alive = true;
    let lastHud = 0;
    const toHud = (team: Team): TankHud[] => {
      const out: TankHud[] = [];
      for (const t of runner.m.tanks.values()) {
        if (t.team !== team) continue;
        out.push({
          name: t.name,
          hp: Math.ceil(t.hp),
          max: t.stats.hpMax,
          alive: t.alive,
          dmg: Math.round(t.damageDealt),
          shots: t.shotsFired,
          hits: t.hits,
          sanctions: t.sanctions,
        });
      }
      return out;
    };
    const pump = async () => {
      if (!alive) return;
      const r = runnerRef.current;
      if (r) {
        if (!pausedRef.current && !r.m.over) {
          await r.stepN(speedRef.current || 1);
        }
        rendererRef.current?.frame(snapshot(r.m), tiles.tiles, 16.7);
        const now = performance.now();
        if (now - lastHud > 110) {
          lastHud = now;
          const over = r.m.over;
          setHud({ ms: r.m.ms, over, red: toHud('red'), blue: toHud('blue'), logTail: r.m.world.slice(-40) });
        }
        if (r.m.over) {
          // 对局结束：终态 HUD 已提交，停止 rAF 循环（避免结算画面持续重渲染）
          setHud({ ms: r.m.ms, over: true, red: toHud('red'), blue: toHud('blue'), logTail: r.m.world.slice(-40) });
          return;
        }
      }
      requestAnimationFrame(pump);
    };
    const onResize = () => rendererRef.current?.resize();
    window.addEventListener('resize', onResize);
    requestAnimationFrame(pump);

    return () => {
      alive = false;
      window.removeEventListener('resize', onResize);
      handlesRef.current.forEach((h) => h.dispose());
      runnerRef.current = null;
      rendererRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const result: MatchResult | null = hud?.over ? (runnerRef.current?.m.result ?? null) : null;

  const verified = useMemo(() => {
    if (!hud?.over || !replay || !runnerRef.current) return null;
    return matchFingerprint(runnerRef.current) === replay.fingerprint;
  }, [hud?.over, replay]);

  const exportReplay = () => {
    const r = runnerRef.current;
    if (!r) return;
    const label = (sides: SideSetup[]) => sides.map(sideDriverName).join(' + ');
    const rep = buildReplay({
      title: `${label(setup.red)} vs ${label(setup.blue)} @ ${setup.mapId} #${setup.seed}`,
      mapId: setup.mapId,
      seed: setup.seed,
      durationMs: setup.durationMs,
      red: setup.red.map(toReplaySide),
      blue: setup.blue.map(toReplaySide),
      runner: r,
    });
    saveReplayToFile(rep);
  };

  return (
    <div className="battle">
      <header className="battle-head">
        <div className="brand" style={{ gap: 10 }}>
          <span className="logo" style={{ width: 26, height: 26 }} />
          <h1 style={{ fontSize: 15 }}>TANK<em>FORGE</em></h1>
          <span className="tf-hint">BATTLE // {setup.mapId}</span>
          {replay && <span className="chip amber">🧪 回放模式</span>}
        </div>
        <div className="status-chips">
          {hud?.over ? (
            <span className="chip" style={{ color: '#ffb020', borderColor: 'rgba(255,176,32,.5)' }}>
              ■ 对局结束
            </span>
          ) : paused ? (
            <span className="chip">■ 暂停</span>
          ) : (
            <span className="chip live">● 战斗中</span>
          )}
          <span className="chip cyan">
            T+{hud ? (hud.ms / 1000).toFixed(0) : 0}s / {(setup.durationMs / 1000).toFixed(0)}s
          </span>
          <span className="chip">seed {setup.seed}</span>
        </div>
        <div className="ctl-row">
          <div className="grp">
            {SPEEDS.map((s) => (
              <button key={s} className={`btn small ${speed === s ? 'primary' : ''}`} onClick={() => setSpeed(s)}>
                ×{s}
              </button>
            ))}
            <button className="btn small" onClick={() => setPaused((p) => !p)}>
              {paused ? '▶ 继续' : '❚❚ 暂停'}
            </button>
            <button className="btn small" onClick={onExit}>
              {exitLabel ?? '⇤ 返回布阵'}
            </button>
          </div>
        </div>
      </header>

      <main className="battle-main">
        <div className="arena-wrap">
          <div className="arena-frame">
            <canvas ref={canvasRef} />
            <span className="arena-corner tl" />
            <span className="arena-corner tr" />
            <span className="arena-corner bl" />
            <span className="arena-corner br" />
            {result && (
              <ResultOverlay
                result={result}
                onExit={onExit}
                onExport={exportReplay}
                verify={verified}
                replayFp={replay?.fingerprint ?? null}
                exitLabel={exitLabel ?? '⇤ 返回布阵 · 调整策略再战'}
              />
            )}
          </div>
        </div>

        <aside className="sidebar">
          <TeamCard hud={hud?.red ?? []} team="red" />
          <TeamCard hud={hud?.blue ?? []} team="blue" />
          <section className="console-panel tf-panel">
            <header className="console-head">◢ 战术事件流 ◣</header>
            <div className="feed scroll-thin">
              {(hud?.logTail ?? []).map((w, i) => (
                <div key={`${w.tick}-${i}`} className={logClass(w)}>
                  <span className="tick">[{w.tick}]</span>
                  {w.text}
                </div>
              ))}
            </div>
          </section>
        </aside>
      </main>
    </div>
  );
}

function TeamCard({ hud, team }: { hud: TankHud[]; team: Team }) {
  const alive = hud.filter((h) => h.alive).length;
  return (
    <section className={`team-card tf-panel ${team}`}>
      <div className="tc-head">
        <span>{team === 'red' ? '◤ RED' : 'BLUE ◢'}</span>
        <span>
          {hud.length ? (alive > 0 ? `${alive}/${hud.length} ACTIVE` : '✖ 全灭') : '● ACTIVE'}
        </span>
      </div>
      {hud.length === 0 ? (
        <div className="tf-hint">…</div>
      ) : (
        <div className="unit-list">
          {hud.map((u) => (
            <div key={u.name} className={`unit-row${u.alive ? '' : ' dead'}`}>
              <div className="u-head">
                <span>{u.name}</span>
                <span>
                  {u.alive ? `${u.hp}/${u.max}` : '击毁'}
                  {u.sanctions > 0 ? ` ·违规${u.sanctions}` : ''}
                </span>
              </div>
              <div className="hp-bar">
                <div className="fill" style={{ width: `${u.alive ? (u.hp / u.max) * 100 : 0}%` }} />
              </div>
              <div className="u-sub">
                伤害 <b>{u.dmg}</b> · 命中 <b>{u.hits}</b>/{u.shots} ·{' '}
                <b>{u.shots ? Math.round((u.hits / u.shots) * 100) : 0}%</b>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function ResultOverlay({
  result,
  onExit,
  onExport,
  verify,
  replayFp,
  exitLabel,
}: {
  result: MatchResult;
  onExit: () => void;
  onExport: () => void;
  verify: boolean | null;
  exitLabel?: string;
  replayFp: string | null;
}) {
  const cls = result.draw ? 'win-draw' : result.winner === 'red' ? 'win-red' : 'win-blue';
  const title = result.draw ? '平 局' : result.winner === 'red' ? '红方胜利' : '蓝方胜利';
  return (
    <div className="result-overlay">
      <section className={`result-card tf-panel ${cls}`}>
        <div className="tf-title" style={{ color: 'var(--text-dim)' }}>
          MISSION COMPLETE
        </div>
        <div className="big">{title}</div>
        <div className="tf-hint" style={{ marginTop: 6 }}>
          {result.reason === 'kill'
            ? '判定：击毁对方全部坦克'
            : result.reason === 'timeout'
              ? '判定：限时结束 · 存活 > HP > 伤害'
              : '判定：失联'}
        </div>
        {verify !== null && (
          <div className={`verify-chip ${verify ? 'ok' : 'bad'}`}>
            {verify ? '✓ 与回放存档逐项一致（确定性指纹匹配）' : '✗ 指纹漂移：本局与回放存档不一致'}
            {replayFp && <span className="fp">{replayFp.slice(0, 12)}…</span>}
          </div>
        )}
        <div className="result-grid">
          {(['red', 'blue'] as Team[]).map((team) => {
            const tks = result.tankResults.filter((t) => t.team === team);
            const win = result.winner === team && !result.draw;
            const col = { red: { main: '#ff3b30' }, blue: { main: '#00e5ff' } }[team];
            const alive = tks.filter((t) => t.hp > 0).length;
            const sumDmg = tks.reduce((s, t) => s + t.damageDealt, 0);
            return (
              <div key={team} className={`team-card tf-panel ${team}`} style={{ padding: 12 }}>
                <div className="tc-head">
                  <span>{team === 'red' ? '◤ RED' : 'BLUE ◢'}</span>
                  <span style={{ color: result.draw ? 'var(--amber)' : win ? col.main : 'var(--text-dim)' }}>
                    {result.draw ? 'DRAW' : win ? 'WIN' : 'LOSE'}
                  </span>
                </div>
                {tks.length > 0 ? (
                  <>
                    <div className="tank-line">
                      <span className="k">存活 {alive}/{tks.length} · 团队总伤</span>
                      <b>{Math.round(sumDmg)}</b>
                    </div>
                    {tks.map((tk, idx) => (
                      <div key={idx} className={`res-unit${tk.hp <= 0 ? ' dead' : ''}`}>
                        <div className="u-head">
                          <span>{tk.name}</span>
                          <b>{tk.hp > 0 ? `HP ${Math.ceil(tk.hp)}` : '击毁'}</b>
                        </div>
                        <div className="u-sub">
                          伤 {Math.round(tk.damageDealt)} · 射 {tk.shotsFired} / 命中 {tk.hits}（
                          {Math.round(tk.accuracy * 100)}%）· 行驶 {Math.round(tk.distTravelled)}px
                        </div>
                      </div>
                    ))}
                  </>
                ) : (
                  <div className="tf-hint">无数据</div>
                )}
              </div>
            );
          })}
        </div>
        <div className="result-actions">
          <button className="btn" onClick={onExport}>
            💾 导出本局回放 (.tfreplay.json)
          </button>
          <button className="btn" onClick={onExit}>
            {exitLabel ?? '⇤ 返回布阵 · 调整策略再战'}
          </button>
        </div>
      </section>
    </div>
  );
}
