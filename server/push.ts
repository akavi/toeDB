import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = typeof import.meta.dirname === "string" ? import.meta.dirname : path.dirname(fileURLToPath(import.meta.url));

const TOEDB_URL = process.env.TOEDB_URL || "https://toedb.kavi.io";
const TOEDB_TOKEN = process.env.TOEDB_TOKEN || "";
const OUTPUTS_DIR = process.env.OUTPUTS_DIR || path.join(__dirname, "..", "..", "nanoGPT", "outputs");

async function pushRun(runId: number) {
  const runDir = path.join(OUTPUTS_DIR, String(runId));
  const runJsonPath = path.join(runDir, "run.json");
  const logJsonPath = path.join(runDir, "log.json");

  if (!fs.existsSync(runJsonPath)) {
    console.error(`No run.json found at ${runJsonPath}`);
    process.exit(1);
  }

  const fixJson = (s: string) => s.replace(/\bNaN\b/g, "null").replace(/\b-?Infinity\b/g, "null");

  const run = JSON.parse(fixJson(fs.readFileSync(runJsonPath, "utf-8")));
  let metrics = null;
  if (fs.existsSync(logJsonPath)) {
    metrics = JSON.parse(fixJson(fs.readFileSync(logJsonPath, "utf-8")));
  }

  const res = await fetch(`${TOEDB_URL}/api/runs/${runId}/upload`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOEDB_TOKEN}`,
    },
    body: JSON.stringify({ run, metrics }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`Upload failed (${res.status}): ${body}`);
    process.exit(1);
  }

  console.log(`Pushed run ${runId} to ${TOEDB_URL}`);
}

// Support: push.ts 105 or push.ts 105 106 107 or push.ts --all
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: push.ts <run_id> [run_id...] | --all");
  process.exit(1);
}

if (args[0] === "--all") {
  const dirs = fs.readdirSync(OUTPUTS_DIR)
    .filter((d) => /^\d+$/.test(d))
    .sort((a, b) => parseInt(a) - parseInt(b));
  console.log(`Pushing ${dirs.length} runs...`);
  for (const dir of dirs) {
    const runJsonPath = path.join(OUTPUTS_DIR, dir, "run.json");
    if (!fs.existsSync(runJsonPath)) continue;
    await pushRun(parseInt(dir));
  }
} else {
  for (const arg of args) {
    await pushRun(parseInt(arg));
  }
}
