// TANKFORGE 后端服务：坦克工坊 / 赛事 / 服务端对战 / MySQL 管理
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { BUILTIN_BOTS } from '../src/game/bots';
import { BUILD_PRESETS, emptyBuild } from '../src/game/build';
import type { BuildPoints } from '../src/game/types';
import { toModelBrainCode, validateModelJson } from '../src/game/modelBrain';
import { runBattle, runBattleTeams, type BattleOutcome, type TankSpec } from './battle';
import { STRATEGY_TEMPLATES, templateRows } from './templates';
import { buildStrategyPrompt, type PromptTemplate } from './prompt';
import {
  ensureTables,
  getPool,
  listTables,
  loadDbConfig,
  maskConfig,
  saveDbConfig,
  sha256,
  testDb,
  type DbConfig,
} from './db';

const PORT = Number(process.env.PORT || 8787);
const app = express();
app.use(express.json({ limit: '1mb' }));

type Handler = (req: express.Request, res: express.Response) => unknown | Promise<unknown>;
const h =
  (fn: Handler): express.RequestHandler =>
  async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.includes('未配置') ? 503 : 400;
      res.status(status).json({ error: message });
    }
  };

const ok = (res: express.Response, data: unknown) => res.json(data);
const bad = (res: express.Response, msg: string) => res.status(400).json({ error: msg });

// ------------------------------------------------------------
// 系统管理：MySQL 数据源
// ------------------------------------------------------------
app.get(
  '/api/admin/db',
  h((_req, res) => {
    const cfg = loadDbConfig();
    ok(res, { configured: !!cfg, config: cfg ? maskConfig(cfg) : null });
  }),
);

app.post(
  '/api/admin/db/test',
  h(async (req, res) => {
    const { host, port, user, password, database } = req.body as Partial<DbConfig>;
    if (!host || !user || !database) return bad(res, 'host / user / database 必填');
    await testDb({ host, port: Number(port) || 3306, user, password: password ?? '', database });
    ok(res, { ok: true });
  }),
);

app.post(
  '/api/admin/db/config',
  h(async (req, res) => {
    const { host, port, user, password, database } = req.body as Partial<DbConfig>;
    if (!host || !user || !database) return bad(res, 'host / user / database 必填');
    const cfg: DbConfig = { host, port: Number(port) || 3306, user, password: password ?? '', database };
    await testDb(cfg); // 连不上就拒绝保存
    saveDbConfig(cfg);
    ok(res, { ok: true });
  }),
);

app.post(
  '/api/admin/db/init',
  h(async (_req, res) => {
    await ensureTables(templateRows);
    ok(res, { ok: true, tables: await listTables() });
  }),
);

// ------------------------------------------------------------
// 策略模板库
// ------------------------------------------------------------
app.get(
  '/api/templates',
  h(async (_req, res) => {
    try {
      const pool = getPool();
      const [rows] = await pool.query(
        'SELECT name, description, code, build_json FROM tf_strategy_templates ORDER BY id',
      );
      ok(res, { templates: rows });
    } catch {
      // 数据库不可用：回退到内置清单，保证工坊可用
      ok(res, {
        templates: STRATEGY_TEMPLATES.map((t) => ({
          name: t.name,
          description: t.description,
          code: t.code,
          build_json: null,
          presetIdx: t.presetIdx,
        })),
      });
    }
  }),
);

app.get(
  '/api/admin/db/tables',
  h(async (_req, res) => {
    ok(res, { tables: await listTables() });
  }),
);

const TABLE_NAME_RE = /^[A-Za-z0-9_]+$/;

