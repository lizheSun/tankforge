import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type BattleLaunchDto,
  type BattleOutcomeDto,
  type BattleRow,
  type LeaderRow,
  type RosterItem,
  type TankSpecDto,
  type TeamDto,
  type TournamentMeta,
  type WatchDto,
} from './api';
import { DEFAULT_CODE, type BattleSetupData, type BotId, type SideSetup } from './config';

interface TournamentDetail {
  tournament: TournamentMeta;
  roster: RosterItem[];
  battles: BattleRow[];
  teams: TeamDto[];
}

/** 服务端策略 → 本地引擎出阵配置（确定性：同 seed 同策略 = 同画面同结果） */
function specToSide(s: TankSpecDto, team: 'red' | 'blue'): SideSetup {
  return {
    team,
    kind: s.botId ? 'bot' : 'script',
    botId: (s.botId ?? 'rookie') as BotId,
    code: s.code ?? DEFAULT_CODE,
    buildIdx: 0,
    points: s.build,
    pack: null,
    name: s.name,
  };
}

/** 多对多出阵（1~5 v 1~5）：与本地对战同一套 BattleSetupData */
function launchSetup(dto: { seed: number; red: TankSpecDto[]; blue: TankSpecDto[] }): BattleSetupData {
  return {
    red: dto.red.map((s) => specToSide(s, 'red')),
    blue: dto.blue.map((s) => specToSide(s, 'blue')),
    mapId: 'crossroads',
    durationMs: 90_000,
    seed: dto.seed,
  };
}

