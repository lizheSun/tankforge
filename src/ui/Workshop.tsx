import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type TankMeta, type TemplateDto } from './api';
import { BUILD_PRESETS, cpSpent, emptyBuild, resolveStats } from '../game/build';
import { DEFAULT_CODE } from './config';
import { CodeEditor } from './CodeEditor';
import { makeRandomModel, modelParams, validateModelJson, type ModelJson } from '../game/modelBrain';
import type { Diag } from '../sandbox/diagnose';
import type { BuildPoints } from '../game/types';

const CP_BUDGET = 12;

/** 能力点六边形雷达轴（0~1 归一化 + 展示值） */
const AXES: { label: string; max: string; val: (s: ReturnType<typeof resolveStats>) => number; text: (s: ReturnType<typeof resolveStats>) => string }[] = [
  { label: '生存', max: '190HP', val: (s) => s.hpMax / 190, text: (s) => `${s.hpMax}` },
  { label: '火力', max: '24', val: (s) => s.damage / 24, text: (s) => `${s.damage}` },
  { label: '射速', max: '560ms', val: (s) => (800 - s.fireIntervalMs) / 560, text: (s) => `${s.fireIntervalMs}ms` },
  { label: '机动', max: '满级', val: (s) => (s.moveSpeed / 200 + s.turnRate / 150) / 2, text: (s) => `${s.moveSpeed}速` },
  { label: '视野', max: '440', val: (s) => s.viewRadius / 440, text: (s) => `${s.viewRadius}` },
  { label: '弹速', max: '660', val: (s) => s.shellSpeed / 660, text: (s) => `${s.shellSpeed}` },
];

