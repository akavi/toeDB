import { useState } from "react";
import { api } from "./api";

export function Login({ isSetup, onSuccess }: { isSetup: boolean; onSuccess: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      const endpoint = isSetup ? "/auth/register" : "/auth/login";
      await api(endpoint, { method: "POST", body: JSON.stringify({ username, password }) });
      onSuccess();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div style={styles.wrapper}>
      <form onSubmit={submit} style={styles.form}>
        <h2 style={styles.title}>{isSetup ? "Create Account" : "Login"}</h2>
        {isSetup && <p style={styles.hint}>First time setup — create your admin account.</p>}
        {error && <p style={styles.error}>{error}</p>}
        <input style={styles.input} placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
        <input style={styles.input} type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button style={styles.button} type="submit">
          {isSetup ? "Create Account" : "Login"}
        </button>
      </form>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: { display: "flex", justifyContent: "center", alignItems: "center", minHeight: "100vh", fontFamily: "system-ui" },
  form: { display: "flex", flexDirection: "column", gap: 12, width: 320, padding: 32, border: "1px solid #ddd", borderRadius: 8 },
  title: { margin: 0, fontSize: 20 },
  hint: { margin: 0, fontSize: 13, color: "#666" },
  error: { margin: 0, fontSize: 13, color: "#c00", background: "#fee", padding: "6px 10px", borderRadius: 4 },
  input: { padding: "8px 12px", border: "1px solid #ccc", borderRadius: 4, fontSize: 14 },
  button: { padding: "8px 16px", background: "#333", color: "white", border: "none", borderRadius: 4, cursor: "pointer", fontSize: 14 },
};
