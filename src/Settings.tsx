import { useState, useEffect } from "react";
import { api } from "./api";

export function Settings() {
  const [settings, setSettings] = useState<Record<string, any>>({});
  const [piApiKey, setPiApiKey] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    api("/settings").then(setSettings);
  }, []);

  const save = async (key: string, value: string) => {
    await api("/settings", { method: "PUT", body: JSON.stringify({ key, value }) });
    setMessage(`Saved ${key}`);
    setPiApiKey("");
    setApiToken("");
    api("/settings").then(setSettings);
    setTimeout(() => setMessage(""), 3000);
  };

  return (
    <div style={styles.container}>
      <h3 style={styles.title}>Settings</h3>
      {message && <p style={styles.message}>{message}</p>}

      <div style={styles.field}>
        <label style={styles.label}>Prime Intellect API Key</label>
        <p style={styles.hint}>
          {settings.pi_api_key_set
            ? `Currently set: ${settings.pi_api_key}`
            : "Not configured"}
        </p>
        <div style={styles.row}>
          <input
            style={styles.input}
            type="password"
            placeholder="Enter new API key..."
            value={piApiKey}
            onChange={(e) => setPiApiKey(e.target.value)}
          />
          <button style={styles.btn} onClick={() => save("pi_api_key", piApiKey)} disabled={!piApiKey}>
            Save
          </button>
        </div>
      </div>

      <div style={styles.field}>
        <label style={styles.label}>API Token (for push.ts / bridge.ts)</label>
        <p style={styles.hint}>
          {settings.api_token_set
            ? `Currently set: ${settings.api_token}`
            : "Not configured — push and bridge won't authenticate"}
        </p>
        <div style={styles.row}>
          <input
            style={styles.input}
            type="password"
            placeholder="Enter new token..."
            value={apiToken}
            onChange={(e) => setApiToken(e.target.value)}
          />
          <button style={styles.btn} onClick={() => save("api_token", apiToken)} disabled={!apiToken}>
            Save
          </button>
          <button
            style={styles.btnSecondary}
            onClick={() => {
              const token = crypto.randomUUID().replace(/-/g, "");
              setApiToken(token);
            }}
          >
            Generate
          </button>
        </div>
      </div>

      <div style={styles.field}>
        <label style={styles.label}>Bridge Setup</label>
        <p style={styles.hint}>
          Run this on your local machine (where pi.py lives) to connect toeDB to your GPU pods:
        </p>
        <pre style={styles.code}>
          {`TOEDB_URL=https://toedb.kavi.io TOEDB_TOKEN=<your-token> npm run bridge`}
        </pre>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { maxWidth: 600 },
  title: { margin: "0 0 20px", fontSize: 18, fontWeight: 600 },
  message: { padding: "8px 12px", background: "#dcfce7", color: "#166534", borderRadius: 4, fontSize: 13 },
  field: { marginBottom: 24 },
  label: { display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4 },
  hint: { fontSize: 12, color: "#6b7280", margin: "0 0 8px" },
  row: { display: "flex", gap: 8 },
  input: { flex: 1, padding: "6px 10px", border: "1px solid #d1d5db", borderRadius: 4, fontSize: 13 },
  btn: { padding: "6px 16px", background: "#2563eb", color: "white", border: "none", borderRadius: 4, cursor: "pointer", fontSize: 13 },
  btnSecondary: { padding: "6px 12px", background: "#f3f4f6", border: "1px solid #d1d5db", borderRadius: 4, cursor: "pointer", fontSize: 13 },
  code: { background: "#1e293b", color: "#e2e8f0", padding: 12, borderRadius: 6, fontSize: 12, overflow: "auto", whiteSpace: "pre-wrap" as const },
};
