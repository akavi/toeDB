export async function api(path: string, opts?: RequestInit) {
  const res = await fetch(`/toedb/api${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...opts?.headers },
  });
  if (res.status === 401) {
    window.location.reload();
    throw new Error("Unauthorized");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export type Run = {
  id: number;
  config: string;
  overrides: string;
  git_sha: string;
  created_at: string;
  iter_num: number | null;
  best_val_loss: number | null;
};

export type MetricRow = Record<string, number>;

export type AblationGroup = {
  id: number;
  name: string;
  description: string | null;
  created_at: string;
  run_ids: number[];
};