function HexRadar({ points }: { points: BuildPoints }) {
  const stats = useMemo(() => resolveStats(points), [points]);
  const base = useMemo(() => resolveStats(emptyBuild()), []);
  const W = 250;
  const H = 215;
  const cx = W / 2;
  const cy = H / 2 - 4;
  const R = 74;
  const N = AXES.length;
  const pt = (i: number, r: number): [number, number] => {
    const a = (-90 + (360 / N) * i) * (Math.PI / 180);
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
  };
  const poly = (vals: number[]): string =>
    vals.map((v, i) => pt(i, Math.max(0.04, Math.min(1, v)) * R).join(',')).join(' ');
  const cur = AXES.map((a) => a.val(stats));
  const bse = AXES.map((a) => a.val(base));
  return (
    <div className="radar-wrap">
      <svg width={W} height={H} className="hex-radar">
        {/* 网格环 + 轴线 */}
        {[1 / 3, 2 / 3, 1].map((f) => (
          <polygon key={f} points={poly(AXES.map(() => f))} className="grid-ring" />
        ))}
        {AXES.map((a, i) => {
          const [x, y] = pt(i, R);
          return <line key={a.label} x1={cx} y1={cy} x2={x} y2={y} className="axis-line" />;
        })}
        {/* 0CP 基线（灰色）与当前值（青色） */}
        <polygon points={poly(bse)} className="base-poly" />
        <polygon points={poly(cur)} className="cur-poly" />
        {cur.map((v, i) => {
          const [x, y] = pt(i, Math.max(0.04, Math.min(1, v)) * R);
          return <circle key={i} cx={x} cy={y} r={2.6} className="cur-dot" />;
        })}
        {/* 轴标签 + 实际值 */}
        {AXES.map((a, i) => {
          const [x, y] = pt(i, R + 17);
          const anchor = Math.abs(x - cx) < 6 ? 'middle' : x > cx ? 'start' : 'end';
          return (
            <g key={a.label}>
              <text x={x} y={y - 3} textAnchor={anchor} className="axis-label">
                {a.label}
              </text>
              <text x={x} y={y + 9} textAnchor={anchor} className="axis-val">
                {a.text(stats)}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="radar-legend">
        <span className="lg cur">● 当前 Build</span>
        <span className="lg base">● 0CP 基线</span>
      </div>
    </div>
  );
}

const MODULES: { key: keyof BuildPoints; label: string; max: number }[] = [
  { key: 'armor', label: '装甲（HP +15）', max: 6 },
  { key: 'engine', label: '引擎（移速 +20）', max: 4 },
  { key: 'tracks', label: '履带（转向 +20°）', max: 3 },
  { key: 'fireRate', label: '装填（−60ms）', max: 4 },
  { key: 'damage', label: '伤害（+3）', max: 4 },
  { key: 'turret', label: '炮塔（回转 +30°）', max: 3 },
  { key: 'shellSpeed', label: '弹速（+90）', max: 2 },
  { key: 'view', label: '视野（+40）', max: 3 },
  { key: 'comm', label: '战术（+1 通信）', max: 2 },
];

function BuildEditor({ points, onChange }: { points: BuildPoints; onChange: (p: BuildPoints) => void }) {
  const spent = cpSpent(points);
  const left = CP_BUDGET - spent;
  const set = (k: keyof BuildPoints, v: number) => onChange({ ...points, [k]: v } as BuildPoints);
  const setAim = (aim: 'none' | 'assist' | 'auto') =>
    onChange({ ...points, aimAssist: aim === 'assist', aimAuto: aim === 'auto' });
  const aim: 'none' | 'assist' | 'auto' = points.aimAuto ? 'auto' : points.aimAssist ? 'assist' : 'none';
  const stats = resolveStats(points);
  const dps = stats.damage / (stats.fireIntervalMs / 1000);
  return (
    <div className="build-editor">
      <div className="build-head">
        <span className={`cp-chip ${left < 0 ? 'over' : ''}`}>
          剩余能力点 <b>{left}</b> / {CP_BUDGET}
        </span>
        <span className="tf-hint">已用 {spent} CP</span>
        <div className="preset-chips">
          {BUILD_PRESETS.map((p, i) => (
            <button key={p.name} className="btn small" title={p.desc} onClick={() => onChange({ ...p.points })}>
              {p.name}
            </button>
          ))}
          <button className="btn small" onClick={() => onChange(emptyBuild())}>
            清零
          </button>
        </div>
      </div>
      <div className="build-body">
        <div className="mod-grid">
          {MODULES.map((m) => {
            const v = points[m.key] as number;
            const canUp = v < m.max && left >= 1;
            return (
              <div key={m.key} className="mod-row">
                <span className="mod-label">{m.label}</span>
                <span className="mod-ctl">
                  <button className="btn small" disabled={v <= 0} onClick={() => set(m.key, v - 1)}>
                    −
                  </button>
                  <b className="mod-val">{v}</b>
                  <span className="tf-hint">/{m.max}</span>
                  <button className="btn small" disabled={!canUp} onClick={() => set(m.key, v + 1)}>
                    ＋
                  </button>
                </span>
              </div>
            );
          })}
          <div className="mod-row aim-row">
            <span className="mod-label">瞄具</span>
            <span className="mod-ctl">
              {(
                [
                  ['none', '无'],
                  ['assist', '辅助 1CP'],
                  ['auto', '自动 3CP'],
                ] as ['none' | 'assist' | 'auto', string][]
              ).map(([k, label]) => (
                <button
                  key={k}
                  className={`btn small ${aim === k ? 'primary' : ''}`}
                  disabled={k !== 'none' && (k === 'assist' ? left < 1 : left < 3) && aim === 'none'}
                  onClick={() => setAim(k)}
                >
                  {label}
                </button>
              ))}
            </span>
          </div>
        </div>
        <HexRadar points={points} />
      </div>
      <div className="stat-line">
        HP <b>{stats.hpMax}</b> · 移速 <b>{stats.moveSpeed}</b> · 装填 <b>{stats.fireIntervalMs}ms</b> · DPS <b>{dps.toFixed(1)}</b> · 视野 <b>{stats.viewRadius}</b> · 瞄准 <b>{stats.aim.toUpperCase()}</b>
      </div>
    </div>
  );
}

/** 坦克工坊：模板联动 + 能力点六边形 + 策略代码，凭密钥更新 */
export function Workshop({ onOpenRules }: { onOpenRules?: () => void }) {
  const [name, setName] = useState('');
  const [secret, setSecret] = useState('');
  const [code, setCode] = useState(DEFAULT_CODE);
  const [points, setPoints] = useState<BuildPoints>(() => ({ ...BUILD_PRESETS[0].points }));
  const [tplName, setTplName] = useState('');
  const [tplDesc, setTplDesc] = useState('');
  const [templates, setTemplates] = useState<TemplateDto[]>([]);
  const [diag, setDiag] = useState<Diag | null>(null);
  const [tanks, setTanks] = useState<TankMeta[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // 编辑态
  const [editName, setEditName] = useState<string | null>(null);
  const [editSecret, setEditSecret] = useState('');
  const [editCode, setEditCode] = useState('');
  const [editPoints, setEditPoints] = useState<BuildPoints>(() => emptyBuild());
  const [editLoaded, setEditLoaded] = useState(false);

  // 策略类型：代码 / 模型（RL）
  const [mode, setMode] = useState<'code' | 'model'>('code');
  const [modelJson, setModelJson] = useState<ModelJson | null>(null);
  const [modelErr, setModelErr] = useState<string | null>(null);
  const modelFileRef = useRef<HTMLInputElement>(null);
  const onModelFile = async (f: File | undefined | null) => {
    if (!f) return;
    setModelErr(null);
    try {
      const parsed = JSON.parse(await f.text()) as unknown;
      const err = validateModelJson(parsed);
      if (err) {
        setModelErr(err);
        setModelJson(null);
        return;
      }
      setModelJson(parsed as ModelJson);
    } catch (e) {
      setModelErr(`JSON 解析失败：${(e as Error).message}`);
      setModelJson(null);
    }
  };

  // AI Prompt 复制（WebView 无剪贴板 API 时弹层手动复制）
  const [promptText, setPromptText] = useState<string | null>(null);
  const copyPrompt = async () => {
    try {
      const d = await api.get<{ prompt: string }>('/prompt');
      try {
        await navigator.clipboard.writeText(d.prompt);
        setMsg({ ok: true, text: '✓ AI Prompt 已复制到剪贴板——粘贴给任意大模型，把生成的代码粘回编辑器即可' });
      } catch {
        setPromptText(d.prompt);
      }
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  };

  const load = () => api.get<{ tanks: TankMeta[] }>('/tanks').then((d) => setTanks(d.tanks));
  useEffect(() => {
    load().catch((e: Error) => setMsg({ ok: false, text: e.message }));
    api
      .get<{ templates: TemplateDto[] }>('/templates')
      .then((d) => setTemplates(d.templates))
      .catch(() => undefined);
  }, []);

  /** 模板联动：切换模板 → 载入代码 + 推荐能力点 */
  const pickTemplate = (tname: string) => {
    setTplName(tname);
    const t = templates.find((x) => x.name === tname);
    if (!t) return;
    setTplDesc(t.description);
    const target = editName ? editCode : code;
    if (target !== t.code && target !== DEFAULT_CODE) {
      // 已有改动时提示会被覆盖（WebView 无 confirm，直接覆盖但在消息区说明）
      setMsg({ ok: true, text: `已载入模板「${t.name}」：策略代码与推荐能力点已同步替换` });
    } else {
      setMsg(null);
    }
    if (editName) setEditCode(t.code);
    else setCode(t.code);
    const build = t.build_json ?? (t.presetIdx !== undefined ? BUILD_PRESETS[t.presetIdx]?.points : null);
    const bp = build ? { ...build } : emptyBuild();
    if (editName) setEditPoints(bp);
    else setPoints(bp);
  };

  const create = async () => {
    try {
      if (mode === 'model' && !modelJson) {
        setMsg({ ok: false, text: '请先上传模型 .json 或生成随机示例模型' });
        return;
      }
      await api.post('/tanks', {
        name,
        secret,
        ...(mode === 'model' ? { modelJson } : { code }),
        buildJson: points,
      });
      setMsg({
        ok: true,
        text:
          mode === 'model'
            ? `模型坦克「${name}」创建成功！平台已把模型编译为确定性策略代码`
            : `坦克「${name}」创建成功！密钥请牢记（凭它更新策略）`,
      });
      setName('');
      setSecret('');
      await load();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  };

  const openEdit = (t: TankMeta) => {
    setEditName(t.name);
    setEditSecret('');
    setEditCode('');
    setEditPoints(emptyBuild());
    setEditLoaded(false);
    setTplName('');
    setMsg(null);
  };

  const loadEdit = async () => {
    if (!editName) return;
    try {
      const d = await api.get<{ tank: { name: string; code: string; buildJson: BuildPoints } }>(
        `/tanks/${encodeURIComponent(editName)}?secret=${encodeURIComponent(editSecret)}`,
      );
      setEditCode(d.tank.code || DEFAULT_CODE);
      setEditPoints(d.tank.buildJson ? { ...d.tank.buildJson } : emptyBuild());
      setEditLoaded(true);
      setMsg({ ok: true, text: `已载入「${editName}」的策略，可编辑后保存` });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  };

  const saveEdit = async () => {
    if (!editName || !editLoaded) return;
    try {
      await api.put(`/tanks/${encodeURIComponent(editName)}`, {
        secret: editSecret,
        code: editCode,
        buildJson: editPoints,
      });
      setMsg({ ok: true, text: `「${editName}」已更新` });
      setEditName(null);
      setEditLoaded(false);
      await load();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  };

  const curPoints = editName ? editPoints : points;
  const setCurPoints = editName ? setEditPoints : setPoints;

  return (
    <div className="page">
      <div className="page-body">
        <section className="tf-panel page-card">
          <h2 className="tf-title">{editName ? `✎ 编辑坦克 · ${editName}` : '🛠 创建新坦克'}</h2>
          {msg && <div className={`banner ${msg.ok ? 'banner-ok' : 'banner-err'}`}>{msg.text}</div>}
          <div className="form-row">
            <label className="field">
              坦克名称
              <input className="tf-input" value={editName ?? name} disabled={!!editName} maxLength={32} placeholder="如：钢铁直男-01" onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="field">
              {editName ? '密钥（先载入策略）' : '密钥（≥4 位，凭它更新策略）'}
              <input className="tf-input" type="password" value={editName ? editSecret : secret} placeholder={editName ? '输入密钥后点「载入策略」' : '牢记密钥'} onChange={(e) => (editName ? setEditSecret(e.target.value) : setSecret(e.target.value))} />
            </label>
            {!editName && (
              <div className="mode-tabs">
                <button
                  className={`btn small ${mode === 'code' ? 'primary' : ''}`}
                  onClick={() => setMode('code')}
                >
                  ⌨ 策略代码
                </button>
                <button
                  className={`btn small ${mode === 'model' ? 'primary' : ''}`}
                  onClick={() => setMode('model')}
                >
                  🧠 模型策略（RL）
                </button>
              </div>
            )}
          </div>

          {(mode === 'code' || editName) && (
            <>
              {!editName && (
                <div className="form-row">
                  <label className="field grow">
                    策略模板（联动下方代码与能力点）
                    <select className="tf-select" value={tplName} onChange={(e) => pickTemplate(e.target.value)}>
                      <option value="">— 从模板开始（或直接手写）—</option>
                      {templates.map((t) => (
                        <option key={t.name} value={t.name}>
                          {t.name} · {t.description}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
              {tplDesc && <p className="tf-hint tpl-desc">💡 {tplDesc}</p>}

              {!editName && (
                <div className="prompt-row">
                  <button className="btn" onClick={() => void copyPrompt()}>
                    📋 一键复制 AI 生成 Prompt
                  </button>
                  <span className="tf-hint">
                    粘贴给任意大模型 / Agent → 它会按游戏规则生成它认为最优的策略代码 → 粘回下方编辑器直接参战
                  </span>
                </div>
              )}
            </>
          )}

          {mode === 'model' && !editName && (
            <div className="model-panel">
              <div className="form-row">
                <button className="btn" onClick={() => modelFileRef.current?.click()}>
                  ⬆ 上传模型文件（tankforge-model .json）
                </button>
                <input
                  ref={modelFileRef}
                  type="file"
                  accept=".json,application/json"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    void onModelFile(e.target.files?.[0]);
                    e.target.value = '';
                  }}
                />
                <button
                  className="btn"
                  onClick={() => {
                    setModelJson(makeRandomModel([32, 32], Date.now() % 100000));
                    setModelErr(null);
                  }}
                >
                  🎲 生成随机示例模型（测试管线）
                </button>
                {modelJson && <span className="model-ok">✓ 已就绪</span>}
              </div>
              {modelErr && <div className="banner-err">模型校验失败：{modelErr}</div>}
              {modelJson && (
                <div className="model-summary">
                  <b>{modelJson.layers.length}</b> 层 MLP · 激活 <b>{modelJson.activation}</b> ·{' '}
                  <b>{modelParams(modelJson)}</b> 参数 · 输入 <b>{modelJson.version === 2 ? 24 : 20}</b> 维观测（v
                  {modelJson.version}
                  {modelJson.version === 2 ? '，带目击记忆' : '，无记忆'}） / 输出 <b>18</b> 个动作（argmax）·
                  炮塔由平台辅助瞄准（带提前量），模型专注走位与开火时机
                </div>
              )}
              <div className="model-guide">
                <b>🧠 怎么训练自己的模型？</b>四条路径任选：
                <ol>
                  <li>
                    <b>零门槛进化</b>（不用 Python）：<code>npm run evolve 100 16</code> → 产物{' '}
                    <code>best-model.json</code> 直接上传
                  </li>
                  <li>
                    <b>PPO 认真训</b>：<code>python3 scripts/rl/train_ppo.py --steps 2000000 --envs 8 --opponent veteran</code>
                  </li>
                  <li>
                    <b>自我进化联赛</b>：先打赢 master，再逐轮打「上一轮的自己」——
                    <code>python3 scripts/rl/selfplay.py --rounds 10</code>
                  </li>
                  <li>
                    <b>已有 SB3 模型</b>：<code>python3 scripts/rl/export_sb3.py 你的模型.zip -o my-tank.json</code>
                  </li>
                </ol>
                {onOpenRules && (
                  <button className="btn small" onClick={onOpenRules}>
                    📖 查看完整训练攻略（游戏规则 · RL 模型训练章节）
                  </button>
                )}
              </div>
              <p className="tf-hint">
                模型格式：tankforge-model（v1 = 20 维无记忆，历史兼容；v2 = 24 维带目击记忆——敌不可见时观测仍指向上次目击点，可导航搜索）。
                训练在<b>真实引擎</b>上进行（所见即所得），上传后编译为确定性策略代码参战，与脚本坦克同规则结算。
              </p>
            </div>
          )}

          {promptText !== null && (
            <div className="modal-overlay" onClick={() => setPromptText(null)}>
              <div className="modal-card tf-panel" onClick={(e) => e.stopPropagation()}>
                <h3 className="tf-title">📋 标准策略生成 Prompt（点击文本全选后手动复制）</h3>
                <textarea
                  className="prompt-box"
                  readOnly
                  value={promptText}
                  onFocus={(e) => e.currentTarget.select()}
                />
                <div className="btn-row">
                  <button
                    className="btn primary"
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(promptText)
                        .then(() => {
                          setMsg({ ok: true, text: '✓ 已复制到剪贴板' });
                          setPromptText(null);
                        })
                        .catch(() => undefined);
                    }}
                  >
                    再次尝试复制
                  </button>
                  <button className="btn" onClick={() => setPromptText(null)}>
                    关闭
                  </button>
                </div>
              </div>
            </div>
          )}


          <BuildEditor points={curPoints} onChange={setCurPoints} />

          {(mode === 'code' || editName) && (
            <>
              <div className="editor-wrap">
                <CodeEditor
                  key={editName ?? 'create'}
                  value={editName ? (editLoaded ? editCode : DEFAULT_CODE) : code}
                  onChange={editName ? setEditCode : setCode}
                  onDiag={setDiag}
                />
              </div>
              <div className="editor-toolbar">
                <span className="tf-hint">
                  {editName
                    ? editLoaded
                      ? `正在编辑「${editName}」的策略，改完点「保存修改」`
                      : '先输入密钥并点「载入策略」'
                    : '策略入口：function decide(ctx) 返回 Action[]（写法见「游戏规则」）'}
                </span>
                <span className="diag-line">
                  {diag && !diag.ok ? (
                    <span className="bad">✗ {diag.message}</span>
                  ) : (
                    <span className="ok">✓ 语法通过</span>
                  )}
                </span>
              </div>
            </>
          )}
          {editName ? (
            <div className="btn-row">
              {editLoaded ? (
                <button className="btn primary" onClick={() => void saveEdit()}>
                  💾 保存修改
                </button>
              ) : (
                <button className="btn primary" disabled={!editSecret} onClick={() => void loadEdit()}>
                  🔍 载入策略
                </button>
              )}
              <button className="btn" onClick={() => { setEditName(null); setEditLoaded(false); }}>
                取消
              </button>
            </div>
          ) : (
            <div className="btn-row">
              <button className="btn primary" onClick={() => void create()}>
                ➤ 创建坦克
              </button>
            </div>
          )}
        </section>

        <section className="tf-panel page-card">
          <h2 className="tf-title">🏬 已注册坦克（{tanks.length}）</h2>
          {tanks.length === 0 ? (
            <p className="tf-hint">还没有坦克——上面创建第一辆吧</p>
          ) : (
            <table className="rule-table">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>创建时间</th>
                  <th>最近更新</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {tanks.map((t) => (
                  <tr key={t.name}>
                    <td>
                      <b>{t.name}</b>
                    </td>
                    <td>{String(t.created_at).slice(0, 19)}</td>
                    <td>{String(t.updated_at).slice(0, 19)}</td>
                    <td>
                      <button className="btn small" onClick={() => openEdit(t)}>
                        ✎ 编辑
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}
