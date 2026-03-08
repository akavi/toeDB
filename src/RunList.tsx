import { useState, useEffect } from "react";
import { api, Run } from "./api";

type Props = {
  selectedRuns: number[];
  onSelectionChange: (ids: number[]) => void;
  onViewChart: (ids: number[]) => void;
};

export function RunList({ selectedRuns, onSelectionChange, onViewChart }: Props) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const timeout = setTimeout(() => {
      setLoading(true);
      api(`/runs${search ? `?q=${encodeURIComponent(search)}` : ""}`)
        .then(setRuns)
        .finally(() => setLoading(false));
    }, search ? 300 : 0);
    return () => clearTimeout(timeout);
  }, [search]);

  const toggle = (id: number) => {
    onSelectionChange(
      selectedRuns.includes(id) ? selectedRuns.filter((r) => r !== id) : [...selectedRuns, id]
    );
  };

  const parseOverrides = (s: string) => {
    try {
      return JSON.parse(s) as string[];
    } catch {
      return [];
    }
  };

  return (
    <div>
      <div style={styles.toolbar}>
        <input
          style={styles.search}
          placeholder="Search runs (config, overrides)..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {selectedRuns.length > 0 && (
          <button style={styles.chartBtn} onClick={() => onViewChart(selectedRuns)}>
            Chart selected ({selectedRuns.length})
          </button>
        )}
      </div>
      {loading ? (
        <p style={styles.loading}>Loading...</p>
      ) : (
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}></th>
              <th style={styles.th}>ID</th>
              <th style={styles.th}>Config</th>
              <th style={styles.th}>Overrides</th>
              <th style={styles.th}>Iters</th>
              <th style={styles.th}>Best Val Loss</th>
              <th style={styles.th}>Created</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.id} style={selectedRuns.includes(run.id) ? styles.selectedRow : styles.row}>
                <td style={styles.td}>
                  <input type="checkbox" checked={selectedRuns.includes(run.id)} onChange={() => toggle(run.id)} />
                </td>
                <td style={styles.td}>{run.id}</td>
                <td style={{ ...styles.td, ...styles.config }}>{run.config}</td>
                <td style={{ ...styles.td, ...styles.overrides }}>
                  {parseOverrides(run.overrides).map((o, i) => (
                    <span key={i} style={styles.tag}>
                      {o}
                    </span>
                  ))}
                </td>
                <td style={styles.td}>{run.iter_num ?? "-"}</td>
                <td style={styles.td}>{run.best_val_loss != null ? run.best_val_loss.toFixed(4) : "-"}</td>
                <td style={{ ...styles.td, ...styles.date }}>
                  {run.created_at ? new Date(run.created_at).toLocaleDateString() : "-"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  toolbar: { display: "flex", gap: 12, marginBottom: 16, alignItems: "center" },
  search: { flex: 1, padding: "8px 12px", border: "1px solid #ccc", borderRadius: 4, fontSize: 14 },
  chartBtn: { padding: "8px 16px", background: "#2563eb", color: "white", border: "none", borderRadius: 4, cursor: "pointer", fontSize: 13, whiteSpace: "nowrap" },
  loading: { color: "#888", fontStyle: "italic" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", padding: "8px 10px", borderBottom: "2px solid #ddd", fontWeight: 600, fontSize: 12, color: "#666", textTransform: "uppercase" as const },
  td: { padding: "6px 10px", borderBottom: "1px solid #eee" },
  row: {},
  selectedRow: { background: "#eff6ff" },
  config: { fontFamily: "monospace", fontSize: 12 },
  overrides: { fontSize: 11 },
  tag: { display: "inline-block", background: "#f0f0f0", borderRadius: 3, padding: "1px 6px", marginRight: 4, marginBottom: 2, fontFamily: "monospace" },
  date: { fontSize: 12, color: "#666", whiteSpace: "nowrap" as const },
};
