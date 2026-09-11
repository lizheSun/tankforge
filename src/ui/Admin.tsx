import { useCallback, useEffect, useState } from 'react';
import { api, type DbConfigDto } from './api';

type Tab = 'ds' | 'browse' | 'sql';

const EMPTY: DbConfigDto = { host: '127.0.0.1', port: 3306, user: 'root', password: '', database: 'tankforge' };

/** 系统管理（非用户配置）：MySQL 数据源 / 数据浏览 / SQL 控制台 */
export function Admin() {
  const [tab, setTab] = useState<Tab>('ds');
  const [cfg, setCfg] = useState<DbConfigDto>(EMPTY);
  const [status, setStatus] = useState<{ configured: boolean } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // 数据浏览
  const [tables, setTables] = useState<string[]>([]);
  const [table, setTable] = useState('');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [total, setTotal] = useState(0);

  // SQL 控制台
  const [sql, setSql] = useState('SELECT * FROM tf_tanks ORDER BY created_at DESC LIMIT 20');
  const [sqlRows, setSqlRows] = useState<Record<string, unknown>[] | null>(null);

  useEffect(() => {
    api
      .get<{ configured: boolean; config: DbConfigDto | null }>('/admin/db')
      .then((d) => {
        setStatus({ configured: d.configured });
        if (d.config) setCfg({ ...d.config, password: '' });
      })
      .catch((e: Error) => setMsg({ ok: false, text: e.message }));
  }, []);

  const loadTables = useCallback(async () => {
    try {
      const d = await api.get<{ tables: string[] }>('/admin/db/tables');
      setTables(d.tables);
      return d.tables;
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
      return [];
    }
  }, []);

  const loadRows = useCallback(async (t: string, p: number) => {
    if (!t) return;
    try {
      const d = await api.get<{ rows: Record<string, unknown>[]; total: number }>(
        `/admin/db/data?table=${encodeURIComponent(t)}&page=${p}`,
      );
      setRows(d.rows);
      setTotal(d.total);
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }, []);

  const save = async (testOnly: boolean) => {
    setBusy(true);
    setMsg(null);
    try {
      if (testOnly) {
        await api.post('/admin/db/test', cfg);
        setMsg({ ok: true, text: '✓ 连接成功' });
      } else {
        await api.post('/admin/db/config', cfg);
        setMsg({ ok: true, text: '✓ 已保存数据源配置' });
        const d = await api.get<{ configured: boolean }>('/admin/db');
        setStatus(d);
      }
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const init = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const d = await api.post<{ tables: string[] }>('/admin/db/init');
      setMsg({ ok: true, text: `✓ 建表完成：${d.tables.join('、')}` });
      setTables(d.tables);
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const runSql = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const d = await api.post<{ rows: Record<string, unknown>[] }>('/admin/db/query', { sql });
      setSqlRows(d.rows);
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const cols = (rs: Record<string, unknown>[]): string[] => (rs[0] ? Object.keys(rs[0]) : []);

  return (
    <div className="page">
      <div className="page-body">
        <section className="tf-panel page-card">
          <div className="card-head-row">
            <h2 className="tf-title">⚙ 系统管理</h2>
            <div className="tab-row">
              {(
                [
                  ['ds', '数据源'],
                  ['browse', '数据浏览'],
                  ['sql', 'SQL 控制台'],
                ] as [Tab, string][]
              ).map(([id, label]) => (
                <button key={id} className={`btn small ${tab === id ? 'primary' : ''}`} onClick={() => setTab(id)}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          {msg && <div className={`banner ${msg.ok ? 'banner-ok' : 'banner-err'}`}>{msg.text}</div>}

          {tab === 'ds' && (
            <>
              <p className="tf-hint">
                系统级配置（非玩家配置）：连接信息保存在服务端 server/data/dbconfig.json，密码仅存服务端。
                <b>{status?.configured ? ' · 已配置' : ' · 未配置'}</b>
              </p>
              <div className="form-row">
                <label className="field">
                  主机
                  <input className="tf-input" value={cfg.host} onChange={(e) => setCfg({ ...cfg, host: e.target.value })} />
                </label>
                <label className="field">
                  端口
                  <input className="tf-input" type="number" value={cfg.port} onChange={(e) => setCfg({ ...cfg, port: +e.target.value })} />
                </label>
                <label className="field">
                  用户名
                  <input className="tf-input" value={cfg.user} onChange={(e) => setCfg({ ...cfg, user: e.target.value })} />
                </label>
                <label className="field">
                  密码
                  <input className="tf-input" type="password" value={cfg.password} placeholder="留空 = 不修改" onChange={(e) => setCfg({ ...cfg, password: e.target.value })} />
                </label>
                <label className="field">
                  数据库
                  <input className="tf-input" value={cfg.database} onChange={(e) => setCfg({ ...cfg, database: e.target.value })} />
                </label>
              </div>
              <div className="btn-row">
                <button className="btn" disabled={busy} onClick={() => void save(true)}>
                  🔌 测试连接
                </button>
                <button className="btn primary" disabled={busy} onClick={() => void save(false)}>
                  💾 保存配置
                </button>
                <button className="btn danger" disabled={busy} onClick={() => void init()}>
                  🏗 初始化建表（幂等）
                </button>
              </div>
            </>
          )}

          {tab === 'browse' && (
            <>
              <div className="form-row">
                <select
                  className="tf-select"
                  value={table}
                  onChange={(e) => {
                    setTable(e.target.value);
                    setPage(1);
                    void loadRows(e.target.value, 1);
                  }}
                >
                  <option value="">选择表…</option>
                  {tables.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
                <button
                  className="btn small"
                  onClick={() => {
                    setTable('');
                    setRows([]);
                    void loadTables().then((ts) => {
                      const t = ts.find((x) => x.startsWith('tf_'));
                      if (t) {
                        setTable(t);
                        setPage(1);
                        void loadRows(t, 1);
                      }
                    });
                  }}
                >
                  ⟳ 刷新表列表
                </button>
                {table && (
                  <span className="tf-hint">
                    共 {total} 行 · 第 {page} 页
                  </span>
                )}
              </div>
              {rows.length > 0 && (
                <div className="scroll-thin data-grid-wrap">
                  <table className="rule-table data-grid">
                    <thead>
                      <tr>
                        {cols(rows).map((c) => (
                          <th key={c}>{c}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => (
                        <tr key={i}>
                          {cols(rows).map((c) => (
                            <td key={c} title={String(r[c])}>
                              {fmt(r[c])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {table && (
                <div className="btn-row">
                  <button className="btn small" disabled={page <= 1} onClick={() => { setPage(page - 1); void loadRows(table, page - 1); }}>
                    ← 上一页
                  </button>
                  <button className="btn small" disabled={page * 20 >= total} onClick={() => { setPage(page + 1); void loadRows(table, page + 1); }}>
                    下一页 →
                  </button>
                </div>
              )}
            </>
          )}

          {tab === 'sql' && (
            <>
              <p className="tf-hint">只读查询：仅允许单条 SELECT（如 SELECT name, wins FROM …）</p>
              <textarea
                className="tf-input sql-box"
                rows={4}
                value={sql}
                spellCheck={false}
                onChange={(e) => setSql(e.target.value)}
              />
              <div className="btn-row">
                <button className="btn primary" disabled={busy} onClick={() => void runSql()}>
                  ▶ 执行查询
                </button>
              </div>
              {sqlRows && (
                <div className="scroll-thin data-grid-wrap">
                  {sqlRows.length === 0 ? (
                    <p className="tf-hint">0 行</p>
                  ) : (
                    <table className="rule-table data-grid">
                      <thead>
                        <tr>
                          {cols(sqlRows).map((c) => (
                            <th key={c}>{c}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {sqlRows.map((r, i) => (
                          <tr key={i}>
                            {cols(sqlRows).map((c) => (
                              <td key={c} title={String(r[c])}>
                                {fmt(r[c])}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function fmt(v: unknown): string {
  if (v === null) return 'NULL';
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 80);
  return String(v).slice(0, 80);
}
