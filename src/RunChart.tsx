import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { api, Run, MetricRow, AblationGroup } from "./api";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

const COLORS = [
  "#2563eb", "#dc2626", "#16a34a", "#9333ea", "#ea580c",
  "#0891b2", "#4f46e5", "#be123c", "#15803d", "#a21caf",
  "#c2410c", "#0e7490", "#6d28d9", "#b91c1c", "#166534",
];

type RunData = { runId: number; data: MetricRow[]; keys: string[] };
type RunWithDistance = Run & { _distance?: number };

// Parse overrides JSON into a key-value map
function parseOverridesMap(overrides: string): Map<string, string> {
  try {
    const arr = JSON.parse(overrides || "[]") as string[];
    const map = new Map<string, string>();
    for (const o of arr) {
      const eq = o.indexOf("=");
      if (eq > 0) {
        map.set(o.slice(0, eq).replace(/^--/, ""), o.slice(eq + 1));
      } else {
        map.set(o.replace(/^--/, ""), "true");
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

function parseOverridesArray(s: string): string[] {
  try {
    return JSON.parse(s) as string[];
  } catch {
    return [];
  }
}

// Get all config params for a run (config + git_sha + overrides)
function getRunParams(run: Run): Map<string, string> {
  const params = new Map<string, string>();
  params.set("config", run.config || "");
  params.set("git_sha", run.git_sha || "");
  const overrides = parseOverridesMap(run.overrides);
  for (const [k, v] of overrides) params.set(k, v);
  return params;
}

// Find params that differ between a target run and another run
function getDifferingParams(target: Run, other: Run): Set<string> {
  const a = getRunParams(target);
  const b = getRunParams(other);
  const allKeys = new Set([...a.keys(), ...b.keys()]);
  const differing = new Set<string>();
  for (const k of allKeys) {
    if (a.get(k) !== b.get(k)) differing.add(k);
  }
  return differing;
}

export function RunChart({
  runIds,
  onRunIdsChange,
}: {
  runIds: number[];
  onRunIdsChange: (ids: number[]) => void;
}) {
  // Run data for charting
  const [runData, setRunData] = useState<RunData[]>([]);
  const [runDetails, setRunDetails] = useState<Map<number, Run>>(new Map());
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [allKeys, setAllKeys] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [smoothing, setSmoothing] = useState(1);
  const [logScale, setLogScale] = useState(false);

  // Hover & select state
  const [hoveredRunId, setHoveredRunId] = useState<number | null>(null);
  const [activeRunId, setActiveRunId] = useState<number | null>(null);

  // Multi-select (shift+click) state
  const [shiftSelectedIds, setShiftSelectedIds] = useState<Set<number>>(new Set());

  // Common params card toggle
  const [showCommonParams, setShowCommonParams] = useState(false);

  // Search pane state
  const [searchResults, setSearchResults] = useState<RunWithDistance[]>([]);
  const [searchAblationGroups, setSearchAblationGroups] = useState<AblationGroup[]>([]);
  const [activeRunAblationGroups, setActiveRunAblationGroups] = useState<AblationGroup[]>([]);
  const [searchText, setSearchText] = useState("");
  const [editDistance, setEditDistance] = useState(1);
  const [searchLoading, setSearchLoading] = useState(false);

  // Create ablation side panel
  const [showCreateAblation, setShowCreateAblation] = useState(false);
  const [ablationName, setAblationName] = useState("");
  const [ablationDesc, setAblationDesc] = useState("");
  const [ablationSaving, setAblationSaving] = useState(false);

  // highlighted run = hovered or active (only when not multi-selecting)
  const isMultiSelect = shiftSelectedIds.size > 1;
  const highlightedRunId = isMultiSelect ? null : (hoveredRunId ?? activeRunId);

  // Load run details & metrics
  useEffect(() => {
    if (runIds.length === 0) {
      setRunData([]);
      setRunDetails(new Map());
      setLoading(false);
      return;
    }
    setLoading(true);
    Promise.all(
      runIds.map(async (id) => {
        const [data, keys, run] = await Promise.all([
          api(`/runs/${id}/metrics`),
          api(`/runs/${id}/metric-keys`),
          api(`/runs/${id}`),
        ]);
        return { runId: id, data, keys, run } as RunData & { run: Run };
      })
    ).then((results) => {
      setRunData(results.map(({ runId, data, keys }) => ({ runId, data, keys })));
      const detailsMap = new Map<number, Run>();
      for (const r of results) detailsMap.set(r.runId, r.run);
      setRunDetails(detailsMap);
      const allK = [...new Set(results.flatMap((r) => r.keys))].filter((k) => k !== "iter");
      setAllKeys(allK);
      if (selectedKeys.length === 0 && allK.length > 0) {
        const defaultKey = allK.includes("loss") ? "loss" : allK[0];
        setSelectedKeys([defaultKey]);
      }
      setLoading(false);
    });
  }, [runIds]);

  // Load all runs + ablation groups on mount
  useEffect(() => {
    setSearchLoading(true);
    Promise.all([api("/runs"), api("/ablation-groups")])
      .then(([runs, groups]: [RunWithDistance[], AblationGroup[]]) => {
        setSearchResults(runs.filter((r) => !runIds.includes(r.id)));
        setSearchAblationGroups(groups);
        setSearchLoading(false);
      })
      .catch(() => setSearchLoading(false));
  }, []);

  // When active run changes, search for nearby runs or revert to all runs
  useEffect(() => {
    if (activeRunId === null) {
      setSearchText("");
      setActiveRunAblationGroups([]);
      setSearchLoading(true);
      Promise.all([api("/runs"), api("/ablation-groups")])
        .then(([runs, groups]: [RunWithDistance[], AblationGroup[]]) => {
          setSearchResults(runs.filter((r) => !runIds.includes(r.id)));
          setSearchAblationGroups(groups);
          setSearchLoading(false);
        })
        .catch(() => setSearchLoading(false));
      return;
    }
    setSearchLoading(true);
    Promise.all([
      api(`/runs/${activeRunId}/nearby?distance=${editDistance}`),
      api(`/runs/${activeRunId}/ablation-groups`),
    ])
      .then(([results, groups]: [RunWithDistance[], AblationGroup[]]) => {
        setSearchResults(results);
        setActiveRunAblationGroups(groups);
        setSearchLoading(false);
      })
      .catch(() => setSearchLoading(false));
  }, [activeRunId, editDistance]);

  // Manual text search
  const searchTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);
  const doTextSearch = useCallback(
    (text: string) => {
      setSearchText(text);
      if (searchTimeout.current) clearTimeout(searchTimeout.current);
      if (!text && !activeRunId) {
        setSearchLoading(true);
        Promise.all([api("/runs"), api("/ablation-groups")])
          .then(([runs, groups]: [Run[], AblationGroup[]]) => {
            setSearchResults(runs.filter((r) => !runIds.includes(r.id)));
            setSearchAblationGroups(groups);
            setSearchLoading(false);
          })
          .catch(() => setSearchLoading(false));
        return;
      }
      searchTimeout.current = setTimeout(() => {
        if (!text) {
          // Revert to edit-distance search if active run
          if (activeRunId) {
            setSearchLoading(true);
            Promise.all([
              api(`/runs/${activeRunId}/nearby?distance=${editDistance}`),
              api(`/runs/${activeRunId}/ablation-groups`),
            ])
              .then(([results, groups]: [RunWithDistance[], AblationGroup[]]) => {
                setSearchResults(results);
                setActiveRunAblationGroups(groups);
              })
              .finally(() => setSearchLoading(false));
          }
          return;
        }
        setSearchLoading(true);
        Promise.all([
          api(`/runs?q=${encodeURIComponent(text)}`),
          api(`/ablation-groups?q=${encodeURIComponent(text)}`),
        ])
          .then(([runs, groups]: [Run[], AblationGroup[]]) => {
            setSearchResults(runs.filter((r) => !runIds.includes(r.id)));
            setSearchAblationGroups(groups);
            setSearchLoading(false);
          })
          .catch(() => setSearchLoading(false));
      }, 300);
    },
    [activeRunId, editDistance, runIds]
  );

  // Params that differ across ALL selected runs
  const globalDifferingParams = useMemo(() => {
    const runs = runIds.map((id) => runDetails.get(id)).filter(Boolean) as Run[];
    if (runs.length < 2) return new Set<string>();
    const allParams = runs.map((r) => getRunParams(r));
    const allKeys = new Set(allParams.flatMap((p) => [...p.keys()]));
    const differing = new Set<string>();
    for (const k of allKeys) {
      const values = new Set(allParams.map((p) => p.get(k) ?? ""));
      if (values.size > 1) differing.add(k);
    }
    return differing;
  }, [runIds, runDetails]);

  // Common params shared across all selected runs (for bottom card)
  const commonParams = useMemo(() => {
    const runs = runIds.map((id) => runDetails.get(id)).filter(Boolean) as Run[];
    if (runs.length < 2) return new Map<string, string>();
    const allParams = runs.map((r) => getRunParams(r));
    const allKeys = new Set(allParams.flatMap((p) => [...p.keys()]));
    const common = new Map<string, string>();
    for (const k of allKeys) {
      const values = new Set(allParams.map((p) => p.get(k) ?? ""));
      if (values.size === 1) common.set(k, allParams[0].get(k) ?? "");
    }
    return common;
  }, [runIds, runDetails]);

  // Differing params for highlighting (hover/active comparison)
  const differingParams = useMemo(() => {
    if (!highlightedRunId) return new Map<number, Set<string>>();
    const target = runDetails.get(highlightedRunId);
    if (!target) return new Map<number, Set<string>>();
    const result = new Map<number, Set<string>>();
    for (const [id, run] of runDetails) {
      if (id === highlightedRunId) continue;
      result.set(id, getDifferingParams(target, run));
    }
    return result;
  }, [highlightedRunId, runDetails]);

  // Chart data
  const chartData = useMemo(() => {
    if (selectedKeys.length === 0 || runData.length === 0) return [];
    const series: Array<{ name: string; points: Map<number, number> }> = [];
    for (const rd of runData) {
      for (const key of selectedKeys) {
        const raw = rd.data
          .filter((d) => d[key] !== undefined)
          .map((d) => ({ iter: d.iter, val: d[key] }));
        if (raw.length === 0) continue;
        const smoothed = new Map<number, number>();
        for (let i = 0; i < raw.length; i++) {
          const start = Math.max(0, i - smoothing + 1);
          let sum = 0;
          for (let j = start; j <= i; j++) sum += raw[j].val;
          smoothed.set(raw[i].iter, sum / (i - start + 1));
        }
        const name = `${rd.runId}:${key}`;
        series.push({ name, points: smoothed });
      }
    }
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

  const yDomain = useMemo(() => {
    if (chartData.length === 0) return [0, 1] as [number, number];
    let min = Infinity;
    let max = -Infinity;
    for (const row of chartData) {
      for (const [k, v] of Object.entries(row)) {
        if (k === "iter") continue;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    if (!isFinite(min)) return [0, 1] as [number, number];
    const range = max - min || Math.abs(max) || 1;
    const pad = range * 0.2;
    return [min - pad, max + pad] as [number, number];
  }, [chartData]);

  const seriesNames = useMemo(() => {
    const names: string[] = [];
    for (const rd of runData) {
      for (const key of selectedKeys) {
        const name = `${rd.runId}:${key}`;
        if (rd.data.some((d) => d[key] !== undefined)) names.push(name);
      }
    }
    return names;
  }, [runData, selectedKeys]);

  const getRunColor = (runId: number) => {
    const idx = runIds.indexOf(runId);
    return COLORS[idx % COLORS.length];
  };

  const removeRun = (id: number) => {
    onRunIdsChange(runIds.filter((r) => r !== id));
    if (activeRunId === id) setActiveRunId(null);
    setShiftSelectedIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const addRun = (id: number) => {
    if (!runIds.includes(id)) {
      onRunIdsChange([...runIds, id]);
    }
  };

  const addAblationGroupRuns = (group: AblationGroup) => {
    const newIds = group.run_ids.filter((id) => !runIds.includes(id));
    if (newIds.length > 0) {
      onRunIdsChange([...runIds, ...newIds]);
    }
  };

  const handleRunClick = (id: number, e: React.MouseEvent) => {
    if (e.shiftKey) {
      e.preventDefault();
      setShiftSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    } else {
      setShiftSelectedIds(new Set());
      setActiveRunId(activeRunId === id ? null : id);
    }
  };

  const handleCreateAblation = async () => {
    if (!ablationName.trim()) return;
    const idsToUse = shiftSelectedIds.size > 0 ? [...shiftSelectedIds] : runIds;
    if (idsToUse.length === 0) return;
    setAblationSaving(true);
    try {
      await api("/ablation-groups", {
        method: "POST",
        body: JSON.stringify({
          name: ablationName.trim(),
          description: ablationDesc.trim() || null,
          run_ids: idsToUse,
        }),
      });
      setAblationName("");
      setAblationDesc("");
      setShowCreateAblation(false);
      setShiftSelectedIds(new Set());
      // Refresh ablation groups in search
      const groups = await api("/ablation-groups");
      setSearchAblationGroups(groups);
    } catch (err) {
      console.error("Failed to create ablation group:", err);
    } finally {
      setAblationSaving(false);
    }
  };

  // Compute differing params for search results vs active run
  const searchDiffParams = useMemo(() => {
    if (!activeRunId) return new Map<number, Set<string>>();
    const target = runDetails.get(activeRunId);
    if (!target) return new Map<number, Set<string>>();
    const result = new Map<number, Set<string>>();
    for (const run of searchResults) {
      result.set(run.id, getDifferingParams(target, run));
    }
    return result;
  }, [activeRunId, runDetails, searchResults]);

  // Merge runs and ablation groups for search display, sorted by creation time
  type SearchItem =
    | { type: "run"; run: RunWithDistance; time: string }
    | { type: "ablation"; group: AblationGroup; time: string };

  const mergedSearchResults = useMemo(() => {
    const items: SearchItem[] = [];
    // When active run is selected, show its ablation groups + edit distance runs
    const groupsToShow = activeRunId ? activeRunAblationGroups : searchAblationGroups;
    for (const run of searchResults) {
      items.push({ type: "run", run, time: run.created_at || "" });
    }
    for (const group of groupsToShow) {
      items.push({ type: "ablation", group, time: group.created_at || "" });
    }
    items.sort((a, b) => (b.time > a.time ? 1 : b.time < a.time ? -1 : 0));
    return items;
  }, [searchResults, searchAblationGroups, activeRunAblationGroups, activeRunId]);

  const hasRuns = runIds.length > 0;

  return (
    <div style={styles.container}>
      {/* Pane 1: Search */}
      <div style={hasRuns ? styles.searchPane : styles.searchPaneFull}>
        <div style={styles.paneHeader}>Search</div>
        <input
          style={styles.searchInput}
          placeholder="Search runs..."
          value={searchText}
          onChange={(e) => doTextSearch(e.target.value)}
        />
        {activeRunId && (
          <div style={styles.editDistRow}>
            <label style={styles.smallLabel}>Edit distance:</label>
            <input
              type="number"
              min={0}
              max={20}
              value={editDistance}
              onChange={(e) => setEditDistance(Math.max(0, parseInt(e.target.value) || 0))}
              style={styles.editDistInput}
            />
            {!searchText && (
              <span style={styles.editDistHint}>from run {activeRunId}</span>
            )}
          </div>
        )}
        <div style={styles.searchResultsList}>
          {searchLoading && <div style={styles.loadingText}>Loading...</div>}
          {!searchLoading && mergedSearchResults.length === 0 && activeRunId && !searchText && (
            <div style={styles.loadingText}>No runs within distance {editDistance}</div>
          )}
          {!searchLoading && mergedSearchResults.length === 0 && !activeRunId && !searchText && (
            <div style={styles.loadingText}>No runs found</div>
          )}
          {mergedSearchResults.map((item) => {
            if (item.type === "ablation") {
              const group = item.group;
              return (
                <div
                  key={`ag-${group.id}`}
                  style={{ ...styles.searchResultItem, borderLeft: "3px solid #9333ea" }}
                  onClick={() => addAblationGroupRuns(group)}
                >
                  <div style={styles.searchResultHeader}>
                    <span style={{ ...styles.searchResultId, color: "#9333ea" }}>
                      {group.name}
                    </span>
                    <span style={styles.ablationBadge}>
                      ablation ({group.run_ids.length} runs)
                    </span>
                  </div>
                  {group.description && (
                    <div style={styles.searchResultConfig}>{group.description}</div>
                  )}
                  <div style={styles.searchResultOverrides}>
                    {group.run_ids.map((rid) => (
                      <span key={rid} style={{
                        ...styles.tag,
                        ...(runIds.includes(rid) ? { background: "#dcfce7" } : {}),
                      }}>#{rid}</span>
                    ))}
                  </div>
                </div>
              );
            }
            const run = item.run;
            const diffs = !isMultiSelect ? searchDiffParams.get(run.id) : undefined;
            return (
              <div
                key={run.id}
                style={styles.searchResultItem}
                onClick={() => addRun(run.id)}
              >
                <div style={styles.searchResultHeader}>
                  <span style={styles.searchResultId}>#{run.id}</span>
                  {run._distance !== undefined && (
                    <span style={styles.distanceBadge}>d={run._distance}</span>
                  )}
                  {runIds.includes(run.id) && (
                    <span style={styles.addedBadge}>added</span>
                  )}
                </div>
                <div style={{
                  ...styles.searchResultConfig,
                  ...(diffs?.has("config") ? styles.diffHighlight : {}),
                }}>{run.config}</div>
                <div style={styles.searchResultOverrides}>
                  {parseOverridesArray(run.overrides).map((o, i) => {
                    const key = o.indexOf("=") > 0
                      ? o.slice(0, o.indexOf("=")).replace(/^--/, "")
                      : o.replace(/^--/, "");
                    return (
                      <span key={i} style={{
                        ...styles.tag,
                        ...(diffs?.has(key) ? styles.diffHighlight : {}),
                      }}>{o}</span>
                    );
                  })}
                </div>
                {run.git_sha && (
                  <div style={{
                    ...styles.searchResultSha,
                    ...(diffs?.has("git_sha") ? styles.diffHighlight : {}),
                  }}>{run.git_sha.slice(0, 8)}</div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Pane 2: Selected Runs */}
      {hasRuns && <div style={styles.selectedPane}>
        <div style={styles.paneHeader}>
          <span>Selected Runs ({runIds.length}){shiftSelectedIds.size > 0 && ` · ${shiftSelectedIds.size} selected`}</span>
          <button
            style={styles.createAblationBtn}
            onClick={() => setShowCreateAblation(true)}
            title="Create ablation group"
          >
            + Ablation
          </button>
        </div>
        <div style={styles.selectedRunsList}>
          {runIds.map((id) => {
            const run = runDetails.get(id);
            const color = getRunColor(id);
            const isHighlighted = highlightedRunId === id;
            const isActive = activeRunId === id;
            const diffParams = highlightedRunId && highlightedRunId !== id
              ? differingParams.get(id)
              : null;
            const params = run ? getRunParams(run) : new Map();
            const isShiftSelected = shiftSelectedIds.has(id);
            const hasDiffs = !isMultiSelect && globalDifferingParams.size > 0;
            const visibleEntries = hasDiffs
              ? [...params.entries()].filter(([k]) => globalDifferingParams.has(k))
              : isMultiSelect ? [] : [...params.entries()];

            return (
              <div
                key={id}
                style={{
                  ...styles.selectedRunItem,
                  borderLeft: `4px solid ${color}`,
                  background: isShiftSelected ? "#ede9fe" : isActive ? "#e8f0fe" : isHighlighted ? "#f3f4f6" : "white",
                }}
                onMouseEnter={() => setHoveredRunId(id)}
                onMouseLeave={() => setHoveredRunId(null)}
                onClick={(e) => handleRunClick(id, e)}
              >
                <div style={styles.selectedRunHeader}>
                  <span style={{ ...styles.runNumber, color }}>#{id}</span>
                  <button
                    style={styles.removeBtn}
                    onClick={(e) => {
                      e.stopPropagation();
                      removeRun(id);
                    }}
                    title="Remove run"
                  >
                    x
                  </button>
                </div>
                {run && (
                  <div style={styles.paramsList}>
                    {visibleEntries.map(([k, v]) => {
                      const isHoverDiff = diffParams?.has(k);
                      return (
                        <div
                          key={k}
                          style={{
                            ...styles.paramRow,
                            background: isHoverDiff ? "#fef3c7" : "transparent",
                            borderRadius: isHoverDiff ? 3 : 0,
                          }}
                        >
                          <span style={styles.paramKey}>{k}</span>
                          <span style={styles.paramVal}>{v}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {commonParams.size > 0 && (
          <div style={styles.commonCard}>
            <button
              style={styles.commonCardToggle}
              onClick={() => setShowCommonParams(!showCommonParams)}
            >
              <span>Common params ({commonParams.size})</span>
              <span>{showCommonParams ? "\u25BC" : "\u25B6"}</span>
            </button>
            {showCommonParams && (
              <div style={styles.commonCardBody}>
                {[...commonParams.entries()].map(([k, v]) => (
                  <div key={k} style={styles.paramRow}>
                    <span style={styles.paramKey}>{k}</span>
                    <span style={styles.paramVal}>{v}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>}

      {/* Pane 3: Graph */}
      {hasRuns && <div style={{ ...styles.graphPane, position: "relative" as const }}>
        {/* Create Ablation Slide-over Panel */}
        {showCreateAblation && (
          <div style={styles.ablationPanel}>
            <div style={styles.paneHeader}>
              <span>Create Ablation Group</span>
              <button
                style={styles.removeBtn}
                onClick={() => { setShowCreateAblation(false); setAblationName(""); setAblationDesc(""); }}
              >x</button>
            </div>
            <div style={styles.ablationForm}>
              <div style={styles.ablationInfo}>
                {shiftSelectedIds.size > 0
                  ? `${shiftSelectedIds.size} runs selected`
                  : `All ${runIds.length} runs`}
              </div>
              <label style={styles.smallLabel}>Name *</label>
              <input
                style={styles.searchInput}
                placeholder="Ablation group name..."
                value={ablationName}
                onChange={(e) => setAblationName(e.target.value)}
                autoFocus
              />
              <label style={styles.smallLabel}>Description</label>
              <textarea
                style={styles.ablationTextarea}
                placeholder="Optional description..."
                value={ablationDesc}
                onChange={(e) => setAblationDesc(e.target.value)}
                rows={3}
              />
              <div style={styles.ablationRunList}>
                {(shiftSelectedIds.size > 0 ? [...shiftSelectedIds] : runIds).map((id) => (
                  <span key={id} style={styles.tag}>#{id}</span>
                ))}
              </div>
              <button
                style={{
                  ...styles.ablationSubmitBtn,
                  opacity: ablationName.trim() ? 1 : 0.5,
                }}
                disabled={!ablationName.trim() || ablationSaving}
                onClick={handleCreateAblation}
              >
                {ablationSaving ? "Creating..." : "Create"}
              </button>
            </div>
          </div>
        )}
        <div style={styles.controls}>
          <div style={styles.keyPicker}>
            <span style={styles.label}>Metrics:</span>
            {allKeys.map((k) => (
              <label key={k} style={styles.checkLabel}>
                <input
                  type="checkbox"
                  checked={selectedKeys.includes(k)}
                  onChange={() =>
                    setSelectedKeys((prev) =>
                      prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]
                    )
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
        {loading ? (
          <p style={{ color: "#888" }}>Loading metrics...</p>
        ) : (
          <div style={{ width: "100%", flex: 1, minHeight: 400 }}>
            <ResponsiveContainer>
              <LineChart data={chartData}>
                <XAxis dataKey="iter" fontSize={11} />
                <YAxis
                  fontSize={11}
                  domain={yDomain}
                  allowDataOverflow
                  tickFormatter={(v: number) => {
                    const abs = Math.abs(v);
                    if (abs === 0) return "0";
                    if (abs >= 1000) return v.toFixed(0);
                    if (abs >= 1) return v.toPrecision(4);
                    return v.toPrecision(3);
                  }}
                />
                <Tooltip contentStyle={{ fontSize: 12 }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {seriesNames.map((name) => {
                  const seriesRunId = parseInt(name.split(":")[0]);
                  const isHighlightedSeries =
                    highlightedRunId !== null && seriesRunId === highlightedRunId;
                  const isDimmed =
                    highlightedRunId !== null && seriesRunId !== highlightedRunId;
                  return (
                    <Line
                      key={name}
                      type="monotone"
                      dataKey={name}
                      stroke={COLORS[runIds.indexOf(seriesRunId) % COLORS.length]}
                      dot={false}
                      strokeWidth={isHighlightedSeries ? 3 : 1.5}
                      strokeOpacity={isDimmed ? 0.2 : 1}
                    />
                  );
                })}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>}

    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    gap: 0,
    height: "calc(100vh - 100px)",
    border: "1px solid #ddd",
    borderRadius: 6,
    overflow: "hidden",
  },
  // Pane 1: Search (25%, or full width when no runs selected)
  searchPane: {
    width: "25%",
    minWidth: 220,
    borderRight: "1px solid #ddd",
    display: "flex",
    flexDirection: "column",
    background: "#fafafa",
  },
  searchPaneFull: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    background: "#fafafa",
  },
  paneHeader: {
    padding: "10px 12px",
    fontWeight: 600,
    fontSize: 13,
    borderBottom: "1px solid #ddd",
    background: "#f3f4f6",
    height: 40,
    boxSizing: "border-box" as const,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexShrink: 0,
  },
  searchInput: {
    margin: "8px",
    padding: "6px 10px",
    border: "1px solid #ccc",
    borderRadius: 4,
    fontSize: 13,
  },
  editDistRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "0 8px 8px",
    fontSize: 12,
  },
  smallLabel: { color: "#666", whiteSpace: "nowrap" as const },
  editDistInput: {
    width: 48,
    padding: "3px 6px",
    border: "1px solid #ccc",
    borderRadius: 3,
    fontSize: 12,
  },
  editDistHint: {
    color: "#999",
    fontSize: 11,
    fontStyle: "italic",
  },
  searchResultsList: {
    flex: 1,
    overflowY: "auto" as const,
    padding: "0 4px",
  },
  loadingText: { padding: 12, color: "#888", fontSize: 12, fontStyle: "italic" },
  searchResultItem: {
    padding: "8px",
    margin: "4px",
    background: "white",
    borderRadius: 4,
    border: "1px solid #e5e7eb",
    cursor: "pointer",
    fontSize: 12,
  },
  searchResultHeader: { display: "flex", alignItems: "center", gap: 6, marginBottom: 4 },
  searchResultId: { fontWeight: 600 },
  distanceBadge: {
    fontSize: 10,
    background: "#dbeafe",
    color: "#1d4ed8",
    padding: "1px 5px",
    borderRadius: 3,
  },
  addedBadge: {
    fontSize: 10,
    background: "#dcfce7",
    color: "#166534",
    padding: "1px 5px",
    borderRadius: 3,
  },
  searchResultConfig: { fontFamily: "monospace", fontSize: 11, color: "#555", marginBottom: 2 },
  searchResultOverrides: { display: "flex", flexWrap: "wrap" as const, gap: 3 },
  searchResultSha: { fontFamily: "monospace", fontSize: 10, color: "#999", marginTop: 2 },
  tag: {
    display: "inline-block",
    background: "#f0f0f0",
    borderRadius: 3,
    padding: "1px 5px",
    fontFamily: "monospace",
    fontSize: 10,
  },
  diffHighlight: {
    background: "#fef3c7",
    borderRadius: 3,
  },

  // Pane 2: Selected Runs (25%)
  selectedPane: {
    width: "25%",
    minWidth: 220,
    borderRight: "1px solid #ddd",
    display: "flex",
    flexDirection: "column",
    background: "#fafafa",
  },
  selectedRunsList: {
    flex: 1,
    overflowY: "auto" as const,
    padding: 4,
  },
  selectedRunItem: {
    padding: "8px 8px 8px 12px",
    margin: "4px",
    borderRadius: 4,
    border: "1px solid #e5e7eb",
    cursor: "pointer",
    fontSize: 12,
    transition: "background 0.1s",
  },
  selectedRunHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  runNumber: { fontWeight: 700, fontSize: 13 },
  removeBtn: {
    background: "none",
    border: "none",
    color: "#999",
    cursor: "pointer",
    fontSize: 14,
    fontWeight: 600,
    padding: "0 4px",
    lineHeight: 1,
  },
  paramsList: { display: "flex", flexDirection: "column" as const, gap: 1 },
  paramRow: {
    display: "flex",
    justifyContent: "space-between",
    padding: "1px 4px",
    gap: 8,
  },
  paramKey: { color: "#666", fontSize: 11, flexShrink: 0 },
  paramVal: {
    fontFamily: "monospace",
    fontSize: 11,
    color: "#333",
    textAlign: "right" as const,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  commonCard: {
    borderTop: "1px solid #ddd",
    background: "#f3f4f6",
    flexShrink: 0,
  },
  commonCardToggle: {
    width: "100%",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "8px 12px",
    background: "none",
    border: "none",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 600,
    color: "#555",
  },
  commonCardBody: {
    padding: "0 8px 8px",
    display: "flex",
    flexDirection: "column" as const,
    gap: 1,
  },

  // Pane 3: Graph (50%)
  graphPane: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    padding: 12,
    minWidth: 0,
  },
  controls: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 8,
    marginBottom: 12,
    padding: 10,
    background: "#f8f9fa",
    borderRadius: 6,
  },
  keyPicker: { display: "flex", flexWrap: "wrap" as const, gap: 8, alignItems: "center" },
  label: { fontSize: 12, fontWeight: 600, color: "#555" },
  checkLabel: { display: "flex", alignItems: "center", gap: 4, fontSize: 12, cursor: "pointer" },
  sliderGroup: { display: "flex", gap: 16, alignItems: "center" },
  slider: { width: 100, marginLeft: 6 },
  // Ablation group styles
  ablationBadge: {
    fontSize: 10,
    background: "#f3e8ff",
    color: "#7c3aed",
    padding: "1px 5px",
    borderRadius: 3,
  },
  createAblationBtn: {
    padding: "4px 10px",
    border: "1px solid #ccc",
    borderRadius: 4,
    background: "white",
    color: "#333",
    cursor: "pointer",
    fontSize: 11,
    fontWeight: 600,
    whiteSpace: "nowrap" as const,
  },
  ablationPanel: {
    position: "absolute" as const,
    top: 0,
    left: 0,
    width: 280,
    height: "100%",
    borderRight: "1px solid #ddd",
    display: "flex",
    flexDirection: "column" as const,
    background: "#fafafa",
    boxShadow: "4px 0 12px rgba(0,0,0,0.08)",
    zIndex: 10,
  },
  ablationForm: {
    padding: 12,
    display: "flex",
    flexDirection: "column" as const,
    gap: 8,
  },
  ablationInfo: {
    fontSize: 12,
    color: "#555",
    fontWeight: 600,
    padding: "4px 0",
  },
  ablationTextarea: {
    margin: 0,
    padding: "6px 10px",
    border: "1px solid #ccc",
    borderRadius: 4,
    fontSize: 13,
    fontFamily: "inherit",
    resize: "vertical" as const,
  },
  ablationRunList: {
    display: "flex",
    flexWrap: "wrap" as const,
    gap: 4,
    padding: "4px 0",
  },
  ablationSubmitBtn: {
    padding: "8px",
    border: "1px solid #ccc",
    borderRadius: 4,
    background: "#333",
    color: "white",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 600,
    width: "100%",
  },
};
