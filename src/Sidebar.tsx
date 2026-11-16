import { useState } from "react";
import type { MapSummary } from "./api.ts";

const ago = (t: number) => {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
};

export const mapTitle = (m: Pick<MapSummary, "title" | "firstQuestion">) => m.title || m.firstQuestion || "Untitled map";

export function Sidebar(props: {
  maps: MapSummary[] | null;
  currentId: string | null;
  onOpen: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string | null) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <strong>Your maps</strong>
        <button className="icon-btn" title="Close" onClick={props.onClose}>
          ×
        </button>
      </div>
      <button className="new-map" onClick={props.onNew}>
        + New map
      </button>
      <ul className="map-list">
        {props.maps === null && <li className="map-empty">Loading…</li>}
        {props.maps?.length === 0 && <li className="map-empty">No saved maps yet. Ask a question to start one.</li>}
        {props.maps?.map((m) => (
          <li key={m.id} className={`map-item ${m.id === props.currentId ? "is-current" : ""}`}>
            {editing === m.id ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  props.onRename(m.id, draft.trim() || null);
                  setEditing(null);
                }}
              >
                <input
                  autoFocus
                  value={draft}
                  placeholder={m.firstQuestion ?? "Map title"}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => e.key === "Escape" && setEditing(null)}
                  onBlur={() => setEditing(null)}
                />
              </form>
            ) : confirming === m.id ? (
              <div className="map-confirm">
                <span>Delete “{mapTitle(m)}”?</span>
                <button className="danger" onClick={() => (props.onDelete(m.id), setConfirming(null))}>
                  Delete
                </button>
                <button className="link" onClick={() => setConfirming(null)}>
                  Cancel
                </button>
              </div>
            ) : (
              <>
                <button className="map-open" onClick={() => props.onOpen(m.id)}>
                  <span className="map-title">{mapTitle(m)}</span>
                  <span className="map-meta">
                    {m.answers} {m.answers === 1 ? "box" : "boxes"} · {ago(m.updatedAt)}
                  </span>
                </button>
                <span className="map-actions">
                  <button
                    className="icon-btn"
                    title="Rename"
                    onClick={() => {
                      setDraft(m.title ?? "");
                      setEditing(m.id);
                    }}
                  >
                    ✎
                  </button>
                  <button className="icon-btn" title="Delete" onClick={() => setConfirming(m.id)}>
                    🗑
                  </button>
                </span>
              </>
            )}
          </li>
        ))}
      </ul>
    </aside>
  );
}
