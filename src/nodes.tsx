import { createContext, useContext, useRef, useState, memo } from "react";
import { Handle, Position, BaseEdge, getStraightPath, useInternalNode, type NodeProps, type EdgeProps } from "@xyflow/react";
import Markdown from "react-markdown";
import { parseRaw, type AnswerNode, type GhostNode, type AskerNode } from "./types.ts";

export type Actions = {
  askFrom: (askerId: string, question: string) => void;
  expandGhost: (ghostId: string) => void;
  dismissGhost: (ghostId: string) => void;
  retry: (id: string) => void;
  remove: (id: string) => void;
};
export const ActionsCtx = createContext<Actions>(null!);

// Edges attach at node centres, so a single hidden handle pair is enough.
const Hidden = () => (
  <>
    <Handle type="target" position={Position.Top} className="hidden-handle" isConnectable={false} />
    <Handle type="source" position={Position.Top} className="hidden-handle" isConnectable={false} />
  </>
);

export const AnswerCard = memo(function AnswerCard({ id, data }: NodeProps<AnswerNode>) {
  const actions = useContext(ActionsCtx);
  const { tldr, body } = parseRaw(data.raw);
  const streaming = data.status === "streaming";

  return (
    <div className={`card ${streaming ? "is-streaming" : ""} ${data.parentId ? "" : "is-root"}`}>
      <Hidden />
      {/* header + card padding = drag area; the text block below is selectable, not draggable */}
      <div className="card-q" title="Drag to move">
        <span className="grip" aria-hidden>
          ⠿
        </span>
        <span className="q-text">{data.question}</span>
        {data.parentId && (
          <button className="icon-btn nodrag" title="Remove this branch" onClick={() => actions.remove(id)}>
            ×
          </button>
        )}
      </div>
      <div className="card-text nodrag nopan">
        <div className="card-tldr">
          <span className="tag">TL;DR</span>
          {data.web && (
            <span className="tag tag-web" title="Answered with web search">
              WEB
            </span>
          )}
          {tldr || <span className="shimmer">{data.searching ? `Searching the web: ${data.searching}` : data.web && streaming ? "Searching the web…" : "Thinking…"}</span>}
        </div>
        {body && (
          <div className="card-body">
            <Markdown components={{ a: ({ node: _n, ...p }) => <a {...p} target="_blank" rel="noreferrer" /> }}>{body}</Markdown>
          </div>
        )}
      </div>
      {data.status === "error" && (
        <div className="card-error">
          {data.error ?? "Something went wrong."}{" "}
          <button className="link nodrag" onClick={() => actions.retry(id)}>
            Retry
          </button>
        </div>
      )}
      {data.followups === "loading" && <div className="card-foot shimmer">Finding follow-ups…</div>}
    </div>
  );
});

export const GhostChip = memo(function GhostChip({ id, data }: NodeProps<GhostNode>) {
  const actions = useContext(ActionsCtx);
  const down = useRef<{ x: number; y: number } | null>(null);
  return (
    <div
      className="ghost"
      title="Click to explore · drag to move"
      onPointerDown={(e) => (down.current = { x: e.clientX, y: e.clientY })}
      onClick={(e) => {
        // a drag ends with a click too; only a still click opens the branch
        const d = down.current;
        if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
        actions.expandGhost(id);
      }}
    >
      <Hidden />
      <span className="ghost-q">{data.question}</span>
      <button
        className="ghost-x nodrag"
        title="Dismiss"
        onClick={(e) => {
          e.stopPropagation();
          actions.dismissGhost(id);
        }}
      >
        ×
      </button>
    </div>
  );
});

export const AskerChip = memo(function AskerChip({ id }: NodeProps<AskerNode>) {
  const actions = useContext(ActionsCtx);
  const [draft, setDraft] = useState("");
  const submit = () => {
    if (!draft.trim()) return;
    actions.askFrom(id, draft.trim());
    setDraft("");
  };
  return (
    <div className="ghost asker" title="Drag the edge to move">
      <Hidden />
      <textarea
        className="nodrag nowheel"
        rows={2}
        value={draft}
        placeholder="Ask your own…"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
    </div>
  );
});

/** How far from a box's centre a ray in direction (dx, dy) (unit) leaves the box. */
const exitDist = (w: number, h: number, dx: number, dy: number) =>
  Math.min(dx ? w / 2 / Math.abs(dx) : Infinity, dy ? h / 2 / Math.abs(dy) : Infinity);

const ARROW = 13; // arrowhead length
const GAP = 5; // space between the arrow tip and the box

/** Straight line between node centres. Answer→answer edges are trimmed to the box borders and end in an arrowhead. */
export function CenterEdge({ source, target, style, data }: EdgeProps) {
  const s = useInternalNode(source);
  const t = useInternalNode(target);
  if (!s || !t) return null;
  const sx = s.position.x, sy = s.position.y, tx = t.position.x, ty = t.position.y;
  if (!data?.arrow) {
    const [path] = getStraightPath({ sourceX: sx, sourceY: sy, targetX: tx, targetY: ty });
    return <BaseEdge path={path} style={style} />;
  }
  const len = Math.hypot(tx - sx, ty - sy);
  if (!len) return null;
  const dx = (tx - sx) / len, dy = (ty - sy) / len;
  const out = exitDist(s.measured.width ?? 0, s.measured.height ?? 0, dx, dy) + GAP;
  const into = exitDist(t.measured.width ?? 0, t.measured.height ?? 0, dx, dy) + GAP;
  if (out + into + ARROW > len) return null; // boxes overlap or touch: no room for an arrow
  const ax = sx + dx * out, ay = sy + dy * out; // line start, just outside the parent
  const bx = tx - dx * into, by = ty - dy * into; // arrow tip, just outside the child
  const hx = bx - dx * ARROW, hy = by - dy * ARROW; // base of the arrowhead
  const nx = -dy * ARROW * 0.5, ny = dx * ARROW * 0.5;
  return (
    <>
      <BaseEdge path={`M ${ax} ${ay} L ${hx} ${hy}`} style={style} />
      <path className="edge-arrow" d={`M ${bx} ${by} L ${hx + nx} ${hy + ny} L ${hx - nx} ${hy - ny} Z`} />
    </>
  );
}
