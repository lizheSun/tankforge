import { useMemo, useRef, useState } from 'react';
import {
  BUILD_PRESETS,
  BUILTIN_BOT_BY_ID,
  DEFAULT_CODE,
  packToSide,
  sideBuild,
  sideFromReplay,
  sideStats,
  type BattleSetupData,
  type BotId,
  type SideSetup,
} from './config';
import { CodeEditor } from './CodeEditor';
import type { Diag } from '../sandbox/diagnose';
import {
  buildPackZip,
  downloadBytes,
  makeTemplatePack,
  parseStrategyPackZip,
  type StrategyPack,
} from '../pack/strategy';
import { MAP_IDS, buildMap } from '../game/map';
import type { Team } from '../game/types';
import { parseReplayJson, type ReplayFile, type ReplaySideRecord } from '../replay/replay';

export interface Props {
  onStart: (data: BattleSetupData) => void;
  onReplay: (data: BattleSetupData, replay: ReplayFile) => void;
}

const DURATIONS = [
  { label: '60s', value: 60_000 },
  { label: '120s', value: 120_000 },
  { label: '180s', value: 180_000 },
];

const SIZE_OPTS = [
  { n: 1, label: '1v1' },
  { n: 2, label: '2v2' },
  { n: 3, label: '3v3' },
  { n: 4, label: '4v4' },
  { n: 5, label: '5v5' },
];

const KIND_LABEL: Record<SideSetup['kind'], string> = {
  bot: '内置策略（规则）',
  script: '⤴ 自定义代码',
  pack: '📦 策略包（.zip）',
};

function StatMini({ s }: { s: SideSetup }) {
  const st = useMemo(() => sideStats(s), [s]);
  const dps = st.damage / (st.fireIntervalMs / 1000);
  return (
    <div className="stat-mini">
      <span>HP <b>{st.hpMax}</b></span>
      <span>移速 <b>{st.moveSpeed}</b></span>
      <span>DPS <b>{dps.toFixed(1)}</b></span>
      <span>视野 <b>{st.viewRadius}</b></span>
      <span>瞄准 <b>{st.aim.toUpperCase()}</b></span>
    </div>
  );
}

