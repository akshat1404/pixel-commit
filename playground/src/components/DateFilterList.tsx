import { useMemo, useState } from "react";

type Event = { id: number; title: string; date: string };

// ISO dates (YYYY-MM-DD) compare correctly as strings.
const EVENTS: Event[] = [
  { id: 1, title: "Project kickoff", date: "2026-01-12" },
  { id: 2, title: "Design review", date: "2026-02-03" },
  { id: 3, title: "Beta launch", date: "2026-03-18" },
  { id: 4, title: "Team offsite", date: "2026-04-22" },
  { id: 5, title: "Security audit", date: "2026-05-07" },
  { id: 6, title: "Public release", date: "2026-06-15" },
  { id: 7, title: "Retrospective", date: "2026-07-01" },
  { id: 8, title: "Roadmap planning", date: "2026-08-26" },
];

function formatDate(iso: string) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function DateFilterList() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const visible = useMemo(
    () => EVENTS.filter((e) => (!from || e.date >= from) && (!to || e.date <= to)),
    [from, to],
  );

  return (
    <section id="events" className="card">
      <h2>Events</h2>
      <div className="filters">
        <label className="field">
          <span>From</span>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            data-testid="filter-from"
          />
        </label>
        <label className="field">
          <span>To</span>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            data-testid="filter-to"
          />
        </label>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            setFrom("");
            setTo("");
          }}
          disabled={!from && !to}
          data-testid="filter-clear"
        >
          Clear
        </button>
      </div>
      <p className="muted" data-testid="event-count">
        Showing {visible.length} of {EVENTS.length} events
      </p>
      <ul className="event-list" data-testid="event-list">
        {visible.map((e) => (
          <li key={e.id} data-testid="event-item">
            <span>{e.title}</span>
            <time dateTime={e.date}>{formatDate(e.date)}</time>
          </li>
        ))}
        {visible.length === 0 && <li className="muted">No events in this range.</li>}
      </ul>
    </section>
  );
}
