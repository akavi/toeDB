import { useState, useEffect, useMemo } from "react";
import { api, MetricRow } from "./api";
import { LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from "recharts";

const COLORS = [
  "#2563eb", "#dc2626", "#16a34a", "#9333ea", "#ea580c",
  "#0891b2", "#4f46e5", "#be123c", "#15803d", "#a21caf",
  "#c2410c", "#0e7490", "#6d28d9", "#b91c1c", "#166534",
];

type RunData = { runId: number; data: MetricRow[]; keys: string[] };

export function RunChart({ runIds }: { runIds: number[] }) {
  const [runData, setRunData] = useState<RunData[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [allKeys, setAllKeys] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [smoothing, setSmoothing] = useState(1);
  const [logScale, setLogScale] = useState(false);

  useEffect(() => {
    if (runIds.length === 0) return;
    setLoading(true);
    Promise.all(
      runIds.map(async (id) => {
        const [data, keys] = await Promise.all([api(`/runs/${id}/metrics`), api(`/runs/${id}/metric-keys`)]);
        return { runId: id, data, keys } as RunData;
      })
    ).then((results) => {
      setRunData(results);
      const allK = [...new Set(results.flatMap((r) => r.keys))].filter((k) => k !== "iter");
      setAllKeys(allK);
      if (selectedKeys.length === 0 && allK.length > 0) {
        // Default to loss if available
        const defaultKey = allK.includes("loss") ? "loss" : allK[0];
        setSelectedKeys([defaultKey]);
      }
      setLoading(false);
    });
  }, [runIds]);

  const chartData = useMemo(() => {
    if (selectedKeys.length === 0 || runData.length === 0) return [];

    // For each run+key combo, apply smoothing then merge by iter
    const series: Array<{ name: string; points: Map<number, number> }> = [];

    for (const rd of runData) {
      for (const key of selectedKeys) {
        const raw = rd.data.filter((d) => d[key] !== undefined).map((d) => ({ iter: d.iter, val: d[key] }));
        if (raw.length === 0) continue;

        const smoothed = new Map<number, number>();
        for (let i = 0; i < raw.length; i++) {
          const start = Math.max(0, i - smoothing + 1);
          let sum = 0;
          for (let j = start; j <= i; j++) sum += raw[j].val;
          smoothed.set(raw[i].iter, sum / (i - start + 1));
        }
        const name = runData.length === 1 ? key : `${rd.runId}:${key}`;
        series.push({ name, points: smoothed });
      }
    }

    // Collect all unique iters
    const allIters = new Set<number>();
    for (const s of series) for (const iter of s.points.keys()) allIters.add(iter);
    const sortedIters = [...allIters].sort((a, b) => a - b);

    return sortedIters.map((iter) => {
      const row: Record<string, number> = { iter };
      for (const s of series) {
        const val = s.points.get(iter);
        if (val !== undefined) row[s.name] = logScale ? Math.log(val) : val;
      }
      return row;
    });
  }, [runData, selectedKeys, smoothing, logScale]);

  const seriesNames = useMemo(() => {
    const names: string[] = [];
    for (const rd of runData) {
      for (const key of selectedKeys) {
        const name = runData.length === 1 ? key : `${rd.runId}:${key}`;
        if (rd.data.some((d) => d[key] !== undefined)) names.push(name);
      }
    }
    return names;
  }, [runData, selectedKeys]);

  if (runIds.length === 0) return <p style={{ color: "#888" }}>Select runs from the Runs tab to chart them.</p>;
  if (loading) return <p style={{ color: "#888" }}>Loading metrics...</p>;

  return (
    <div>
      <div style={styles.controls}>
        <div style={styles.keyPicker}>
          <span style={styles.label}>Metrics:</span>
          {allKeys.map((k) => (
            <label key={k} style={styles.checkLabel}>
              <input
                type="checkbox"
                checked={selectedKeys.includes(k)}
                onChange={() =>
                  setSelectedKeys((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]))
                }
              />
              {k}
            </label>
          ))}
        </div>
        <div style={styles.sliderGroup}>
          <label style={styles.label}>
            Smooth: {smoothing}
            <input
              type="range"
              min={1}
              max={100}
              value={smoothing}
              onChange={(e) => setSmoothing(parseInt(e.target.value))}
              style={styles.slider}
            />
          </label>
          <label style={styles.checkLabel}>
            <input type="checkbox" checked={logScale} onChange={() => setLogScale(!logScale)} />
            Log scale
          </label>
        </div>
      </div>
      <div style={{ width: "100%", height: 500 }}>
        <ResponsiveContainer>
          <LineChart data={chartData}>
            <XAxis dataKey="iter" fontSize={11} />
            <YAxis fontSize={11} />
            <Tooltip contentStyle={{ fontSize: 12 }} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {seriesNames.map((name, i) => (
              <Line key={name} type="monotone" dataKey={name} stroke={COLORS[i % COLORS.length]} dot={false} strokeWidth={1.5} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  controls: { display: "flex", flexDirection: "column", gap: 12, marginBottom: 16, padding: 12, background: "#f8f9fa", borderRadius: 6 },
  keyPicker: { display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" },
  label: { fontSize: 12, fontWeight: 600, color: "#555" },
  checkLabel: { display: "flex", alignItems: "center", gap: 4, fontSize: 12, cursor: "pointer" },
  sliderGroup: { display: "flex", gap: 20, alignItems: "center" },
  slider: { width: 120, marginLeft: 8 },
};
