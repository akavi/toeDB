import { useState, useEffect } from "react";
import { api } from "./api";
import { Login } from "./Login";
import { RunList } from "./RunList";
import { RunChart } from "./RunChart";
import { PodView } from "./PodView";
import { Settings } from "./Settings";

export function App() {
  const [auth, setAuth] = useState<{ authenticated: boolean; needsSetup: boolean } | null>(null);
  const [view, setView] = useState<"runs" | "chart" | "pod" | "settings">("runs");
  const [selectedRuns, setSelectedRuns] = useState<number[]>([]);

  useEffect(() => {
    api("/auth/check").then(setAuth);
  }, []);

  if (!auth) return <div style={styles.loading}>Loading...</div>;
  if (auth.needsSetup || !auth.authenticated) {
    return <Login isSetup={auth.needsSetup} onSuccess={() => setAuth({ authenticated: true, needsSetup: false })} />;
  }

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <h1 style={styles.title}>toeDB</h1>
        <nav style={styles.nav}>
          <button style={view === "runs" ? styles.navActive : styles.navBtn} onClick={() => setView("runs")}>
            Runs
          </button>
          <button style={view === "chart" ? styles.navActive : styles.navBtn} onClick={() => setView("chart")}>
            Chart {selectedRuns.length > 0 && `(${selectedRuns.length})`}
          </button>
          <button style={view === "pod" ? styles.navActive : styles.navBtn} onClick={() => setView("pod")}>
            Pod
          </button>
          <button style={view === "settings" ? styles.navActive : styles.navBtn} onClick={() => setView("settings")}>
            Settings
          </button>
          <button
            style={styles.navBtn}
            onClick={() => {
              api("/auth/logout", { method: "POST" }).then(() => window.location.reload());
            }}
          >
            Logout
          </button>
        </nav>
      </header>
      <main style={styles.main}>
        {view === "runs" && (
          <RunList
            selectedRuns={selectedRuns}
            onSelectionChange={setSelectedRuns}
            onViewChart={(ids) => {
              setSelectedRuns(ids);
              setView("chart");
            }}
          />
        )}
        {view === "chart" && <RunChart runIds={selectedRuns} />}
        {view === "pod" && <PodView />}
        {view === "settings" && <Settings />}
      </main>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  loading: { padding: 40, textAlign: "center", fontFamily: "monospace", color: "#888" },
  container: { fontFamily: "system-ui, -apple-system, sans-serif", maxWidth: 1400, margin: "0 auto", padding: "0 20px" },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "1px solid #ddd", padding: "12px 0" },
  title: { margin: 0, fontSize: 20, fontWeight: 700 },
  nav: { display: "flex", gap: 8 },
  navBtn: { padding: "6px 14px", border: "1px solid #ccc", borderRadius: 4, background: "white", cursor: "pointer", fontSize: 13 },
  navActive: { padding: "6px 14px", border: "1px solid #333", borderRadius: 4, background: "#333", color: "white", cursor: "pointer", fontSize: 13 },
  main: { padding: "20px 0" },
};
