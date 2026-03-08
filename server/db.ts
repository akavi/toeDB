import Database from "better-sqlite3";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = typeof import.meta.dirname === "string" ? import.meta.dirname : path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.TOEDB_PATH || path.join(__dirname, "..", "toedb.sqlite");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY,
    config TEXT,
    overrides TEXT, -- JSON array
    git_sha TEXT,
    created_at TEXT,
    iter_num INTEGER,
    best_val_loss REAL
  );

  CREATE TABLE IF NOT EXISTS metrics (
    run_id INTEGER NOT NULL REFERENCES runs(id),
    iter INTEGER NOT NULL,
    key TEXT NOT NULL,
    value REAL NOT NULL,
    PRIMARY KEY (run_id, iter, key)
  );

  CREATE INDEX IF NOT EXISTS idx_metrics_run ON metrics(run_id);
  CREATE INDEX IF NOT EXISTS idx_runs_config ON runs(config);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pod_commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL, -- up, down, train, sample, resume
    config TEXT,
    overrides TEXT, -- JSON array
    run_id INTEGER,
    status TEXT NOT NULL DEFAULT 'pending', -- pending, running, completed, failed
    error TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS ablation_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS ablation_group_runs (
    group_id INTEGER NOT NULL REFERENCES ablation_groups(id) ON DELETE CASCADE,
    run_id INTEGER NOT NULL REFERENCES runs(id),
    PRIMARY KEY (group_id, run_id)
  );
