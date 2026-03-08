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

export default db;
