import { useState } from "react";

type Stat = { label: string; value: string };

function fetchStats(): Promise<Stat[]> {
  return new Promise((resolve) =>
    setTimeout(
      () =>
        resolve([
          { label: "Commits this week", value: "42" },
          { label: "Tests recorded", value: "118" },
          { label: "Avg. video length", value: "24s" },
        ]),
      1500,
    ),
  );
}

export function DelayedSection() {
  const [state, setState] = useState<"idle" | "loading" | "done">("idle");
  const [stats, setStats] = useState<Stat[]>([]);

  async function load() {
    setState("loading");
    setStats(await fetchStats());
    setState("done");
  }

  return (
    <section id="stats" className="card">
      <h2>Stats</h2>
      {state === "idle" && (
        <button type="button" onClick={load} data-testid="stats-load">
          Load stats
        </button>
      )}
      {state === "loading" && (
        <p className="muted" data-testid="stats-loading">
          <span className="spinner" aria-hidden /> Loading...
        </p>
      )}
      {state === "done" && (
        <dl className="stats" data-testid="stats-list">
          {stats.map((s) => (
            <div key={s.label}>
              <dt>{s.label}</dt>
              <dd>{s.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
