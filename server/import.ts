import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { upsertRun, insertMetrics } from "./db.js";

const __dirname = typeof import.meta.dirname === "string" ? import.meta.dirname : path.dirname(fileURLToPath(import.meta.url));
const outputsDir = process.argv[2] || path.join(__dirname, "..", "..", "nanoGPT", "outputs");

if (!fs.existsSync(outputsDir)) {
  console.error(`Outputs directory not found: ${outputsDir}`);
  process.exit(1);
}

const dirs = fs.readdirSync(outputsDir).filter((d) => /^\d+$/.test(d)).sort((a, b) => parseInt(a) - parseInt(b));

console.log(`Found ${dirs.length} run directories in ${outputsDir}`);

let imported = 0;
for (const dir of dirs) {
  const runDir = path.join(outputsDir, dir);
  const runJsonPath = path.join(runDir, "run.json");
  const logJsonPath = path.join(runDir, "log.json");

  if (!fs.existsSync(runJsonPath)) continue;

  // Handle NaN/Infinity in JSON (Python outputs these)
  const rawJson = fs.readFileSync(runJsonPath, "utf-8").replace(/\bNaN\b/g, "null").replace(/\bInfinity\b/g, "null").replace(/\b-Infinity\b/g, "null");
  const runData = JSON.parse(rawJson);
  upsertRun({
    id: runData.run_id ?? parseInt(dir),
    config: runData.config ?? "",
    overrides: runData.overrides ?? [],
    git_sha: runData.git_sha ?? "",
    created_at: runData.created_at ?? "",
    iter_num: runData.iter_num,
    best_val_loss: runData.best_val_loss,
  });

  if (fs.existsSync(logJsonPath)) {
    const rawLog = fs.readFileSync(logJsonPath, "utf-8").replace(/\bNaN\b/g, "null").replace(/\bInfinity\b/g, "null").replace(/\b-Infinity\b/g, "null");
    const metrics = JSON.parse(rawLog);
    if (Array.isArray(metrics) && metrics.length > 0) {
      insertMetrics(runData.run_id ?? parseInt(dir), metrics);
    }
  }

  imported++;
  if (imported % 50 === 0) console.log(`  imported ${imported}/${dirs.length}...`);
}

console.log(`Imported ${imported} runs.`);