app.get(
  '/api/admin/db/data',
  h(async (req, res) => {
    const table = String(req.query.table ?? '');
    const page = Math.max(1, Number(req.query.page) || 1);
    const size = 20;
    if (!TABLE_NAME_RE.test(table)) return bad(res, '非法表名');
    const pool = getPool();
    const [rows] = await pool.query(`SELECT * FROM \`${table}\` ORDER BY 1 DESC LIMIT ? OFFSET ?`, [
      size,
      (page - 1) * size,
    ]);
    const [cnt] = await pool.query<mysql.RowDataPacket[]>(`SELECT COUNT(*) AS c FROM \`${table}\``);
    ok(res, { rows, total: Number(cnt[0]?.c ?? 0), page, size });
  }),
);

app.post(
  '/api/admin/db/query',
  h(async (req, res) => {
    const sql = String((req.body as { sql?: string }).sql ?? '').trim().replace(/;\s*$/, '');
    if (!/^select\s/i.test(sql) || /;\s*\S/.test(sql)) {
      return bad(res, '仅允许单条 SELECT 查询');
    }
    const pool = getPool();
    const [rows] = await pool.query(sql);
    ok(res, { rows: rows as unknown[] });
  }),
);

// ------------------------------------------------------------
// AI 生成用标准 Prompt（规则 + 地图 + 模板 + 代码规范，全量打包）
// ------------------------------------------------------------
app.get(
  '/api/prompt',
  h(async (_req, res) => {
    let templates: PromptTemplate[];
    try {
      const pool = getPool();
      const [rows] = await pool.query(
        'SELECT name, description, code, build_json FROM tf_strategy_templates ORDER BY id',
      );
      templates = (rows as Record<string, unknown>[]).map((r) => ({
        name: String(r.name),
        description: String(r.description ?? ''),
        code: String(r.code ?? ''),
        build:
          typeof r.build_json === 'string'
            ? (JSON.parse(r.build_json) as BuildPoints)
            : ((r.build_json as BuildPoints) ?? null),
      }));
    } catch {
      templates = STRATEGY_TEMPLATES.map((t) => ({ name: t.name, description: t.description, code: t.code }));
    }
    ok(res, { prompt: buildStrategyPrompt(templates) });
  }),
);

// ------------------------------------------------------------
// 坦克工坊
// ------------------------------------------------------------
function normalizeBuild(buildJson: unknown): BuildPoints {
  if (!buildJson || typeof buildJson !== 'object') return emptyBuild();
  const b = buildJson as Partial<BuildPoints>;
  const safe = (v: unknown, max: number) =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : 0;
  return {
    armor: safe(b.armor, 6),
    engine: safe(b.engine, 4),
    tracks: safe(b.tracks, 3),
    fireRate: safe(b.fireRate, 4),
    damage: safe(b.damage, 4),
    turret: safe(b.turret, 3),
    shellSpeed: safe(b.shellSpeed, 2),
    view: safe(b.view, 3),
    comm: safe(b.comm, 2),
    aimAssist: !!b.aimAssist,
    aimAuto: !!b.aimAuto,
  };
}

app.get(
  '/api/tanks',
  h(async (_req, res) => {
    const pool = getPool();
    const [rows] = await pool.query(
      'SELECT id, name, created_at, updated_at FROM tf_tanks ORDER BY created_at DESC',
    );
    ok(res, { tanks: rows });
  }),
);

app.post(
  '/api/tanks',
  h(async (req, res) => {
    const { name, secret, code, buildJson, presetIdx, modelJson } = req.body as Record<string, unknown>;
    const n = String(name ?? '').trim();
    const s = String(secret ?? '');
    if (!n || n.length > 32) return bad(res, '坦克名称必填（≤32 字符）');
    if (s.length < 4) return bad(res, '密钥至少 4 位（用于日后更新策略，请牢记）');
    // 模型策略：校验 tankforge-model JSON 并编译为自包含 decide 代码（对局/回放/沙箱全复用代码通道）
    let codeStr = typeof code === 'string' ? code : '';
    if (modelJson !== undefined && modelJson !== null) {
      const err = validateModelJson(modelJson);
      if (err) return bad(res, `模型不合法：${err}`);
      codeStr = toModelBrainCode(modelJson as Parameters<typeof toModelBrainCode>[0]);
    }
    const build = normalizeBuild(buildJson ?? (BUILD_PRESETS[Number(presetIdx) || 0]?.points));
    const pool = getPool();
    const [dup] = await pool.query('SELECT id FROM tf_tanks WHERE name = ?', [n]);
    if ((dup as unknown[]).length) return bad(res, `坦克名「${n}」已被占用`);
    await pool.query('INSERT INTO tf_tanks (name, secret_hash, code, build_json) VALUES (?,?,?,?)', [
      n,
      sha256(s),
      codeStr,
      JSON.stringify(build),
    ]);
    ok(res, { ok: true, name: n });
  }),
);