function SideConsole({
  side,
  onChange,
  diag,
  onDiag,
}: {
  side: SideSetup;
  onChange: (s: SideSetup) => void;
  diag: Diag | null;
  onDiag: (d: Diag | null) => void;
}) {
  const isRed = side.team === 'red';
  const build = sideBuild(side);
  const fileRef = useRef<HTMLInputElement>(null);
  const [packErr, setPackErr] = useState<string[]>([]);
  const [packLoaded, setPackLoaded] = useState<StrategyPack | null>(null);

  const switchKind = (kind: SideSetup['kind'], botId?: BotId) => {
    setPackErr([]);
    setPackLoaded(null);
    if (kind === 'bot' && botId) {
      const defIdx = BUILTIN_BOT_BY_ID(botId).defaultBuild;
      onChange({ ...side, kind, botId, buildIdx: defIdx, points: null, pack: null });
      return;
    }
    if (kind === 'script') {
      onChange({ ...side, kind, points: null, pack: null, buildIdx: side.buildIdx < 0 ? 0 : side.buildIdx });
      return;
    }
    onChange({ ...side, kind: 'pack' });
  };

  const onPickFile = async (f: File | undefined | null) => {
    if (!f) return;
    const buf = await f.arrayBuffer();
    const res = parseStrategyPackZip(buf, f.name);
    setPackErr(res.errors);
    if (!res.pack) return;
    const p = res.pack;
    setPackLoaded(p);
    const meta = {
      fileName: p.fileName,
      name: p.name,
      version: p.version,
      author: p.author,
      desc: p.desc,
      brainFile: p.brainFile,
      cp: p.cp,
    };
    onChange(packToSide(side.team, p.name, p.code, p.points, meta));
    onDiag({ ok: true, message: `策略包载入成功：${p.name} v${p.version} · brain@${p.brainFile}` });
  };

  const kindValue = side.kind === 'bot' ? `bot:${side.botId}` : side.kind;
  const isScriptOrPack = side.kind === 'script' || side.kind === 'pack';

  return (
    <section className={`side-console tf-panel ${isRed ? 'red' : 'blue'}`}>
      <header className="head">
        <span className="team-chip">{isRed ? '◤ 红方 · RED' : '蓝方 · BLUE ◢'}</span>
        <span className="side-idx">{isRed ? '战略舱 A' : '战略舱 B'}</span>
      </header>

      <div className="field">
        <label>坦克大脑（决策策略）</label>
        <select
          className="tf-select"
          value={kindValue}
          onChange={(e) => {
            const v = e.target.value;
            if (v === 'script') switchKind('script');
            else if (v === 'pack') switchKind('pack');
            else switchKind('bot', v.replace('bot:', '') as BotId);
          }}
        >
          <optgroup label="内置策略（规则）">
            {['rookie', 'veteran', 'master'].map((id) => {
              const b = BUILTIN_BOT_BY_ID(id as BotId);
              return (
                <option key={id} value={`bot:${id}`}>
                  {b.name} · {b.tag} — {b.desc}
                </option>
              );
            })}
          </optgroup>
          <option value="script">⤴ 自定义代码（在线编辑）</option>
          <option value="pack">📦 策略包（上传 manifest+brain+build 的 zip）</option>
        </select>
      </div>
      {side.kind === 'bot' && (
        <div className="tf-hint">
          {BUILTIN_BOT_BY_ID(side.botId).name}：{BUILTIN_BOT_BY_ID(side.botId).desc} · 瞄准档位{' '}
          {BUILTIN_BOT_BY_ID(side.botId).tag}
        </div>
      )}

      {side.kind === 'pack' && (
        <div className="pack-zone">
          <div className="pack-zone-head">
            <div className="field" style={{ margin: 0 }}>
              <label>上传策略包</label>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn small primary" onClick={() => fileRef.current?.click()}>
                  {side.pack ? '⟳ 更换 .zip' : '⇪ 选择 .zip 文件'}
                </button>
                <button
                  className="btn small"
                  onClick={() => {
                    const p = makeTemplatePack();
                    downloadBytes(buildPackZip(p), p.fileName);
                  }}
                >
                  ⬇ 下载官方模板
                </button>
              </div>
              <input
                ref={fileRef}
                type="file"
                accept=".zip,application/zip"
                style={{ display: 'none' }}
                onChange={(e) => {
                  void onPickFile(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
              <div className="tf-hint">
                结构：manifest.json(名称/版本/brain 入口/build 能力点) + brain/main.js
              </div>
            </div>
          </div>
          {packErr.length > 0 && (
            <div className="diag-err">
              {packErr.map((m, i) => (
                <div key={i}>✗ {m}</div>
              ))}
            </div>
          )}
          {side.pack && (
            <div className="pack-meta">
              <div className="pm-line">
                <span>{side.pack.name}</span>
                <span className="pm-ver">v{side.pack.version}</span>
                {side.pack.author && <span className="pm-auth">by {side.pack.author}</span>}
              </div>
              <div className="pm-desc">{side.pack.desc || '（无描述）'}</div>
            </div>
          )}
          {!side.pack && packErr.length === 0 && !packLoaded && (
            <div className="pack-empty">
              <div className="pack-ico">ZIP</div>
              <div>尚未载入策略包 —— 上传后本侧将以其 manifest / brain / build 参战</div>
            </div>
          )}
        </div>
      )}

      {side.kind !== 'pack' && (
        <div className="field">
          <label>属性 Build（能力点配置）</label>
          <select
            className="tf-select"
            value={side.buildIdx}
            onChange={(e) => onChange({ ...side, buildIdx: +e.target.value })}
          >
            {BUILD_PRESETS.map((p, i) => (
              <option key={p.name} value={i}>
                {p.name} — {p.desc}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="build-desc">
        {build.name} · {build.cp}/12 CP
        {side.kind === 'pack' && '（随包自带，编辑器只读）'}
      </div>
      <StatMini s={side} />

      {side.kind === 'script' && (
        <>
          <div className="field" style={{ marginBottom: 2 }}>
            <label>决策代码 decide(ctx) → Action[]</label>
          </div>
          <div className="editor-wrap">
            <CodeEditor value={side.code} onChange={(v) => onChange({ ...side, code: v })} onDiag={(d) => onDiag(d)} />
          </div>
          <div className="editor-toolbar">
            <button className="btn small" onClick={() => onChange({ ...side, code: DEFAULT_CODE })}>
              载入官方示例
            </button>
            <span className="diag-line">
              {diag ? (
                diag.ok ? (
                  <span className="ok">✓ {diag.message}</span>
                ) : (
                  <span className="bad">✗ {diag.message}</span>
                )
              ) : (
                <span className="muted">· 输入即诊断 ·</span>
              )}
            </span>
          </div>
        </>
      )}

      {side.kind === 'pack' && side.pack && side.code && (
        <>
          <div className="field" style={{ marginBottom: 2 }}>
            <label>brain 源码 @ {side.pack.brainFile}</label>
            <span className="tf-hint" style={{ marginLeft: 6 }}>
              （只读 · 编辑请先下载模板）
            </span>
          </div>
          <div className="editor-wrap">
            <CodeEditor value={side.code} readOnly />
          </div>
        </>
      )}

      <div className="tf-hint" style={{ marginTop: 6 }}>
        来源：{KIND_LABEL[side.kind]}
        {isScriptOrPack && side.code ? ` · 代码 ${side.code.length}B` : ''}
      </div>
    </section>
  );
}

export function Setup({ onStart, onReplay }: Props) {
  const [red, setRed] = useState<SideSetup>(() => packFromBot('red', 'master', 4));
  const [blue, setBlue] = useState<SideSetup>(() => packFromBot('blue', 'veteran', 3));
  const [size, setSize] = useState(1); // 1v1 | 2v2 ~ 5v5
  const [mix, setMix] = useState({ red: false, blue: false }); // 编队：全基准 / bot 混编
  const [mapId, setMapId] = useState('crossroads');
  const [durationMs, setDuration] = useState(180_000);
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 1e9));
  const replayRef = useRef<HTMLInputElement>(null);
  const [replayErr, setReplayErr] = useState<string[]>([]);
  const [startErr, setStartErr] = useState<string[]>([]);
  const [diag, setDiag] = useState<Record<string, Diag | null>>({});

  const setMixTeam = (team: 'red' | 'blue', v: boolean) =>
    setMix((m) => ({ ...m, [team]: v }));
  const redRoster = useMemo(() => lineupSide('red', red, size, mix.red), [red, size, mix.red]);
  const blueRoster = useMemo(() => lineupSide('blue', blue, size, mix.blue), [blue, size, mix.blue]);
  const sizeLabel = size === 1 ? '1v1' : `${size}v${size}`;

  const mapInfo = useMemo(() => buildMap(mapId), [mapId]);
  const setSide = (s: SideSetup) => (s.team === 'red' ? setRed(s) : setBlue(s));
  const setDiagSide = (team: string) => (d: Diag | null) => setDiag((m) => ({ ...m, [team]: d }));

  const onLoadReplay = async (f: File | undefined | null) => {
    setReplayErr([]);
    if (!f) return;
    const text = await f.text();
    const r = parseReplayJson(text);
    if (!r.replay) {
      setReplayErr(r.errors);
      return;
    }
    const rep = r.replay;
    const redRaw: unknown = rep.setup.red;
    const blueRaw: unknown = rep.setup.blue;
    const redList = (Array.isArray(redRaw) ? redRaw : [redRaw]) as ReplaySideRecord[];
    const blueList = (Array.isArray(blueRaw) ? blueRaw : [blueRaw]) as ReplaySideRecord[];
    const data: BattleSetupData = {
      mapId: rep.setup.mapId,
      seed: rep.setup.seed,
      durationMs: rep.setup.durationMs,
      red: redList.map((s) => sideFromReplay(s, 'red')),
      blue: blueList.map((s) => sideFromReplay(s, 'blue')),
    };
    onReplay(data, rep);
  };

  return (
    <div className="setup">
      <div className="tf-bg" />
      <header className="setup-head">
        <span className="tf-hint">M3 · 团战引擎 · 编队 · 策略包 · 回放 · 本地对战免配置</span>
        <div className="quick-row">
          <button
            className="btn small"
            title="下载官方 zip 模板：manifest+brain/build，可离线编写后重新上传"
            onClick={() => {
              const p = makeTemplatePack({ author: '玩家' });
              downloadBytes(buildPackZip(p), p.fileName);
            }}
          >
            ⬇ 策略包模板
          </button>
          <button className="btn small" onClick={() => replayRef.current?.click()}>
            🎞 载入回放 (.json)
          </button>
          <input
            ref={replayRef}
            type="file"
            accept=".json,application/json"
            style={{ display: 'none' }}
            onChange={(e) => {
              void onLoadReplay(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </div>
      </header>
      {replayErr.length > 0 && (
        <div className="banner-err">
          {replayErr.map((m, i) => (
            <span key={i}>
              ✗ {m}　
            </span>
          ))}
        </div>
      )}
      {startErr.length > 0 && (
        <div className="banner-err">
          {startErr.map((m, i) => (
            <span key={i}>
              ✗ {m}　
            </span>
          ))}
        </div>
      )}

      <div className="setup-body">
        <section className="seg-row">
          <span className="seg-title">战斗规模</span>
          {SIZE_OPTS.map((o) => (
            <button
              key={o.n}
              className="btn small"
              style={size === o.n ? { borderColor: 'var(--amber)', color: 'var(--amber)' } : undefined}
              onClick={() => setSize(o.n)}
            >
              {o.label}
            </button>
          ))}
          <span className="tf-hint">
            {sizeLabel} · 每车独立驾驶员实例{size > 1 ? '（团战：两方各在己方半场对称布阵）' : ''}
          </span>
        </section>

        <div className="versus-row">
          <div className="versus-col">
            <SideConsole side={red} onChange={setSide} diag={diag.red ?? null} onDiag={setDiagSide('red')} />
            <div className="mix-row">
              <span className="tf-hint">红方编队 · {redRoster.length} 车</span>
              <button
                className="btn small"
                style={!mix.red ? { borderColor: 'var(--red)' } : undefined}
                onClick={() => setMixTeam('red', false)}
              >
                ◤ 全员同基准
              </button>
              <button
                className="btn small"
                disabled={red.kind !== 'bot'}
                title={red.kind !== 'bot' ? '非内置策略只能全员挂载同基准' : 'MASTER/VETERAN/ROOKIE 依次挂载'}
                style={mix.red ? { borderColor: 'var(--red)' } : undefined}
                onClick={() => setMixTeam('red', true)}
              >
                ⚙ bot 混编
              </button>
            </div>
          </div>
          <div className="vs-badge">VS</div>
          <div className="versus-col">
            <SideConsole side={blue} onChange={setSide} diag={diag.blue ?? null} onDiag={setDiagSide('blue')} />
            <div className="mix-row">
              <span className="tf-hint">蓝方编队 · {blueRoster.length} 车</span>
              <button
                className="btn small"
                style={!mix.blue ? { borderColor: 'var(--cyan)' } : undefined}
                onClick={() => setMixTeam('blue', false)}
              >
                全员同基准 ◢
              </button>
              <button
                className="btn small"
                disabled={blue.kind !== 'bot'}
                style={mix.blue ? { borderColor: 'var(--cyan)' } : undefined}
                onClick={() => setMixTeam('blue', true)}
              >
                ⚙ bot 混编
              </button>
            </div>
          </div>
        </div>

        <section className="meta-row">
          <div className="field">
            <label>战场地图</label>
            <select className="tf-select" value={mapId} onChange={(e) => setMapId(e.target.value)}>
              {MAP_IDS.map((id) => {
                const m = buildMap(id);
                return (
                  <option key={id} value={id}>
                    {m.name} · {m.desc}
                  </option>
                );
              })}
            </select>
            <div className="tf-hint">
              {mapInfo.name} · {mapInfo.wTiles}×{mapInfo.hTiles} 瓦片 / 1200×800
            </div>
          </div>
          <div className="field">
            <label>单局时长上限</label>
            <select className="tf-select" value={durationMs} onChange={(e) => setDuration(+e.target.value)}>
              {DURATIONS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}（超时按存活/HP/伤害裁定）
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>对局种子（同种子 → 完全复现）</label>
            <input
              className="tf-input"
              value={seed}
              onChange={(e) => setSeed(Number(e.target.value) || 0)}
            />
          </div>
          <div className="field">
            <label>快速操作</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn small" onClick={() => setSeed(Math.floor(Math.random() * 1e9))}>
                ⟳ 随机种子
              </button>
              <button className="btn small" onClick={() => setMapId(MAP_IDS[0])}>
                重置地图
              </button>
            </div>
          </div>
        </section>

        <div className="deploy-row">
          <span className="tf-hint">
            红方：{rosterSummary(redRoster)} · 蓝方：{rosterSummary(blueRoster)} —— 双方全程 AI 自动交战 · {sizeLabel}
          </span>
          <button
            className="btn primary"
            onClick={() => {
              const errs: string[] = [];
              if (red.kind === 'pack' && !red.pack) errs.push('红方选择了策略包但未上传 .zip 文件');
              if (blue.kind === 'pack' && !blue.pack) errs.push('蓝方选择了策略包但未上传 .zip 文件');
              if (errs.length) {
                setStartErr(errs);
                return;
              }
              setStartErr([]);
              onStart({ red: redRoster, blue: blueRoster, mapId, durationMs, seed });
            }}
          >
            ⚔ 部署并开战
          </button>
        </div>
      </div>
    </div>
  );
}

function packFromBot(team: Team, botId: BotId, buildIdx: number): SideSetup {
  return {
    team,
    kind: 'bot',
    botId,
    code: DEFAULT_CODE,
    buildIdx,
    points: null,
    pack: null,
  };
}

/** 编队展开：variant(仅内置策略) = MASTER/VETERAN/ROOKIE 轮换挂载；否则全员克隆基准（每车独立实例） */
function lineupSide(team: Team, base: SideSetup, n: number, variant: boolean): SideSetup[] {
  const list: SideSetup[] = [];
  const seq: BotId[] = ['master', 'veteran', 'rookie'];
  for (let i = 0; i < n; i++) {
    if (variant && base.kind === 'bot') {
      const start = Math.max(0, seq.indexOf(base.botId));
      const b = seq[(start + i) % seq.length];
      list.push(packFromBot(team, b, BUILTIN_BOT_BY_ID(b).defaultBuild));
    } else {
      list.push({ ...base, team });
    }
  }
  return list;
}

function sideDriverLabel(s: SideSetup): string {
  if (s.kind === 'bot') return BUILTIN_BOT_BY_ID(s.botId).name;
  if (s.kind === 'pack') return s.pack ? `${s.pack.name} v${s.pack.version}` : '未载入策略包';
  return '自定义脚本';
}

/** 汇总名（去重计数），如 MASTER×2 + VETERAN */
function rosterSummary(list: SideSetup[]): string {
  const counts = new Map<string, number>();
  for (const s of list) {
    const k = sideDriverLabel(s);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()].map(([k, c]) => (c > 1 ? `${k}×${c}` : k)).join(' + ');
}