`);

function hashPassword(password: string, salt: string): string {
  return crypto.pbkdf2Sync(password, salt, 100000, 64, "sha512").toString("hex");
}

export function createUser(username: string, password: string) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = hashPassword(password, salt);
  db.prepare("INSERT INTO users (username, password_hash, salt) VALUES (?, ?, ?)").run(username, hash, salt);
}

export function authenticate(username: string, password: string): string | null {
  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username) as any;
  if (!user) return null;
  const hash = hashPassword(password, user.salt);
  if (hash !== user.password_hash) return null;
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions (token, user_id) VALUES (?, ?)").run(token, user.id);
  return token;
}

export function validateSession(token: string): boolean {
  const row = db.prepare("SELECT 1 FROM sessions WHERE token = ?").get(token);
  return !!row;
}

export function hasUsers(): boolean {
  const row = db.prepare("SELECT 1 FROM users LIMIT 1").get();
  return !!row;
}

export function upsertRun(run: {
  id: number;
  config: string;
  overrides: string[];
  git_sha: string;
  created_at: string;
  iter_num?: number;
  best_val_loss?: number;
}) {
  db.prepare(`
    INSERT INTO runs (id, config, overrides, git_sha, created_at, iter_num, best_val_loss)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      config=excluded.config, overrides=excluded.overrides, git_sha=excluded.git_sha,
      created_at=excluded.created_at, iter_num=excluded.iter_num, best_val_loss=excluded.best_val_loss
  `).run(run.id, run.config, JSON.stringify(run.overrides), run.git_sha, run.created_at, run.iter_num ?? null, run.best_val_loss ?? null);
}

export function insertMetrics(runId: number, metrics: Array<Record<string, number>>) {
  const insert = db.prepare(
    "INSERT OR REPLACE INTO metrics (run_id, iter, key, value) VALUES (?, ?, ?, ?)"
  );
  const tx = db.transaction((rows: Array<Record<string, number>>) => {
    // Clear existing metrics for this run first
    db.prepare("DELETE FROM metrics WHERE run_id = ?").run(runId);
    for (const row of rows) {
      const iter = row.iter;
      for (const [key, value] of Object.entries(row)) {
        if (key === "iter") continue;
        if (typeof value === "number" && isFinite(value)) {
          insert.run(runId, iter, key, value);
        }
      }
    }
  });
  tx(metrics);
}

export function getRuns(search?: string) {
  if (search) {
    return db.prepare(
      "SELECT * FROM runs WHERE config LIKE ? OR overrides LIKE ? ORDER BY id DESC"
    ).all(`%${search}%`, `%${search}%`);
  }
  return db.prepare("SELECT * FROM runs ORDER BY id DESC").all();
}

// Compute config param edit distance between two runs
// A "config param" is each override entry + config + git_sha
// Edit distance = number of params that differ
function runConfigParams(run: any): Map<string, string> {
  const params = new Map<string, string>();
  params.set("__config__", run.config || "");
  params.set("__git_sha__", run.git_sha || "");
  try {
    const overrides = JSON.parse(run.overrides || "[]") as string[];
    for (const o of overrides) {
      const eq = o.indexOf("=");
      if (eq > 0) {
        params.set(o.slice(0, eq).replace(/^--/, ""), o.slice(eq + 1));
      } else {
        params.set(o.replace(/^--/, ""), "true");
      }
    }
  } catch {}
  return params;
}

function configEditDistance(a: Map<string, string>, b: Map<string, string>): number {
  const allKeys = new Set([...a.keys(), ...b.keys()]);
  let dist = 0;
  for (const k of allKeys) {
    if (a.get(k) !== b.get(k)) dist++;
  }
  return dist;
}

export function getRunsByEditDistance(runId: number, maxDistance: number) {
  const targetRun = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as any;
  if (!targetRun) return [];
  const targetParams = runConfigParams(targetRun);
  const allRuns = db.prepare("SELECT * FROM runs ORDER BY id DESC").all() as any[];
  return allRuns
    .filter((r) => r.id !== runId)
    .map((r) => ({ ...r, _distance: configEditDistance(targetParams, runConfigParams(r)) }))
    .filter((r) => r._distance <= maxDistance)
    .sort((a, b) => a._distance - b._distance || b.id - a.id);
}

export function getRun(id: number) {
  return db.prepare("SELECT * FROM runs WHERE id = ?").get(id);
}

export function getMetrics(runId: number, keys?: string[]) {
  if (keys && keys.length > 0) {
    const placeholders = keys.map(() => "?").join(",");
    return db.prepare(
      `SELECT iter, key, value FROM metrics WHERE run_id = ? AND key IN (${placeholders}) ORDER BY iter`
    ).all(runId, ...keys);
  }
  return db.prepare(
    "SELECT iter, key, value FROM metrics WHERE run_id = ? ORDER BY iter"
  ).all(runId);
}

export function getMetricKeys(runId: number): string[] {
  const rows = db.prepare(
    "SELECT DISTINCT key FROM metrics WHERE run_id = ? ORDER BY key"
  ).all(runId) as Array<{ key: string }>;
  return rows.map((r) => r.key);
}

export function getAllMetricKeys(): string[] {
  const rows = db.prepare(
    "SELECT DISTINCT key FROM metrics ORDER BY key"
  ).all() as Array<{ key: string }>;
  return rows.map((r) => r.key);
}

export function getSetting(key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as any;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string) {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
}

export function getSettings(): Record<string, string> {
  const rows = db.prepare("SELECT key, value FROM settings").all() as Array<{ key: string; value: string }>;
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export function createPodCommand(cmd: { type: string; config?: string; overrides?: string[]; run_id?: number }) {
  const result = db.prepare(
    "INSERT INTO pod_commands (type, config, overrides, run_id) VALUES (?, ?, ?, ?)"
  ).run(cmd.type, cmd.config ?? null, cmd.overrides ? JSON.stringify(cmd.overrides) : null, cmd.run_id ?? null);
  return result.lastInsertRowid;
}

export function getPodCommands(status?: string) {
  if (status) {
    return db.prepare("SELECT * FROM pod_commands WHERE status = ? ORDER BY id").all(status);
  }
  return db.prepare("SELECT * FROM pod_commands ORDER BY id DESC LIMIT 50").all();
}

export function updatePodCommand(id: number, update: { status: string; error?: string; run_id?: number }) {
  if (update.status === "completed" || update.status === "failed") {
    db.prepare("UPDATE pod_commands SET status = ?, error = ?, run_id = ?, completed_at = datetime('now') WHERE id = ?")
      .run(update.status, update.error ?? null, update.run_id ?? null, id);
  } else {
    db.prepare("UPDATE pod_commands SET status = ?, error = ?, run_id = ? WHERE id = ?")
      .run(update.status, update.error ?? null, update.run_id ?? null, id);
  }
}

export function storePodState(state: string) {
  setSetting("pod_state", state);
}

export function getPodState(): any | null {
  const raw = getSetting("pod_state");
  return raw ? JSON.parse(raw) : null;
}

// Ablation groups
export function createAblationGroup(name: string, description: string | null, runIds: number[]): number {
  const result = db.prepare(
    "INSERT INTO ablation_groups (name, description) VALUES (?, ?)"
  ).run(name, description);
  const groupId = result.lastInsertRowid as number;
  const insertRun = db.prepare("INSERT INTO ablation_group_runs (group_id, run_id) VALUES (?, ?)");
  for (const runId of runIds) {
    insertRun.run(groupId, runId);
  }
  return groupId;
}

export function getAblationGroups(search?: string) {
  let groups: any[];
  if (search) {
    groups = db.prepare(
      "SELECT * FROM ablation_groups WHERE name LIKE ? OR description LIKE ? ORDER BY created_at DESC"
    ).all(`%${search}%`, `%${search}%`);
  } else {
    groups = db.prepare("SELECT * FROM ablation_groups ORDER BY created_at DESC").all();
  }
  // Attach run_ids to each group
  const getRunIds = db.prepare("SELECT run_id FROM ablation_group_runs WHERE group_id = ?");
  return groups.map((g) => ({
    ...g,
    run_ids: (getRunIds.all(g.id) as Array<{ run_id: number }>).map((r) => r.run_id),
  }));
}

export function getAblationGroupsForRun(runId: number) {
  const groups = db.prepare(
    `SELECT ag.* FROM ablation_groups ag
     JOIN ablation_group_runs agr ON ag.id = agr.group_id
     WHERE agr.run_id = ?
     ORDER BY ag.created_at DESC`
  ).all(runId) as any[];
  const getRunIds = db.prepare("SELECT run_id FROM ablation_group_runs WHERE group_id = ?");
  return groups.map((g) => ({
    ...g,
    run_ids: (getRunIds.all(g.id) as Array<{ run_id: number }>).map((r) => r.run_id),
  }));
}

export default db;
