// MySQL 数据源管理：配置持久化（server/data/dbconfig.json）+ 连接池 + 建表初始化
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';

export interface DbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

const DATA_DIR = path.resolve(process.cwd(), 'server/data');
const CONFIG_PATH = path.join(DATA_DIR, 'dbconfig.json');

let pool: mysql.Pool | null = null;
let poolKey = '';

export function loadDbConfig(): DbConfig | null {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as DbConfig;
  } catch {
    return null;
  }
}

export function saveDbConfig(c: DbConfig): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));
  if (pool) void pool.end().catch(() => undefined);
  pool = null;
  poolKey = '';
}

export function maskConfig(c: DbConfig): DbConfig & { password: string } {
  return { ...c, password: c.password ? '******' : '' };
}

export function getPool(): mysql.Pool {
  const cfg = loadDbConfig();
  if (!cfg) throw new Error('未配置 MySQL 数据源（请在系统管理页配置）');
  const key = JSON.stringify(cfg);
  if (!pool || poolKey !== key) {
    poolKey = key;
    pool = mysql.createPool({
      ...cfg,
      waitForConnections: true,
      connectionLimit: 8,
      connectTimeout: 5000,
      dateStrings: true,
    });
  }
  return pool;
}

export async function testDb(c: DbConfig): Promise<void> {
  const conn = await mysql.createConnection({ ...c, connectTimeout: 5000 });
  try {
    await conn.query('SELECT 1');
  } finally {
    await conn.end();
  }
}

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** 建表 DDL（幂等） */
export const DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS tf_tanks (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(64) NOT NULL UNIQUE,
    secret_hash CHAR(64) NOT NULL,
    code MEDIUMTEXT NULL,
    build_json JSON NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS tf_tournaments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(128) NOT NULL,
    type VARCHAR(16) NOT NULL DEFAULT 'ladder',
    start_time DATETIME NULL,
    end_time DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS tf_registrations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tournament_id INT NOT NULL,
    tank_name VARCHAR(64) NOT NULL,
    is_npc TINYINT(1) NOT NULL DEFAULT 0,
    bot_id VARCHAR(16) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_reg (tournament_id, tank_name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS tf_battles (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tournament_id INT NOT NULL,
    red_name VARCHAR(64) NOT NULL,
    blue_name VARCHAR(64) NOT NULL,
    seed INT NOT NULL DEFAULT 0,
    winner VARCHAR(8) NULL,
    reason VARCHAR(16) NULL,
    ticks INT NOT NULL DEFAULT 0,
    result_json JSON NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_battle_t (tournament_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS tf_teams (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tournament_id INT NOT NULL,
    name VARCHAR(64) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_team (tournament_id, name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS tf_team_members (
    id INT AUTO_INCREMENT PRIMARY KEY,
    team_id INT NOT NULL,
    tournament_id INT NOT NULL,
    tank_name VARCHAR(64) NOT NULL,
    joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_member (tournament_id, tank_name),
    KEY idx_member_team (team_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS tf_strategy_templates (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(64) NOT NULL UNIQUE,
    description VARCHAR(255) NULL,
    code MEDIUMTEXT NOT NULL,
    build_json JSON NULL,
    builtin TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

export async function ensureTables(seedTemplates: () => { name: string; description: string; code: string; build_json: string }[]): Promise<void> {
  const p = getPool();
  for (const ddl of DDL) await p.query(ddl);
  await migrateBattlesColumns(p);
  // 种子内置策略模板（按名幂等）
  for (const t of seedTemplates()) {
    await p.query(
      'INSERT IGNORE INTO tf_strategy_templates (name, description, code, build_json, builtin) VALUES (?,?,?, ?,1)',
      [t.name, t.description, t.code, t.build_json],
    );
  }
}

/** tf_battles 增量迁移：多对多对战的成员名单列（MySQL 不支持 ADD COLUMN IF NOT EXISTS） */
async function migrateBattlesColumns(p: mysql.Pool): Promise<void> {
  const [cols] = await p.query<mysql.RowDataPacket[]>(
    "SELECT column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'tf_battles'",
  );
  const have = new Set(cols.map((r) => String(r.c)));
  if (!have.has('red_names')) await p.query('ALTER TABLE tf_battles ADD COLUMN red_names JSON NULL AFTER red_name');
  if (!have.has('blue_names')) await p.query('ALTER TABLE tf_battles ADD COLUMN blue_names JSON NULL AFTER blue_name');
}

export async function listTables(): Promise<string[]> {
  const p = getPool();
  const cfg = loadDbConfig()!;
  const [rows] = await p.query<mysql.RowDataPacket[]>(
    'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name',
    [cfg.database],
  );
  return rows.map((r) => String(r.name));
}
