import fs from "fs";
import path from "path";
import { execSync, spawn } from "child_process";
import { fileURLToPath } from "url";

const __dirname = typeof import.meta.dirname === "string" ? import.meta.dirname : path.dirname(fileURLToPath(import.meta.url));

const TOEDB_URL = process.env.TOEDB_URL || "https://toedb.kavi.io";
const TOEDB_TOKEN = process.env.TOEDB_TOKEN || "";
const PI_STATE_FILE = path.join(process.env.HOME || "~", ".pi", "state.json");
const NANOGPT_DIR = process.env.NANOGPT_DIR || path.join(__dirname, "..", "..", "nanoGPT");
const POLL_INTERVAL = 15_000;

async function api(urlPath: string, opts?: RequestInit) {
  const res = await fetch(`${TOEDB_URL}/api${urlPath}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOEDB_TOKEN}`,
      ...opts?.headers,
    },
  });
  if (!res.ok) throw new Error(`API ${urlPath}: ${res.status} ${await res.text()}`);
  return res.json();
}

function readPiState(): any | null {
  try {
    return JSON.parse(fs.readFileSync(PI_STATE_FILE, "utf-8"));
  } catch {
    return null;
  }
}

function runPiCommand(args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const proc = spawn("uv", ["run", "pi.py", ...args], {
      cwd: NANOGPT_DIR,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    proc.stdout.on("data", (d: Buffer) => { output += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { output += d.toString(); });
    // Auto-answer "yes" to interactive prompts
    proc.stdin.write("y\n");
    proc.stdin.end();
    proc.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

async function pushRun(runId: number) {
  const runDir = path.join(NANOGPT_DIR, "outputs", String(runId));
  const runJsonPath = path.join(runDir, "run.json");
  const logJsonPath = path.join(runDir, "log.json");
  if (!fs.existsSync(runJsonPath)) return;

  const fixJson = (s: string) => s.replace(/\bNaN\b/g, "null").replace(/\b-?Infinity\b/g, "null");
  const run = JSON.parse(fixJson(fs.readFileSync(runJsonPath, "utf-8")));
  let metrics = null;
  if (fs.existsSync(logJsonPath)) {
    metrics = JSON.parse(fixJson(fs.readFileSync(logJsonPath, "utf-8")));
  }

  await api(`/runs/${runId}/upload`, {
    method: "POST",
    body: JSON.stringify({ run, metrics }),
  });
  console.log(`  Pushed run ${runId}`);
}

// Track which runs we've already pushed (by their last-modified time)
const pushedRuns = new Map<number, number>();

async function syncCompletedRuns() {
  const piState = readPiState();
  if (!piState?.commands) return;

  for (const [_cmdId, cmd] of Object.entries(piState.commands) as Array<[string, any]>) {
    if (cmd.status !== "completed" || !cmd.run_id) continue;
    const runDir = path.join(NANOGPT_DIR, "outputs", String(cmd.run_id));
    const logPath = path.join(runDir, "log.json");
    if (!fs.existsSync(logPath)) continue;

    const mtime = fs.statSync(logPath).mtimeMs;
    if (pushedRuns.get(cmd.run_id) === mtime) continue;

    try {
      await pushRun(cmd.run_id);
      pushedRuns.set(cmd.run_id, mtime);
    } catch (e: any) {
      console.error(`  Failed to push run ${cmd.run_id}: ${e.message}`);
    }
  }
}

async function tick() {
  try {
    // 1. Push pi.py state to toeDB
    const piState = readPiState();
    if (piState) {
      // Slim it down — don't send full command history
      const slim: any = { ...piState };
      if (slim.commands) {
        const cmds = slim.commands as Record<string, any>;
        slim.commands_summary = {
          total: Object.keys(cmds).length,
          pending: Object.values(cmds).filter((c: any) => c.status === "pending").length,
          running: Object.values(cmds).filter((c: any) => c.status === "running").length,
        };
        // Only include active commands
        slim.active_commands = Object.fromEntries(
          Object.entries(cmds).filter(([_, c]: [string, any]) => c.status === "pending" || c.status === "running")
        );
        delete slim.commands;
      }
      if (slim.runs) {
        slim.runs_count = Object.keys(slim.runs).length;
        delete slim.runs;
      }
      delete slim.api_key; // never send this
      await api("/pod/state", { method: "POST", body: JSON.stringify(slim) });
    }

    // 2. Sync completed runs
    await syncCompletedRuns();

    // 3. Pick up pending commands from toeDB
    const pending = await api("/pod/commands?status=pending") as any[];
    for (const cmd of pending) {
      console.log(`Executing command ${cmd.id}: ${cmd.type} ${cmd.config || ""}`);
      await api(`/pod/commands/${cmd.id}`, {
        method: "PUT",
        body: JSON.stringify({ status: "running" }),
      });

      let args: string[];
      const overrides: string[] = cmd.overrides ? JSON.parse(cmd.overrides) : [];

      switch (cmd.type) {
        case "up":
          args = ["up"];
          break;
        case "down":
          args = ["down", "-f"];
          break;
        case "train":
          args = ["train", cmd.config, ...overrides];
          break;
        case "sample":
          args = cmd.run_id
            ? ["sample", `--run=${cmd.run_id}`, ...overrides]
            : ["sample", ...overrides];
          break;
        case "resume":
          args = cmd.run_id
            ? ["resume", `--run=${cmd.run_id}`, ...overrides]
            : ["resume", ...overrides];
          break;
        default:
          console.error(`Unknown command type: ${cmd.type}`);
          await api(`/pod/commands/${cmd.id}`, {
            method: "PUT",
            body: JSON.stringify({ status: "failed", error: `Unknown type: ${cmd.type}` }),
          });
          continue;
      }

      const result = await runPiCommand(args);
      console.log(`  pi.py output: ${result.output.trim()}`);

      // For train commands, extract run ID from output (e.g., "Run 105: config/...")
      let runId = cmd.run_id;
      if (cmd.type === "train" && !runId) {
        const match = result.output.match(/Run (\d+):/);
        if (match) runId = parseInt(match[1]);
      }

      if (result.code === 0) {
        await api(`/pod/commands/${cmd.id}`, {
          method: "PUT",
          body: JSON.stringify({ status: "completed", run_id: runId }),
        });
      } else {
        await api(`/pod/commands/${cmd.id}`, {
          method: "PUT",
          body: JSON.stringify({ status: "failed", error: result.output.slice(-500), run_id: runId }),
        });
      }
    }
  } catch (e: any) {
    console.error(`Bridge error: ${e.message}`);
  }
}

console.log(`toeDB bridge started`);
console.log(`  Server: ${TOEDB_URL}`);
console.log(`  nanoGPT: ${NANOGPT_DIR}`);
console.log(`  Poll interval: ${POLL_INTERVAL / 1000}s`);

// Run immediately, then on interval
tick();
setInterval(tick, POLL_INTERVAL);