app.get(
  '/api/tanks/:name',
  h(async (req, res) => {
    const name = String(req.params.name);
    const secret = String(req.query.secret ?? '');
    const pool = getPool();
    const [rows] = await pool.query('SELECT * FROM tf_tanks WHERE name = ?', [name]);
    const tank = (rows as Record<string, unknown>[])[0];
    if (!tank) return bad(res, `坦克「${name}」不存在`);
    if (tank.secret_hash !== sha256(secret)) return bad(res, '密钥错误');
    ok(res, {
      tank: {
        name: tank.name,
        code: tank.code,
        buildJson: typeof tank.build_json === 'string' ? JSON.parse(tank.build_json) : tank.build_json,
        created_at: tank.created_at,
        updated_at: tank.updated_at,
      },
    });
  }),
);

app.put(
  '/api/tanks/:name',
  h(async (req, res) => {
    const name = String(req.params.name);
    const { secret, code, buildJson } = req.body as Record<string, unknown>;
    const pool = getPool();
    const [rows] = await pool.query('SELECT id, secret_hash FROM tf_tanks WHERE name = ?', [name]);
    const tank = (rows as Record<string, unknown>[])[0];
    if (!tank) return bad(res, `坦克「${name}」不存在`);
    if (tank.secret_hash !== sha256(String(secret ?? ''))) return bad(res, '密钥错误');
    const sets: string[] = [];
    const args: unknown[] = [];
    if (code !== undefined) {
      sets.push('code = ?');
      args.push(String(code));
    }
    if (buildJson !== undefined) {
      sets.push('build_json = ?');
      args.push(JSON.stringify(normalizeBuild(buildJson)));
    }
    if (sets.length) {
      args.push(name);
      await pool.query(`UPDATE tf_tanks SET ${sets.join(', ')} WHERE name = ?`, args);
    }
    ok(res, { ok: true });
  }),
);