/** 赛事中心：赛事主页 = 规则说明 + 报名/组队/挑战 + 实时排行榜（每次打开现算） */
export function Tournaments({ onLaunch }: { onLaunch: (setup: BattleSetupData) => void }) {
  const [list, setList] = useState<TournamentMeta[]>([]);
  const [cur, setCur] = useState<TournamentDetail | null>(null);
  const [board, setBoard] = useState<LeaderRow[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // 创建表单
  const [title, setTitle] = useState('');
  const [type, setType] = useState<'ladder' | 'battle-royale'>('ladder');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');

  // 报名
  const [regName, setRegName] = useState('');
  const [regSecret, setRegSecret] = useState('');

  // 组队
  const [teamName, setTeamName] = useState('');
  const [teamTank, setTeamTank] = useState('');
  const [teamSecret, setTeamSecret] = useState('');

  // 挑战：单挑（免密钥）
  const [myTank, setMyTank] = useState('');
  const [opponent, setOpponent] = useState('');
  // 挑战：队伍多对多（免密钥）
  const [redTeam, setRedTeam] = useState('');
  const [blueTeam, setBlueTeam] = useState('');
  const [duelMode, setDuelMode] = useState<'solo' | 'team'>('solo');

  const [result, setResult] = useState<BattleOutcomeDto | null>(null);
  const [brArmed, setBrArmed] = useState(false);

  const reloadList = useCallback(() => {
    api.get<{ tournaments: TournamentMeta[] }>('/tournaments').then((d) => setList(d.tournaments)).catch((e: Error) => setMsg({ ok: false, text: e.message }));
  }, []);

  /** 进入赛事主页：详情 + 实时排行榜（服务端每次现算，不落库） */
  const reloadDetail = useCallback((id: number) => {
    api.get<TournamentDetail>(`/tournaments/${id}`).then(setCur).catch((e: Error) => setMsg({ ok: false, text: e.message }));
    api.get<{ leaderboard: LeaderRow[] }>(`/tournaments/${id}/leaderboard`).then((d) => setBoard(d.leaderboard)).catch(() => setBoard([]));
  }, []);

  useEffect(() => {
    reloadList();
  }, [reloadList]);

  const create = async () => {
    try {
      await api.post('/tournaments', { title, type, startTime: startTime || null, endTime: endTime || null });
      setTitle('');
      setMsg({ ok: true, text: '赛事创建成功（已自动加入 3 个 NPC 坦克）' });
      reloadList();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  };

  const register = async () => {
    if (!cur) return;
    try {
      await api.post(`/tournaments/${cur.tournament.id}/register`, { tankName: regName, secret: regSecret });
      setMsg({ ok: true, text: `「${regName}」报名成功` });
      setRegName('');
      setRegSecret('');
      reloadDetail(cur.tournament.id);
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  };

  const createTeam = async () => {
    if (!cur) return;
    try {
      await api.post(`/tournaments/${cur.tournament.id}/teams`, { teamName, tankName: teamTank, secret: teamSecret });
      setMsg({ ok: true, text: `队伍「${teamName}」创建成功，${teamTank} 已入队` });
      setTeamName('');
      setTeamSecret('');
      reloadDetail(cur.tournament.id);
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  };

  const joinTeam = async (teamId: number) => {
    if (!cur) return;
    try {
      await api.post(`/tournaments/${cur.tournament.id}/teams/${teamId}/join`, { tankName: teamTank, secret: teamSecret });
      setMsg({ ok: true, text: `「${teamTank}」已加入队伍` });
      setTeamSecret('');
      reloadDetail(cur.tournament.id);
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  };

  const leaveTeam = async (teamId: number, member: string) => {
    if (!cur) return;
    // 退出队伍 = 凭该坦克自己的密钥（防冒名）：组队区先选中该坦克并填密钥
    if (member !== teamTank) {
      setMsg({ ok: false, text: `退出「${member}」需要它的密钥：在上方组队区把坦克切换为「${member}」并填密钥，再点 ×` });
      return;
    }
    try {
      await api.post(`/tournaments/${cur.tournament.id}/teams/${teamId}/leave`, {
        tankName: member,
        secret: teamSecret,
      });
      setMsg({ ok: true, text: `「${member}」已退出队伍` });
      setTeamSecret('');
      reloadDetail(cur.tournament.id);
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  };

  const battle = async () => {
    if (!cur) return;
    setBusy(true);
    setResult(null);
    try {
      const body =
        duelMode === 'team'
          ? { redTeam, blueTeam }
          : { myTank, opponent };
      const r = await api.post<BattleLaunchDto>(`/tournaments/${cur.tournament.id}/battle`, body);
      setResult(r);
      setMsg(null);
      reloadDetail(cur.tournament.id);
      if (!r.red?.length || !r.blue?.length) {
        setMsg({ ok: false, text: '后端版本过旧：请重启服务（npm run server）后重试' });
      } else {
        // 服务端已结算入库 → 前端用同一 seed + 双方策略重演出完整对战画面
        onLaunch(launchSetup(r));
      }
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  /** 观看历史对战：拉 seed + 双方策略，本地确定性重演 */
  const watch = async (b: BattleRow) => {
    if (!cur) return;
    try {
      const d = await api.get<WatchDto>(`/tournaments/${cur.tournament.id}/battle/${b.id}`);
      onLaunch(launchSetup(d));
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  };

  const brRun = async () => {
    if (!cur) return;
    // 两段式确认（WebView 不支持 confirm()）
    if (!brArmed) {
      setBrArmed(true);
      window.setTimeout(() => setBrArmed(false), 4000);
      return;
    }
    setBrArmed(false);
    setBusy(true);
    try {
      const r = await api.post<{ count: number }>(`/tournaments/${cur.tournament.id}/br-run`);
      setMsg({ ok: true, text: `混战完成：共 ${r.count} 场` });
      reloadDetail(cur.tournament.id);
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const nonNpc = cur?.roster.filter((r) => !r.is_npc) ?? [];
  const unteamed = cur
    ? nonNpc.filter((r) => !cur.teams.some((t) => t.members.includes(r.tank_name)))
    : [];
  const canSolo = duelMode === 'solo' && myTank && opponent && myTank !== opponent;
  const canTeam = duelMode === 'team' && redTeam && blueTeam && redTeam !== blueTeam;

  return (
    <div className="page">
      <div className="page-body">
        {msg && <div className={`banner ${msg.ok ? 'banner-ok' : 'banner-err'}`}>{msg.text}</div>}

        {cur ? (
          <>
            {/* ---------- 赛事主页头部 ---------- */}
            <section className="tf-panel page-card">
              <div className="card-head-row">
                <h2 className="tf-title">
                  🏟 {cur.tournament.title}
                  <span className="tag">{cur.tournament.type === 'ladder' ? '天梯赛' : '吃鸡赛'}</span>
                </h2>
                <button className="btn small" onClick={() => setCur(null)}>
                  ⇤ 返回列表
                </button>
              </div>
              <div className="tf-hint">
                {cur.tournament.start_time ? `开始 ${String(cur.tournament.start_time).slice(0, 16)}` : '不限时'}
                {cur.tournament.end_time ? ` · 截止 ${String(cur.tournament.end_time).slice(0, 16)}` : ''} · 报名{' '}
                {cur.roster.length} 车 · 队伍 {cur.teams.length} 支 · 已战 {cur.battles.length}+ 场
              </div>
              <div className="tourn-rules">
                <b>📌 赛事规则速览</b>
                <ol>
                  <li>
                    <b>报名</b>：凭坦克密钥把坦克挂进赛事（防冒名）——在坦克工坊创建坦克后前来报名。
                  </li>
                  <li>
                    <b>组队</b>：报名后凭密钥创建 / 加入队伍（每队 1~5 车，一车只能属一队）。想单挑可以不组队。
                  </li>
                  <li>
                    <b>挑战（免密钥）</b>：单挑直接选人；多对多选两支队伍开战（1~5 v 1~5，引擎真实团战：队友数据链 + 通信全部生效）。
                  </li>
                  <li>
                    <b>排名（实时）</b>：每次打开本页现算。<b>积分 = 胜×3 + 平×1 + 击杀×1 + 命中率×5</b>；同分依次比 胜场 →
                    击杀 → 命中率 → 场次少者优先。队伍战按队伍胜负记成绩：胜方每车各 +1 胜。
                  </li>
                </ol>
              </div>
            </section>

            <div className="tourn-cols">
              {/* 左列：报名 / 组队 / 挑战 */}
              <div className="tourn-col">
                <section className="tf-panel page-card">
                  <h3 className="sub-title">📥 报名（凭坦克密钥）</h3>
                  <div className="form-row">
                    <input className="tf-input" placeholder="坦克名称" value={regName} onChange={(e) => setRegName(e.target.value)} />
                    <input className="tf-input" type="password" placeholder="密钥" value={regSecret} onChange={(e) => setRegSecret(e.target.value)} />
                    <button className="btn" disabled={!regName || !regSecret} onClick={() => void register()}>
                      报名
                    </button>
                  </div>
                  <div className="roster-list">
                    {cur.roster.map((r) => (
                      <span key={r.tank_name} className={`roster-chip ${r.is_npc ? 'npc' : 'user'}`}>
                        {r.tank_name}
                        {r.is_npc && <span className="npc-tag">NPC</span>}
                      </span>
                    ))}
                  </div>
                </section>

                <section className="tf-panel page-card">
                  <h3 className="sub-title">🛡 组队（多对多出战用）</h3>
                  <div className="form-row">
                    <input className="tf-input" placeholder="队名" value={teamName} onChange={(e) => setTeamName(e.target.value)} />
                    <select className="tf-select" value={teamTank} onChange={(e) => setTeamTank(e.target.value)}>
                      <option value="">我的坦克…</option>
                      {nonNpc.map((r) => (
                        <option key={r.tank_name} value={r.tank_name}>
                          {r.tank_name}
                        </option>
                      ))}
                    </select>
                    <input className="tf-input" type="password" placeholder="密钥" value={teamSecret} onChange={(e) => setTeamSecret(e.target.value)} />
                    <button className="btn" disabled={!teamName || !teamTank || !teamSecret} onClick={() => void createTeam()}>
                      创建队伍
                    </button>
                  </div>
                  {cur.teams.length === 0 ? (
                    <p className="tf-hint">还没有队伍——创建第一支，或直接用下面的单挑模式</p>
                  ) : (
                    <div className="team-list">
                      {cur.teams.map((t) => (
                        <div key={t.id} className="team-card">
                          <div className="team-head">
                            <b>{t.name}</b>
                            <span className="tf-hint">{t.members.length} / 5 车</span>
                            <button
                              className="btn small"
                              disabled={!teamTank || teamTank === '' || t.members.includes(teamTank)}
                              title={`把「${teamTank || '选中的坦克'}」加入该队（需上方密钥）`}
                              onClick={() => void joinTeam(t.id)}
                            >
                              ➕ 加入
                            </button>
                          </div>
                          <div className="team-members">
                            {t.members.map((m) => (
                              <span key={m} className="roster-chip user">
                                {m}
                                <button className="chip-x" title={`退出（凭 ${m} 的密钥）`} onClick={() => void leaveTeam(t.id, m)}>
                                  ×
                                </button>
                              </span>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {unteamed.length > 0 && (
                    <p className="tf-hint">未组队坦克：{unteamed.map((r) => r.tank_name).join('、')}（单人可直接用单挑模式）</p>
                  )}
                </section>

                <section className="tf-panel page-card">
                  <h3 className="sub-title">⚔ 发起挑战（免密钥）</h3>
                  <div className="mode-tabs">
                    <button className={`btn small ${duelMode === 'solo' ? 'primary' : ''}`} onClick={() => setDuelMode('solo')}>
                      🤺 快速单挑 1v1
                    </button>
                    <button className={`btn small ${duelMode === 'team' ? 'primary' : ''}`} onClick={() => setDuelMode('team')}>
                      🛡 队伍团战 NvN
                    </button>
                  </div>
                  {duelMode === 'solo' ? (
                    <div className="form-row">
                      <select className="tf-select" value={myTank} onChange={(e) => setMyTank(e.target.value)}>
                        <option value="">我的坦克…</option>
                        {nonNpc.map((r) => (
                          <option key={r.tank_name}>{r.tank_name}</option>
                        ))}
                      </select>
                      <span className="tf-hint">vs</span>
                      <select className="tf-select" value={opponent} onChange={(e) => setOpponent(e.target.value)}>
                        <option value="">选择对手…</option>
                        {cur.roster.filter((r) => r.tank_name !== myTank).map((r) => (
                          <option key={r.tank_name} value={r.tank_name}>
                            {r.tank_name}
                            {r.is_npc ? '（NPC）' : ''}
                          </option>
                        ))}
                      </select>
                      <button className="btn primary" disabled={busy || !canSolo} onClick={() => void battle()}>
                        {busy ? '⚔ 交战中…' : '⚔ 开战'}
                      </button>
                    </div>
                  ) : (
                    <div className="form-row">
                      <select className="tf-select" value={redTeam} onChange={(e) => setRedTeam(e.target.value)}>
                        <option value="">我方队伍…</option>
                        {cur.teams.map((t) => (
                          <option key={t.id} value={t.name}>
                            {t.name}（{t.members.length} 车）
                          </option>
                        ))}
                      </select>
                      <span className="tf-hint">vs</span>
                      <select className="tf-select" value={blueTeam} onChange={(e) => setBlueTeam(e.target.value)}>
                        <option value="">对方队伍…</option>
                        {cur.teams.filter((t) => t.name !== redTeam).map((t) => (
                          <option key={t.id} value={t.name}>
                            {t.name}（{t.members.length} 车）
                          </option>
                        ))}
                      </select>
                      <button className="btn primary" disabled={busy || !canTeam} onClick={() => void battle()}>
                        {busy ? '⚔ 团战中…' : '⚔ 开战'}
                      </button>
                    </div>
                  )}
                  {cur.tournament.type === 'battle-royale' && (
                    <div className="btn-row">
                      <button
                        className={`btn ${brArmed ? 'primary' : 'danger'}`}
                        disabled={busy}
                        onClick={() => void brRun()}
                      >
                        {busy ? '💥 混战中…' : brArmed ? '⚠ 再点一次确认开战' : '💥 全员循环混战（吃鸡模式）'}
                      </button>
                    </div>
                  )}

                  {result && (
                    <div className="battle-result">
                      <div className={`br-title ${result.winner === 'red' ? 'win-red' : result.winner === 'blue' ? 'win-blue' : 'win-draw'}`}>
                        {result.winner === 'red' ? '🔴 红方胜' : result.winner === 'blue' ? '🔵 蓝方胜' : '平局'}
                        <span className="tf-hint">
                          {' '}· 判定：{result.reason === 'kill' ? '击毁' : result.reason === 'timeout' ? '超时裁定' : '失联/判负'} ·{' '}
                          {result.ticks} tick
                        </span>
                      </div>
                      <table className="rule-table">
                        <thead>
                          <tr>
                            <th>坦克</th>
                            <th>HP</th>
                            <th>射击</th>
                            <th>命中</th>
                            <th>命中率</th>
                            <th>伤害</th>
                            <th>击杀</th>
                          </tr>
                        </thead>
                        <tbody>
                          {result.tanks.map((t) => (
                            <tr key={t.name}>
                              <td>
                                <b>{t.name}</b>
                              </td>
                              <td>{t.alive ? t.hp : '击毁'}</td>
                              <td>{t.shots}</td>
                              <td>{t.hits}</td>
                              <td>{Math.round(t.accuracy * 100)}%</td>
                              <td>{t.dmg}</td>
                              <td>{t.kills}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>

                <section className="tf-panel page-card">
                  <h3 className="sub-title">📜 最近对战</h3>
                  <table className="rule-table">
                    <thead>
                      <tr>
                        <th>时间</th>
                        <th>对战</th>
                        <th>结果</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {cur.battles.map((b) => (
                        <tr key={b.id}>
                          <td>{String(b.created_at).slice(5, 16)}</td>
                          <td>
                            <span className="red-name">{b.red_name}</span> vs <span className="blue-name">{b.blue_name}</span>
                          </td>
                          <td>
                            {b.winner === 'red' ? `🔴 ${b.red_name}` : b.winner === 'blue' ? `🔵 ${b.blue_name}` : '平局'}（{b.reason}）
                          </td>
                          <td>
                            <button className="btn small" title="本地重演这场对战的完整画面" onClick={() => void watch(b)}>
                              ▶ 观看
                            </button>
                          </td>
                        </tr>
                      ))}
                      {cur.battles.length === 0 && (
                        <tr>
                          <td colSpan={4} className="tf-hint">
                            还没有对战记录
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </section>
              </div>

              {/* 右列：实时排行榜（核心板块） */}
              <div className="tourn-col">
                <section className="tf-panel page-card board-card">
                  <h2 className="tf-title">🏆 实时排行榜</h2>
                  <div className="tf-hint">
                    每次打开本页实时计算（不落库）· 积分 = 胜×3 + 平×1 + 击杀×1 + 命中率×5 · 队伍战按队记胜负
                  </div>
                  <table className="rule-table board-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>坦克</th>
                        <th>积分</th>
                        <th>场次</th>
                        <th>胜/平/负</th>
                        <th>击杀</th>
                        <th>命中率</th>
                      </tr>
                    </thead>
                    <tbody>
                      {board.map((r, i) => (
                        <tr key={r.name} className={i < 3 ? 'top3' : ''}>
                          <td>{i + 1}</td>
                          <td>
                            <b>{r.name}</b>
                            {r.npc && <span className="npc-tag">NPC</span>}
                          </td>
                          <td>
                            <b className="board-score">{r.score}</b>
                          </td>
                          <td>{r.battles}</td>
                          <td>
                            <b className="amber">{r.wins}</b>/{r.draws}/{r.losses}
                          </td>
                          <td>{r.kills}</td>
                          <td>{Math.round(r.accuracy * 100)}%</td>
                        </tr>
                      ))}
                      {board.length === 0 && (
                        <tr>
                          <td colSpan={7} className="tf-hint">
                            打一场就有排名
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </section>
              </div>
            </div>
          </>
        ) : (
          <>
            <section className="tf-panel page-card">
              <h2 className="tf-title">➤ 创建赛事</h2>
              <div className="form-row">
                <input className="tf-input" placeholder="赛事标题" value={title} onChange={(e) => setTitle(e.target.value)} />
                <select className="tf-select" value={type} onChange={(e) => setType(e.target.value as 'ladder' | 'battle-royale')}>
                  <option value="ladder">天梯赛（自由挑战 · 组队团战 · 实时排名）</option>
                  <option value="battle-royale">吃鸡赛（全员循环混战）</option>
                </select>
                <input className="tf-input" type="datetime-local" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
                <span className="tf-hint">至</span>
                <input className="tf-input" type="datetime-local" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
                <button className="btn primary" disabled={!title} onClick={() => void create()}>
                  创建
                </button>
              </div>
            </section>

            <section className="tf-panel page-card">
              <h2 className="tf-title">🏟 赛事列表</h2>
              {list.length === 0 ? (
                <p className="tf-hint">还没有赛事——上面创建第一个（会自动加入 3 个 NPC 坦克）</p>
              ) : (
                <table className="rule-table">
                  <thead>
                    <tr>
                      <th>标题</th>
                      <th>类型</th>
                      <th>时间</th>
                      <th>报名</th>
                      <th>场次</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((t) => (
                      <tr key={t.id}>
                        <td>
                          <b>{t.title}</b>
                        </td>
                        <td>{t.type === 'ladder' ? '天梯赛' : '吃鸡赛'}</td>
                        <td className="tf-hint">
                          {t.start_time ? String(t.start_time).slice(0, 10) : '不限'} ~ {t.end_time ? String(t.end_time).slice(0, 10) : '不限'}
                        </td>
                        <td>{t.roster_count}</td>
                        <td>{t.battle_count}</td>
                        <td>
                          <button className="btn small" onClick={() => { setCur(null); reloadDetail(t.id); }}>
                            进入
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
