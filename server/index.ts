import express from "express";
import cookieParser from "cookie-parser";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = typeof import.meta.dirname === "string" ? import.meta.dirname : path.dirname(fileURLToPath(import.meta.url));
import {
  authenticate,
  createUser,
  hasUsers,
  validateSession,
  getRuns,
  getRun,
  getMetrics,
  getMetricKeys,
  getAllMetricKeys,
  getRunsByEditDistance,
  getSetting,
  setSetting,
  getSettings,
  createPodCommand,
  getPodCommands,
  updatePodCommand,
  storePodState,
  getPodState,
  upsertRun,
  insertMetrics,
  createAblationGroup,
  getAblationGroups,
  getAblationGroupsForRun,
} from "./db.js";

const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(cookieParser());

const PORT = parseInt(process.env.PORT || "3456");

// Auth middleware
function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const token = req.cookies?.token;
  if (!token || !validateSession(token)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// Token or cookie auth middleware (for CLI tools)
function requireTokenOrAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  // Check Bearer token first (for CLI tools)
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    const storedToken = getSetting("api_token");
    if (storedToken && token === storedToken) {
      next();
      return;
    }
  }
  // Fall back to cookie auth
  requireAuth(req, res, next);
}

// Auth routes
app.post("/api/auth/register", (req, res) => {
  if (hasUsers()) {
    res.status(403).json({ error: "Registration disabled (user already exists)" });
    return;
  }
  const { username, password } = req.body;
  if (!username || !password) {
    res.status(400).json({ error: "Username and password required" });
    return;
  }
  createUser(username, password);
  const token = authenticate(username, password)!;
  res.cookie("token", token, { httpOnly: true, sameSite: "strict", maxAge: 30 * 24 * 60 * 60 * 1000 });
  res.json({ ok: true });
});

app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body;
  const token = authenticate(username, password);
  if (!token) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }
  res.cookie("token", token, { httpOnly: true, sameSite: "strict", maxAge: 30 * 24 * 60 * 60 * 1000 });
  res.json({ ok: true });
});

app.post("/api/auth/logout", (_req, res) => {
  res.clearCookie("token");
  res.json({ ok: true });
});

app.get("/api/auth/check", (req, res) => {
  const token = req.cookies?.token;
  const needsSetup = !hasUsers();
  if (needsSetup) {
    res.json({ authenticated: false, needsSetup: true });
    return;
  }
  res.json({ authenticated: !!(token && validateSession(token)), needsSetup: false });
});

// Data routes (all require auth)
app.get("/api/runs", requireAuth, (req, res) => {
  const search = req.query.q as string | undefined;
  res.json(getRuns(search));
});

app.get("/api/runs/:id", requireAuth, (req, res) => {
  const run = getRun(parseInt(req.params.id as string));
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  res.json(run);
});

app.get("/api/runs/:id/metrics", requireAuth, (req, res) => {
  const keys = req.query.keys ? (req.query.keys as string).split(",") : undefined;
  const rows = getMetrics(parseInt(req.params.id as string), keys) as Array<{ iter: number; key: string; value: number }>;
  // Pivot: group by iter
  const byIter = new Map<number, Record<string, number>>();
  for (const row of rows) {
    let entry = byIter.get(row.iter);
    if (!entry) {
      entry = { iter: row.iter };
      byIter.set(row.iter, entry);
    }
    entry[row.key] = row.value;
  }
  res.json(Array.from(byIter.values()));
});

app.get("/api/runs/:id/metric-keys", requireAuth, (req, res) => {
  res.json(getMetricKeys(parseInt(req.params.id as string)));
});

app.get("/api/metric-keys", requireAuth, (_req, res) => {
  res.json(getAllMetricKeys());
});

app.get("/api/runs/:id/nearby", requireAuth, (req, res) => {
  const id = parseInt(req.params.id as string);
  const maxDistance = parseInt((req.query.distance as string) || "1");
  res.json(getRunsByEditDistance(id, maxDistance));
});

// Ablation group routes
app.get("/api/ablation-groups", requireAuth, (req, res) => {
  const search = req.query.q as string | undefined;
  res.json(getAblationGroups(search));
});