// ------------------------------------------------------------
// 赛事
// ------------------------------------------------------------
app.get(
  '/api/tournaments',
  h(async (_req, res) => {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT t.*, (SELECT COUNT(*) FROM tf_registrations r WHERE r.tournament_id = t.id) AS roster_count,
              (SELECT COUNT(*) FROM tf_battles b WHERE b.tournament_id = t.id) AS battle_count
       FROM tf_tournaments t ORDER BY t.created_at DESC`,
    );
    ok(res, { tournaments: rows });
  }),
);

app.post(
  '/api/tournaments',
  h(async (req, res) => {
    const { title, type, startTime, endTime } = req.body as Record<string, unknown>;
    const t = String(title ?? '').trim();
    if (!t || t.length > 64) return bad(res, '赛事标题必填（≤64 字符）');
    const ty = type === 'battle-royale' ? 'battle-royale' : 'ladder';
    const pool = getPool();
    const [r] = await pool.query('INSERT INTO tf_tournaments (title, type, start_time, end_time) VALUES (?,?,?,?)', [
      t,
      ty,
      startTime || null,
      endTime || null,
    ]);
    const id = (r as { insertId: number }).insertId;
    // 自动注册 3 个内置 NPC 坦克，保证天梯开箱可打
    for (const b of BUILTIN_BOTS) {
      await pool.query('INSERT IGNORE INTO tf_registrations (tournament_id, tank_name, is_npc, bot_id) VALUES (?,?,1,?)', [
        id,
        b.name,
        b.id,
      ]);
    }
    ok(res, { ok: true, id });
  }),
);

interface RegistrationRow {
  tank_name: string;
  is_npc: number;
  bot_id: string | null;
}

async function loadRegistrations(tournamentId: number): Promise<RegistrationRow[]> {
  const pool = getPool();
  const [rows] = await pool.query('SELECT tank_name, is_npc, bot_id FROM tf_registrations WHERE tournament_id = ?', [
    tournamentId,
  ]);
  return rows as RegistrationRow[];
}

/** 校验坦克密钥（组队/报名等写操作用；发起挑战不需要密钥） */
async function verifyTankSecret(name: string, secret: unknown): Promise<void> {
  const pool = getPool();
  const [rows] = await pool.query('SELECT secret_hash FROM tf_tanks WHERE name = ?', [name]);
  const tank = (rows as Record<string, unknown>[])[0];
  if (!tank) throw new Error(`坦克「${name}」不存在（需先在坦克工坊创建）`);
  if (tank.secret_hash !== sha256(String(secret ?? ''))) throw new Error('密钥错误');
}

interface TeamDto {
  id: number;
  name: string;
  members: string[];
}

async function loadTeams(tournamentId: number): Promise<TeamDto[]> {
  const pool = getPool();
  const [teams] = await pool.query('SELECT id, name FROM tf_teams WHERE tournament_id = ? ORDER BY created_at', [
    tournamentId,
  ]);
  const [members] = await pool.query('SELECT team_id, tank_name FROM tf_team_members WHERE tournament_id = ?', [
    tournamentId,
  ]);
  const byTeam = new Map<number, string[]>();
  for (const m of members as { team_id: number; tank_name: string }[]) {
    const arr = byTeam.get(m.team_id) ?? [];
    arr.push(m.tank_name);
    byTeam.set(m.team_id, arr);
  }
  return (teams as { id: number; name: string }[]).map((t) => ({ id: t.id, name: t.name, members: byTeam.get(t.id) ?? [] }));
}

async function tankSpecOf(name: string, reg: RegistrationRow | undefined): Promise<TankSpec> {
  if (reg?.is_npc && reg.bot_id) {
    const bot = BUILTIN_BOTS.find((b) => b.id === reg.bot_id);
    if (!bot) throw new Error(`未知 NPC：${reg.bot_id}`);
    return { name, code: null, botId: bot.id, build: BUILD_PRESETS[bot.defaultBuild].points };
  }
  const pool = getPool();
  const [rows] = await pool.query('SELECT code, build_json FROM tf_tanks WHERE name = ?', [name]);
  const t = (rows as Record<string, unknown>[])[0];
  if (!t) throw new Error(`坦克「${name}」不存在（需先在坦克工坊创建）`);
  return { name, code: String(t.code ?? ''), botId: null, build: normalizeBuild(t.build_json) };
}

app.get(
  '/api/tournaments/:id',
  h(async (req, res) => {
    const id = Number(req.params.id);
    const pool = getPool();
    const [ts] = await pool.query('SELECT * FROM tf_tournaments WHERE id = ?', [id]);
    const t = (ts as Record<string, unknown>[])[0];
    if (!t) return bad(res, '赛事不存在');
    const roster = await loadRegistrations(id);
    const [battles] = await pool.query(
      'SELECT id, red_name, blue_name, winner, reason, ticks, created_at FROM tf_battles WHERE tournament_id = ? ORDER BY id DESC LIMIT 20',
      [id],
    );
    ok(res, { tournament: t, roster, battles, teams: await loadTeams(id) });
  }),
);

app.post(
  '/api/tournaments/:id/register',
  h(async (req, res) => {
    const id = Number(req.params.id);
    const { tankName, secret } = req.body as Record<string, unknown>;
    const name = String(tankName ?? '').trim();
    const pool = getPool();
    const [ts] = await pool.query('SELECT id FROM tf_tournaments WHERE id = ?', [id]);
    if (!(ts as unknown[]).length) return bad(res, '赛事不存在');
    try {
      await verifyTankSecret(name, secret);
    } catch (e) {
      return bad(res, (e as Error).message);
    }
    const [dup] = await pool.query('SELECT id FROM tf_registrations WHERE tournament_id = ? AND tank_name = ?', [
      id,
      name,
    ]);
    if ((dup as unknown[]).length) return bad(res, `「${name}」已报名该赛事`);
    await pool.query('INSERT INTO tf_registrations (tournament_id, tank_name, is_npc) VALUES (?,?,0)', [id, name]);
    ok(res, { ok: true });
  }),
);

// ------------------------------------------------------------
// 组队：创建 / 加入 / 退出（凭坦克密钥；发起挑战本身免密钥）
// ------------------------------------------------------------
app.post(
  '/api/tournaments/:id/teams',
  h(async (req, res) => {
    const id = Number(req.params.id);
    const { teamName, tankName, secret } = req.body as Record<string, unknown>;
    const team = String(teamName ?? '').trim();
    const tank = String(tankName ?? '').trim();
    if (!team || team.length > 32) return bad(res, '队名必填（≤32 字符）');
    const pool = getPool();
    const [ts] = await pool.query('SELECT id FROM tf_tournaments WHERE id = ?', [id]);
    if (!(ts as unknown[]).length) return bad(res, '赛事不存在');
    try {
      await verifyTankSecret(tank, secret);
    } catch (e) {
      return bad(res, (e as Error).message);
    }
    const roster = await loadRegistrations(id);
    if (!roster.some((r) => r.tank_name === tank && !r.is_npc)) return bad(res, `「${tank}」尚未报名该赛事，先报名再组队`);
    const [dupTeam] = await pool.query('SELECT id FROM tf_teams WHERE tournament_id = ? AND name = ?', [id, team]);
    if ((dupTeam as unknown[]).length) return bad(res, `队伍「${team}」已存在`);
    const [dupMem] = await pool.query('SELECT id FROM tf_team_members WHERE tournament_id = ? AND tank_name = ?', [
      id,
      tank,
    ]);
    if ((dupMem as unknown[]).length) return bad(res, `「${tank}」已加入其他队伍，先退出再加入`);
    const [r] = await pool.query('INSERT INTO tf_teams (tournament_id, name) VALUES (?,?)', [id, team]);
    const teamId = (r as { insertId: number }).insertId;
    await pool.query('INSERT INTO tf_team_members (team_id, tournament_id, tank_name) VALUES (?,?,?)', [
      teamId,
      id,
      tank,
    ]);
    ok(res, { ok: true, teamId });
  }),
);

app.post(
  '/api/tournaments/:id/teams/:teamId/join',
  h(async (req, res) => {
    const id = Number(req.params.id);
    const teamId = Number(req.params.teamId);
    const { tankName, secret } = req.body as Record<string, unknown>;
    const tank = String(tankName ?? '').trim();
    const pool = getPool();
    const [ts] = await pool.query('SELECT id, name FROM tf_teams WHERE id = ? AND tournament_id = ?', [teamId, id]);
    const team = (ts as { id: number; name: string }[])[0];
    if (!team) return bad(res, '队伍不存在');
    try {
      await verifyTankSecret(tank, secret);
    } catch (e) {
      return bad(res, (e as Error).message);
    }
    const roster = await loadRegistrations(id);
    if (!roster.some((r) => r.tank_name === tank && !r.is_npc)) return bad(res, `「${tank}」尚未报名该赛事`);
    const [cnt] = await pool.query('SELECT COUNT(*) AS c FROM tf_team_members WHERE team_id = ?', [teamId]);
    if (Number((cnt as { c: number }[])[0].c) >= 5) return bad(res, `队伍「${team.name}」已满（最多 5 人）`);
    const [dupMem] = await pool.query('SELECT id FROM tf_team_members WHERE tournament_id = ? AND tank_name = ?', [
      id,
      tank,
    ]);
    if ((dupMem as unknown[]).length) return bad(res, `「${tank}」已加入其他队伍，先退出再加入`);
    await pool.query('INSERT INTO tf_team_members (team_id, tournament_id, tank_name) VALUES (?,?,?)', [
      teamId,
      id,
      tank,
    ]);
    ok(res, { ok: true });
  }),
);

app.post(
  '/api/tournaments/:id/teams/:teamId/leave',
  h(async (req, res) => {
    const id = Number(req.params.id);
    const teamId = Number(req.params.teamId);
    const { tankName, secret } = req.body as Record<string, unknown>;
    const tank = String(tankName ?? '').trim();
    try {
      await verifyTankSecret(tank, secret);
    } catch (e) {
      return bad(res, (e as Error).message);
    }
    const pool = getPool();
    const [del] = await pool.query(
      'DELETE FROM tf_team_members WHERE team_id = ? AND tournament_id = ? AND tank_name = ?',
      [teamId, id, tank],
    );
    if (!(del as { affectedRows: number }).affectedRows) return bad(res, `「${tank}」不在这支队伍里`);
    const [cnt] = await pool.query('SELECT COUNT(*) AS c FROM tf_team_members WHERE team_id = ?', [teamId]);
    if (!Number((cnt as { c: number }[])[0].c)) await pool.query('DELETE FROM tf_teams WHERE id = ?', [teamId]);
    ok(res, { ok: true });
  }),
);

async function persistBattle(
  tournamentId: number,
  redLabel: string,
  blueLabel: string,
  redNames: string[],
  blueNames: string[],
  o: BattleOutcome,
) {
  const pool = getPool();
  await pool.query(
    'INSERT INTO tf_battles (tournament_id, red_name, blue_name, seed, winner, reason, ticks, result_json, red_names, blue_names) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [
      tournamentId,
      redLabel,
      blueLabel,
      o.seed,
      o.winner,
      o.reason,
      o.ticks,
      JSON.stringify(o),
      JSON.stringify(redNames),
      JSON.stringify(blueNames),
    ],
  );
}

/** 发起挑战（免密钥）：两种玩法
 *  ① 队伍多对多：body = { redTeam, blueTeam }（每队 1~5 名已报名坦克）
 *  ② 快速单挑：body = { myTank, opponent }（双方需已报名；对手可以是 NPC） */
app.post(
  '/api/tournaments/:id/battle',
  h(async (req, res) => {
    const id = Number(req.params.id);
    const { redTeam, blueTeam, myTank, opponent } = req.body as Record<string, unknown>;
    const roster = await loadRegistrations(id);
    if (!roster.length) return bad(res, '赛事不存在或无人报名');

    let redSpecs: TankSpec[];
    let blueSpecs: TankSpec[];
    let redLabel: string;
    let blueLabel: string;

    if (redTeam && blueTeam) {
      // 队伍多对多挑战
      const teams = await loadTeams(id);
      const rt = teams.find((t) => t.name === String(redTeam));
      const bt = teams.find((t) => t.name === String(blueTeam));
      if (!rt) return bad(res, `队伍「${redTeam}」不存在`);
      if (!bt) return bad(res, `队伍「${blueTeam}」不存在`);
      if (rt.id === bt.id) return bad(res, '不能自己打自己');
      if (!rt.members.length || !bt.members.length) return bad(res, '空队伍无法开战（先加入成员）');
      redLabel = rt.name;
      blueLabel = bt.name;
      redSpecs = await Promise.all(
        rt.members.map((n) => tankSpecOf(n, roster.find((r) => r.tank_name === n))),
      );
      blueSpecs = await Promise.all(
        bt.members.map((n) => tankSpecOf(n, roster.find((r) => r.tank_name === n))),
      );
    } else {
      // 快速单挑（免密钥：报名时已验证过车主身份）
      const myName = String(myTank ?? '').trim();
      const opName = String(opponent ?? '').trim();
      if (!myName || !opName) return bad(res, '请选择自己和对手');
      if (myName === opName) return bad(res, '不能和自己对战');
      const myReg = roster.find((r) => r.tank_name === myName && !r.is_npc);
      if (!myReg) return bad(res, `「${myName}」尚未报名该赛事`);
      const opReg = roster.find((r) => r.tank_name === opName);
      if (!opReg) return bad(res, `对手「${opName}」不在报名名单中`);
      redLabel = myName;
      blueLabel = opName;
      redSpecs = [await tankSpecOf(myName, myReg)];
      blueSpecs = [await tankSpecOf(opName, opReg)];
    }

    const outcome = await runBattleTeams(redSpecs, blueSpecs);
    await persistBattle(
      id,
      redLabel,
      blueLabel,
      redSpecs.map((s) => s.name),
      blueSpecs.map((s) => s.name),
      outcome,
    );
    // 返回 specs + seed：前端用同一套确定性引擎重演出完整对战画面
    ok(res, { ...outcome, red: redSpecs, blue: blueSpecs });
  }),
);

/** 观看历史对战：返回 seed + 双方策略（多对多为数组），前端本地重演（确定性 → 与入库结果逐帧一致） */
app.get(
  '/api/tournaments/:id/battle/:bid',
  h(async (req, res) => {
    const id = Number(req.params.id);
    const bid = Number(req.params.bid);
    const pool = getPool();
    const [rows] = await pool.query(
      'SELECT red_name, blue_name, red_names, blue_names, seed FROM tf_battles WHERE id = ? AND tournament_id = ?',
      [bid, id],
    );
    const b = (rows as Record<string, unknown>[])[0];
    if (!b) return bad(res, '对战记录不存在');
    const parseNames = (v: unknown, fb: string): string[] => {
      try {
        const arr = typeof v === 'string' ? (JSON.parse(v) as unknown) : v;
        if (Array.isArray(arr) && arr.length) return arr.map(String);
      } catch {
        /* 旧记录 */
      }
      return [fb];
    };
    const roster = await loadRegistrations(id);
    const redNames = parseNames(b.red_names, String(b.red_name));
    const blueNames = parseNames(b.blue_names, String(b.blue_name));
    const red = await Promise.all(redNames.map((n) => tankSpecOf(n, roster.find((r) => r.tank_name === n))));
    const blue = await Promise.all(blueNames.map((n) => tankSpecOf(n, roster.find((r) => r.tank_name === n))));
    ok(res, { seed: Number(b.seed), red, blue });
  }),
);

/** 吃鸡赛：报名名单全员两两循环混战（名单 ≤ 8 人时 28 场，约几秒） */
app.post(
  '/api/tournaments/:id/br-run',
  h(async (req, res) => {
    const id = Number(req.params.id);
    const roster = await loadRegistrations(id);
    if (roster.length < 2) return bad(res, '至少需要 2 个报名成员');
    if (roster.length > 8) return bad(res, '混战名单最多 8 人');
    const specs = await Promise.all(roster.map((r) => tankSpecOf(r.tank_name, r)));
    const outcomes: { red: string; blue: string; winner: string; reason: string }[] = [];
    for (let i = 0; i < specs.length; i++) {
      for (let j = i + 1; j < specs.length; j++) {
        const o = await runBattle(specs[i], specs[j]);
        await persistBattle(id, specs[i].name, specs[j].name, [specs[i].name], [specs[j].name], o);
        outcomes.push({ red: specs[i].name, blue: specs[j].name, winner: o.winner ?? 'draw', reason: o.reason });
      }
    }
    ok(res, { ok: true, count: outcomes.length, outcomes });
  }),
);

// ------------------------------------------------------------
// 排行榜（每次请求实时计算，不落库）
// 天梯积分 = 胜×3 + 平×1 + 击杀×1 + 命中率×5
// 排序：积分 ↓ → 胜场 ↓ → 击杀 ↓ → 命中率 ↓ → 场次少者优先 → 名字
// 队伍挑战时胜负按队伍计：胜方每辆坦克各 +1 胜
// ------------------------------------------------------------
app.get(
  '/api/tournaments/:id/leaderboard',
  h(async (req, res) => {
    const id = Number(req.params.id);
    const pool = getPool();
    const roster = await loadRegistrations(id);
    const [battles] = await pool.query(
      'SELECT red_name, blue_name, red_names, blue_names, winner, result_json FROM tf_battles WHERE tournament_id = ?',
      [id],
    );
    interface Agg {
      name: string;
      npc: boolean;
      battles: number;
      wins: number;
      draws: number;
      losses: number;
      kills: number;
      shots: number;
      hits: number;
    }
    const agg = new Map<string, Agg>();
    const entry = (name: string, npc: boolean): Agg => {
      let e = agg.get(name);
      if (!e) {
        e = { name, npc, battles: 0, wins: 0, draws: 0, losses: 0, kills: 0, shots: 0, hits: 0 };
        agg.set(name, e);
      }
      return e;
    };
    for (const r of roster) entry(r.tank_name, !!r.is_npc);
    const parseNames = (v: unknown, fb: string): string[] => {
      try {
        const arr = typeof v === 'string' ? (JSON.parse(v) as unknown) : v;
        if (Array.isArray(arr) && arr.length) return arr.map(String);
      } catch {
        /* 旧记录 */
      }
      return [fb];
    };
    for (const b of battles as Record<string, unknown>[]) {
      const winner = b.winner as string | null;
      // mysql2 对 JSON 列可能返回已解析对象或字符串，两者都兼容
      const rawStats = b.result_json;
      const stats = (
        typeof rawStats === 'string' ? JSON.parse(rawStats) : (rawStats ?? {})
      ) as { tanks?: { name: string; shots: number; hits: number; kills: number }[] };
      const sides = [
        { names: parseNames(b.red_names, String(b.red_name)), side: 'red' },
        { names: parseNames(b.blue_names, String(b.blue_name)), side: 'blue' },
      ] as const;
      for (const { names, side } of sides) {
        for (const name of names) {
          const e = entry(name, roster.find((r) => r.tank_name === name)?.is_npc === 1);
          e.battles++;
          if (winner === side) e.wins++;
          else if (winner === null) e.draws++;
          else e.losses++;
          const st = stats.tanks?.find((t) => t.name === name);
          e.kills += st?.kills ?? 0;
          e.shots += st?.shots ?? 0;
          e.hits += st?.hits ?? 0;
        }
      }
    }
    const board = [...agg.values()]
      .map((e) => {
        const accuracy = e.shots ? e.hits / e.shots : 0;
        const score = e.wins * 3 + e.draws + e.kills + accuracy * 5;
        return { ...e, accuracy, score: Math.round(score * 10) / 10 };
      })
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.wins - a.wins ||
          b.kills - a.kills ||
          b.accuracy - a.accuracy ||
          a.battles - b.battles ||
          a.name.localeCompare(b.name),
      );
    ok(res, { leaderboard: board });
  }),
);

// ------------------------------------------------------------
// 静态托管（生产：npm run build 后 npm start 一个进程同时服务前端与 API）
// ------------------------------------------------------------
const DIST = path.resolve(process.cwd(), 'dist');
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(DIST, 'index.html')));
}

export function startServer(): http.Server {
  return app.listen(PORT, () => {
    console.log(`[tankforge-server] listening on http://localhost:${PORT}`);
  });
}

if (process.argv[1] && process.argv[1].endsWith('server/index.ts')) {
  startServer();
}
