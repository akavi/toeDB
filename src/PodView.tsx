import { useState, useEffect, useCallback } from "react";
import { api } from "./api";

type PodState = {
  pod_id?: string;
  name?: string;
  ip?: string;
  port?: number;
  provider?: string;
  provisioning?: boolean;
  provision_error?: string;
  daemon_pid?: number;
  daemon_heartbeat?: number;
  commands_summary?: { total: number; pending: number; running: number };
  active_commands?: Record<string, any>;
  next_run_id?: number;
  last_run_id?: number;
  runs_count?: number;
};

type PodCommand = {
  id: number;
  type: string;
  config: string | null;
  overrides: string | null;
  run_id: number | null;
  status: string;
  error: string | null;
  created_at: string;
  completed_at: string | null;
};

export function PodView() {
  const [state, setState] = useState<PodState | null>(null);
  const [apiStatus, setApiStatus] = useState<any>(null);
  const [commands, setCommands] = useState<PodCommand[]>([]);
  const [loading, setLoading] = useState(true);

  // Train form
  const [config, setConfig] = useState("");
  const [overrides, setOverrides] = useState("");
  const [cmdType, setCmdType] = useState<"train" | "sample" | "resume">("train");
  const [sampleRunId, setSampleRunId] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [pod, cmds] = await Promise.all([api("/pod"), api("/pod/commands")]);
      setState(pod.state);
      setApiStatus(pod.apiStatus);
      setCommands(cmds);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 15000);
    return () => clearInterval(interval);
  }, [refresh]);

  const submitCommand = async () => {
    const body: any = { type: cmdType };
    if (cmdType === "train") {
      body.config = config;
      body.overrides = overrides.split(/\s+/).filter(Boolean);
    } else if (cmdType === "sample" || cmdType === "resume") {
      body.config = config || undefined;
      body.overrides = overrides.split(/\s+/).filter(Boolean);
      if (sampleRunId) body.run_id = parseInt(sampleRunId);
    }
    await api("/pod/commands", { method: "POST", body: JSON.stringify(body) });
    setConfig("");
    setOverrides("");
    setSampleRunId("");
    refresh();
  };

  if (loading) return <p style={{ color: "#888" }}>Loading pod state...</p>;

  const hasPod = !!state?.pod_id;
  const heartbeatAgo = state?.daemon_heartbeat
    ? Math.round((Date.now() / 1000 - state.daemon_heartbeat))
    : null;

  return (
    <div>
      {/* Pod Status */}
      <div style={styles.card}>
        <h3 style={styles.cardTitle}>Pod Status</h3>
        {hasPod ? (
          <div style={styles.grid}>
            <div>
              <span style={styles.label}>Name</span>
              <span style={styles.value}>{state!.name || state!.pod_id}</span>
            </div>
            <div>
              <span style={styles.label}>Provider</span>
              <span style={styles.value}>{state!.provider || "?"}</span>
            </div>
            <div>
              <span style={styles.label}>IP</span>
              <span style={styles.mono}>{state!.ip}:{state!.port}</span>
            </div>
            <div>
              <span style={styles.label}>API Status</span>
              <span style={styles.value}>{apiStatus?.status || "unknown"}</span>
            </div>
            <div>
              <span style={styles.label}>Daemon</span>
              <span style={styles.value}>
                {state!.daemon_pid ? `pid ${state!.daemon_pid}` : "not running"}
                {heartbeatAgo !== null && ` (${heartbeatAgo}s ago)`}
              </span>
            </div>
            {state!.commands_summary && (
              <div>
                <span style={styles.label}>Queue</span>
                <span style={styles.value}>
                  {state!.commands_summary.running} running, {state!.commands_summary.pending} pending
                </span>
              </div>
            )}
            {state!.provisioning && (
              <div>
                <span style={{ color: "#d97706" }}>Provisioning...</span>
              </div>
            )}
            {state!.provision_error && (
              <div>
                <span style={{ color: "#dc2626" }}>Error: {state!.provision_error}</span>
              </div>
            )}
            <div style={{ gridColumn: "1 / -1" }}>
              <button style={styles.dangerBtn} onClick={async () => {
                await api("/pod/commands", { method: "POST", body: JSON.stringify({ type: "down" }) });
                refresh();
              }}>
                Terminate Pod
              </button>
            </div>
          </div>
        ) : (
          <div>
            <p style={{ color: "#888", margin: "0 0 12px" }}>No pod running.</p>
            <button style={styles.primaryBtn} onClick={async () => {
              await api("/pod/commands", { method: "POST", body: JSON.stringify({ type: "up" }) });
              refresh();
            }}>
              Start Pod
            </button>
          </div>
        )}
      </div>

      {/* New Command */}
      <div style={styles.card}>
        <h3 style={styles.cardTitle}>Run Command</h3>
        <div style={styles.formRow}>
          <select style={styles.select} value={cmdType} onChange={(e) => setCmdType(e.target.value as any)}>
            <option value="train">Train</option>
            <option value="sample">Sample</option>
            <option value="resume">Resume</option>
          </select>
          {(cmdType === "sample" || cmdType === "resume") && (
            <input
              style={{ ...styles.input, width: 100 }}
              placeholder="Run ID"
              value={sampleRunId}
              onChange={(e) => setSampleRunId(e.target.value)}
            />
          )}
          <input
            style={styles.input}
            placeholder="Config (e.g. config/train_shakespeare_char.py)"
            value={config}
            onChange={(e) => setConfig(e.target.value)}
          />
        </div>
        <div style={styles.formRow}>
          <input
            style={{ ...styles.input, flex: 1 }}
            placeholder="Overrides (space-separated, e.g. --batch_size=32 --learning_rate=1e-4)"
            value={overrides}
            onChange={(e) => setOverrides(e.target.value)}
          />
          <button style={styles.primaryBtn} onClick={submitCommand}>
            Queue
          </button>
        </div>
      </div>

      {/* Command History */}
      <div style={styles.card}>
        <h3 style={styles.cardTitle}>Recent Commands</h3>
        {commands.length === 0 ? (
          <p style={{ color: "#888" }}>No commands yet.</p>
        ) : (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>ID</th>
                <th style={styles.th}>Type</th>
                <th style={styles.th}>Config</th>
                <th style={styles.th}>Run</th>
                <th style={styles.th}>Status</th>
                <th style={styles.th}>Created</th>
              </tr>
            </thead>
            <tbody>
              {commands.map((cmd) => (
                <tr key={cmd.id}>
                  <td style={styles.td}>{cmd.id}</td>
                  <td style={styles.td}>{cmd.type}</td>
                  <td style={{ ...styles.td, fontFamily: "monospace", fontSize: 11 }}>{cmd.config || "-"}</td>
                  <td style={styles.td}>{cmd.run_id ?? "-"}</td>
                  <td style={styles.td}>
                    <span style={{
                      ...styles.status,
                      background: cmd.status === "completed" ? "#dcfce7" : cmd.status === "failed" ? "#fee2e2" : cmd.status === "running" ? "#dbeafe" : "#f3f4f6",
                      color: cmd.status === "completed" ? "#166534" : cmd.status === "failed" ? "#991b1b" : cmd.status === "running" ? "#1e40af" : "#374151",
                    }}>{cmd.status}</span>
                  </td>
                  <td style={{ ...styles.td, fontSize: 11, color: "#666" }}>{cmd.created_at}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: { border: "1px solid #e5e7eb", borderRadius: 8, padding: 20, marginBottom: 16 },
  cardTitle: { margin: "0 0 16px", fontSize: 16, fontWeight: 600 },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12 },
  label: { display: "block", fontSize: 11, color: "#6b7280", textTransform: "uppercase" as const, marginBottom: 2 },
  value: { fontSize: 14 },
  mono: { fontSize: 13, fontFamily: "monospace" },
  formRow: { display: "flex", gap: 8, marginBottom: 8 },
  input: { padding: "6px 10px", border: "1px solid #d1d5db", borderRadius: 4, fontSize: 13, flex: 1 },
  select: { padding: "6px 10px", border: "1px solid #d1d5db", borderRadius: 4, fontSize: 13 },
  primaryBtn: { padding: "6px 16px", background: "#2563eb", color: "white", border: "none", borderRadius: 4, cursor: "pointer", fontSize: 13, whiteSpace: "nowrap" as const },
  dangerBtn: { padding: "6px 16px", background: "#dc2626", color: "white", border: "none", borderRadius: 4, cursor: "pointer", fontSize: 13 },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left" as const, padding: "6px 8px", borderBottom: "2px solid #e5e7eb", fontSize: 11, color: "#6b7280", textTransform: "uppercase" as const },
  td: { padding: "6px 8px", borderBottom: "1px solid #f3f4f6" },
  status: { display: "inline-block", padding: "2px 8px", borderRadius: 10, fontSize: 11, fontWeight: 500 },
};