app.post("/api/ablation-groups", requireAuth, (req, res) => {
  const { name, description, run_ids } = req.body;
  if (!name || !run_ids || !Array.isArray(run_ids) || run_ids.length === 0) {
    res.status(400).json({ error: "name and run_ids required" });
    return;
  }
  const id = createAblationGroup(name, description || null, run_ids);
  res.json({ ok: true, id });
});

app.get("/api/runs/:id/ablation-groups", requireAuth, (req, res) => {
  res.json(getAblationGroupsForRun(parseInt(req.params.id as string)));
});

// Settings routes
app.get("/api/settings", requireAuth, (_req, res) => {
  const settings = getSettings();
  // Don't expose the full API keys, just whether they're set
  const safe: Record<string, string | boolean> = {};
  for (const [k, v] of Object.entries(settings)) {
    if (k === "pi_api_key" || k === "api_token") {
      safe[k] = v ? `${v.slice(0, 4)}...${v.slice(-4)}` : "";
      safe[`${k}_set`] = !!v;
    } else if (k === "pod_state") {
      continue; // skip, separate endpoint
    } else {
      safe[k] = v;
    }
  }
  res.json(safe);
});

app.put("/api/settings", requireAuth, (req, res) => {
  const { key, value } = req.body;
  if (!key || typeof value !== "string") {
    res.status(400).json({ error: "key and value required" });
    return;
  }
  const allowed = ["pi_api_key", "api_token"];
  if (!allowed.includes(key)) {
    res.status(400).json({ error: `Setting '${key}' not allowed` });
    return;
  }
  setSetting(key, value);
  res.json({ ok: true });
});

// Upload route (for push.ts / bridge)
app.post("/api/runs/:id/upload", requireTokenOrAuth, (req, res) => {
  const id = parseInt(req.params.id as string);
  const { run, metrics } = req.body;
  if (run) {
    upsertRun({
      id,
      config: run.config ?? "",
      overrides: run.overrides ?? [],
      git_sha: run.git_sha ?? "",
      created_at: run.created_at ?? "",
      iter_num: run.iter_num,
      best_val_loss: run.best_val_loss,
    });
  }
  if (metrics && Array.isArray(metrics)) {
    insertMetrics(id, metrics);
  }
  res.json({ ok: true, id });
});

// Pod state routes
app.get("/api/pod", requireAuth, async (_req, res) => {
  const state = getPodState();
  // Optionally enrich with PI API data
  const apiKey = getSetting("pi_api_key");
  let apiStatus = null;
  if (apiKey && state?.pod_id) {
    try {
      const r = await fetch(`https://api.primeintellect.ai/api/v1/pods/status?pod_ids=${state.pod_id}`, {
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      });
      if (r.ok) {
        const data = await r.json();
        apiStatus = data.data?.[0] ?? null;
      }
    } catch {}
  }
  res.json({ state, apiStatus });
});

app.post("/api/pod/state", requireTokenOrAuth, (req, res) => {
  storePodState(JSON.stringify(req.body));
  res.json({ ok: true });
});

// Pod command routes
app.get("/api/pod/commands", requireTokenOrAuth, (req, res) => {
  const status = req.query.status as string | undefined;
  res.json(getPodCommands(status));
});

app.post("/api/pod/commands", requireAuth, (req, res) => {
  const { type, config, overrides } = req.body;
  if (!type) {
    res.status(400).json({ error: "type required" });
    return;
  }
  const id = createPodCommand({ type, config, overrides });
  res.json({ ok: true, id });
});

app.put("/api/pod/commands/:id", requireTokenOrAuth, (req, res) => {
  const id = parseInt(req.params.id as string);
  const { status, error, run_id } = req.body;
  updatePodCommand(id, { status, error, run_id });
  res.json({ ok: true });
});

// Serve static files in production
const distPath = path.join(__dirname, "..", "dist");
app.use(express.static(distPath));
app.get("*", (_req, res) => {
  res.sendFile(path.join(distPath, "index.html"));
});

app.listen(PORT, () => {
  console.log(`toeDB running on http://localhost:${PORT}`);
});
