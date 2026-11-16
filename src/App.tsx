import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import { ActionsCtx, AnswerCard, GhostChip, AskerChip, CenterEdge, type Actions } from "./nodes.tsx";
import { parseRaw, type AppNode, type AppEdge, type AnswerNode, type GhostNode, type AskerNode } from "./types.ts";
import { freeAngle, placeChild, placeGhosts, chipSpot, askerAngle, settle, angleTo } from "./layout.ts";
import { streamAnswer, fetchFollowups, mapsApi, type ChainStep, type MapSummary, type SavedNode } from "./api.ts";
import { Sidebar, mapTitle } from "./Sidebar.tsx";

const LEGACY_KEY = "branchmap:v1"; // where the single pre-database map lived
const nodeTypes = { answer: AnswerCard, ghost: GhostChip, asker: AskerChip };
const edgeTypes = { center: CenterEdge };
let seq = 0;
const newId = (p: string) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`;
const hashId = () => location.hash.match(/^#\/m\/([\w-]+)$/)?.[1] ?? null;
const setHash = (id: string | null) => history.replaceState(null, "", id ? `#/m/${id}` : location.pathname);

/** Anything mid-stream when a map was last saved can't resume. */
const sanitize = (nodes: AppNode[]): AppNode[] =>
  nodes.map((n) =>
    n.type === "answer" && n.data.status === "streaming"
      ? { ...n, data: { ...n.data, status: "error" as const, error: "Interrupted." } }
      : n.type === "answer" && n.data.followups === "loading"
        ? { ...n, data: { ...n.data, followups: "error" as const } }
        : n,
  );

const r1 = (v: number) => Math.round(v * 10) / 10;
const toSaved = (ns: AppNode[]): SavedNode[] =>
  ns.map(({ id, type, position, data }) => ({ id, type: type!, position: { x: r1(position.x), y: r1(position.y) }, data }));

/** Edges are just the tree drawn: every node with a parent gets a line (an arrow, between boxes) to it. */
const edgesFor = (nodes: AppNode[]): AppEdge[] =>
  nodes
    .filter((n) => n.data.parentId)
    .map((n) => ({
      id: `e-${n.id}`,
      source: n.data.parentId!,
      target: n.id,
      type: "center",
      className: n.type === "answer" ? "edge-answer" : "edge-ghost",
      data: { arrow: n.type === "answer" }, // parent box → child box; chips keep a plain dashed line
    }));

function Canvas() {
  const [nodes, setNodes, onNodesChange] = useNodesState<AppNode>([]);
  const edges = useMemo(() => edgesFor(nodes), [nodes]);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const flow = useReactFlow();
  const aborts = useRef(new Map<string, AbortController>());

  // ---- saved maps (SQLite on the server) ------------------------------------
  const [mapId, setMapId] = useState<string | null>(null);
  const mapIdRef = useRef(mapId);
  mapIdRef.current = mapId;
  const [maps, setMaps] = useState<MapSummary[] | null>(null);
  const [sidebar, setSidebar] = useState(false);
  const [booting, setBooting] = useState(true);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");
  // Web search for new questions; remembered per browser. Each card keeps the setting it was asked with.
  const [web, setWebState] = useState(() => {
    try {
      return localStorage.getItem("branchmap:web") === "1";
    } catch {
      return false;
    }
  });
  const webRef = useRef(web);
  const setWeb = (on: boolean) => {
    webRef.current = on;
    setWebState(on);
    try {
      localStorage.setItem("branchmap:web", on ? "1" : "0");
    } catch {}
  };
  const pending = useRef<{ id: string; nodes: SavedNode[] } | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const refreshList = useCallback(() => mapsApi.list().then(setMaps).catch(() => {}), []);

  /** Send the queued save now (switching maps, closing the tab) instead of waiting for the debounce. */
  const flush = useCallback(
    async (keepalive = false) => {
      clearTimeout(timer.current);
      const job = pending.current;
      pending.current = null;
      if (!job) return;
      try {
        const r = await mapsApi.save(job.id, job.nodes, keepalive);
        if (!pending.current) setSaveState("saved");
        if (r.changed) refreshList();
      } catch {
        pending.current ??= job;
        setSaveState("error");
        timer.current = window.setTimeout(() => flush(), 3000); // keep retrying until the server is back
      }
    },
    [refreshList],
  );

  // Autosave: debounced; the server ignores saves where nothing changed.
  useEffect(() => {
    if (booting || !mapId || nodes.length === 0) return;
    pending.current = { id: mapId, nodes: toSaved(nodes) };
    setSaveState("saving");
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => flush(), 600);
  }, [nodes, mapId, booting, flush]);

  useEffect(() => {
    const onHide = () => flush(true);
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [flush]);

  const stopAll = () => {
    aborts.current.forEach((a) => a.abort());
    aborts.current.clear();
  };

  const blank = useCallback(() => {
    stopAll();
    nodesRef.current = [];
    setNodes([]);
    setMapId(null);
    setHash(null);
  }, [setNodes]);

  const openMap = useCallback(
    async (id: string) => {
      await flush();
      stopAll();
      try {
        const { nodes: saved } = await mapsApi.get(id);
        const ns = sanitize(saved as AppNode[]);
        nodesRef.current = ns;
        setNodes(ns);
        setMapId(id);
        setHash(id);
        setTimeout(() => flow.fitView({ padding: 0.3, maxZoom: 0.9, duration: 300 }), 80);
      } catch {
        blank();
      }
    },
    [flush, blank, setNodes, flow],
  );

  const newMap = useCallback(async () => {
    await flush();
    blank();
    setSidebar(false);
  }, [flush, blank]);

  const deleteMap = useCallback(
    async (id: string) => {
      if (id === mapIdRef.current) {
        // drop the queued save first, or it would recreate the map
        clearTimeout(timer.current);
        pending.current = null;
        blank();
      }
      await mapsApi.remove(id).catch(() => {});
      refreshList();
    },
    [blank, refreshList],
  );

  // Boot: import the old localStorage map once, then open #/m/<id> or the most recent map.
  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    (async () => {
      let target = hashId();
      try {
        const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) ?? "null");
        if (legacy?.nodes?.length) {
          const id = newId("m");
          await mapsApi.save(id, toSaved(sanitize(legacy.nodes)));
          localStorage.setItem(`${LEGACY_KEY}:imported`, localStorage.getItem(LEGACY_KEY)!);
          localStorage.removeItem(LEGACY_KEY);
          target ??= id;
        }
      } catch {}
      const list = await mapsApi.list().catch(() => [] as MapSummary[]);
      setMaps(list);
      target ??= list[0]?.id ?? null;
      if (target) await openMap(target);
      setBooting(false);
    })();
  }, [openMap]);

  // Chips hug their card: re-seat them whenever a card grows (streaming) or moves (drag),
  // and give every finished card its "ask your own" chip.
  useEffect(() => {
    const cards = new Map(nodes.filter((n) => n.type === "answer").map((n) => [n.id, n]));
    let changed = false;
    const next = nodes.map((n) => {
      if (n.type === "answer" || n.dragging) return n;
      const card = cards.get(n.data.parentId);
      if (!card?.measured) return n;
      const o = n.data.offset;
      const p = o ? { x: card.position.x + o.x, y: card.position.y + o.y } : chipSpot(card, n.data.angle);
      if (Math.abs(p.x - n.position.x) < 1 && Math.abs(p.y - n.position.y) < 1) return n;
      changed = true;
      return { ...n, position: p };
    });
    const askers: AskerNode[] = [];
    for (const card of cards.values()) {
      if (card.data.kind !== "answer" || card.data.status !== "done") continue;
      if (nodes.some((n) => n.type === "asker" && n.data.parentId === card.id)) continue;
      const angle = askerAngle(card.data.angle);
      askers.push({ id: newId("k"), type: "asker", position: chipSpot(card, angle), data: { kind: "asker", parentId: card.id, angle } });
    }
    if (askers.length) nodesRef.current = [...next, ...askers];
    if (changed || askers.length) setNodes([...next, ...askers]);
  }, [nodes, setNodes]);

  const patch = useCallback(
    (id: string, fn: (d: AnswerNode["data"]) => Partial<AnswerNode["data"]>) =>
      setNodes((ns) => ns.map((n) => (n.id === id && n.type === "answer" ? { ...n, data: { ...n.data, ...fn(n.data) } } : n))),
    [setNodes],
  );

  const chainFor = (id: string): ChainStep[] => {
    const all = nodesRef.current;
    const steps: ChainStep[] = [];
    let cur = all.find((n) => n.id === id);
    let pid = cur?.data.parentId;
    while (pid) {
      cur = all.find((n) => n.id === pid);
      if (!cur || cur.type !== "answer") break;
      steps.unshift({ question: cur.data.question, tldr: parseRaw(cur.data.raw).tldr });
      pid = cur.data.parentId;
    }
    return steps;
  };

  const loadFollowups = useCallback(
    async (id: string, raw?: string) => {
      const node = nodesRef.current.find((n) => n.id === id) as AnswerNode | undefined;
      if (!node) return;
      patch(id, () => ({ followups: "loading" }));
      try {
        const { tldr, body } = parseRaw(raw ?? node.data.raw);
        const qs = await fetchFollowups({ question: node.data.question, tldr, body, chain: chainFor(id) });
        const cur = nodesRef.current.find((n) => n.id === id);
        if (!cur) return;
        const spots = placeGhosts(cur, qs.length, nodesRef.current);
        const ghosts: GhostNode[] = spots.map((s, i) => ({
          id: newId("g"),
          type: "ghost",
          position: s.position,
          data: { kind: "ghost", question: qs[i], parentId: id, angle: s.angle },
        }));
        setNodes((ns) => [
          ...ns.map((n) => (n.id === id && n.type === "answer" ? { ...n, data: { ...n.data, followups: "done" as const } } : n)),
          ...ghosts,
        ]);
      } catch {
        patch(id, () => ({ followups: "error" }));
      }
    },
    [patch, setNodes],
  );

  const run = useCallback(
    async (id: string) => {
      const node = nodesRef.current.find((n) => n.id === id) as AnswerNode | undefined;
      if (!node) return;
      const parent = nodesRef.current.find((n) => n.id === node.data.parentId) as AnswerNode | undefined;
      const abort = new AbortController();
      aborts.current.set(id, abort);
      patch(id, () => ({ raw: "", status: "streaming", error: undefined, searching: undefined }));
      let raw = "";
      try {
        await streamAnswer(
          {
            question: node.data.question,
            chain: chainFor(id),
            parentBody: parent ? parseRaw(parent.data.raw).body : undefined,
            web: node.data.web,
          },
          {
            delta: (t) => {
              raw += t;
              patch(id, () => ({ raw }));
            },
            reset: () => {
              raw = "";
              patch(id, () => ({ raw }));
            },
            search: (q) => patch(id, () => ({ searching: q })),
          },
          abort.signal,
        );
        patch(id, () => ({ status: "done", searching: undefined }));
        // the card now has its real height: nudge it outward if it grew into a neighbour
        setTimeout(() => {
          const me = nodesRef.current.find((n) => n.id === id);
          const p = me && settle(me, nodesRef.current);
          if (p) setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, position: p } : n)));
          loadFollowups(id, raw);
        }, 80);
      } catch (e) {
        if (!abort.signal.aborted) patch(id, () => ({ status: "error", error: (e as Error).message, searching: undefined }));
      } finally {
        aborts.current.delete(id);
      }
    },
    [patch, loadFollowups, setNodes],
  );

  const addAnswer = useCallback(
    (question: string, parentId?: string, angle?: number, ignoreId?: string) => {
      const all = nodesRef.current;
      const parent = parentId ? all.find((n) => n.id === parentId) : undefined;
      let position = { x: 0, y: 0 };
      let outward: number | undefined;
      if (parent) {
        const placed = placeChild(parent, angle ?? freeAngle(parent, all), all, ignoreId);
        position = placed.position;
        outward = placed.angle;
      }
      const id = newId("a");
      const node: AnswerNode = {
        id,
        type: "answer",
        position,
        data: { kind: "answer", question, raw: "", status: "streaming", parentId, angle: outward, followups: "idle", web: webRef.current || undefined },
      };
      nodesRef.current = [...nodesRef.current.filter((n) => n.id !== ignoreId), node];
      setNodes((ns) => [...ns.filter((n) => n.id !== ignoreId), node]);
      flow.setCenter(position.x, position.y + 120, { zoom: Math.max(flow.getZoom(), 0.75), duration: 600 });
      run(id);
    },
    [flow, run, setNodes],
  );

  const removeSubtree = useCallback(
    (rootId: string) => {
      const all = nodesRef.current;
      const doomed = new Set([rootId]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const n of all) if (n.data.parentId && doomed.has(n.data.parentId) && !doomed.has(n.id)) doomed.add(n.id), (grew = true);
      }
      doomed.forEach((id) => aborts.current.get(id)?.abort());
      setNodes((ns) => ns.filter((n) => !doomed.has(n.id)));
    },
    [setNodes],
  );

  const actions: Actions = useMemo(
    () => ({
      askFrom: (kid, q) => {
        const k = nodesRef.current.find((n) => n.id === kid) as AskerNode | undefined;
        if (!k) return;
        const card = nodesRef.current.find((n) => n.id === k.data.parentId);
        addAnswer(q, k.data.parentId, card ? angleTo(card.position, k.position) : k.data.angle);
        if (!card) return;
        // the input chip steps aside to the emptiest direction, ready for another question
        const angle = freeAngle(card, nodesRef.current, kid);
        setNodes((ns) => ns.map((n) => (n.id === kid && n.type === "asker" ? { ...n, position: chipSpot(card, angle), data: { ...n.data, angle, offset: undefined } } : n)));
      },
      expandGhost: (gid) => {
        const g = nodesRef.current.find((n) => n.id === gid) as GhostNode | undefined;
        const card = g && nodesRef.current.find((n) => n.id === g.data.parentId);
        if (g) addAnswer(g.data.question, g.data.parentId, card ? angleTo(card.position, g.position) : g.data.angle, gid);
      },
      dismissGhost: (gid) => removeSubtree(gid),
      retry: (id) => run(id),
      remove: (id) => removeSubtree(id),
    }),
    [addAnswer, removeSubtree, run],
  );

  const startMap = (q: string) => {
    if (!mapIdRef.current) {
      const id = newId("m");
      mapIdRef.current = id;
      setMapId(id);
      setHash(id);
    }
    addAnswer(q);
  };

  const current = maps?.find((m) => m.id === mapId);
  const rootQ = nodes.find((n) => n.type === "answer" && !n.data.parentId)?.data as { question?: string } | undefined;
  const title = current ? mapTitle(current) : rootQ?.question;

  return (
    <ActionsCtx.Provider value={actions}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onNodeDragStop={(_, dragged) => {
          if (dragged.type === "answer") return;
          setNodes((ns) => {
            const card = ns.find((n) => n.id === dragged.data.parentId);
            if (!card) return ns;
            const offset = { x: dragged.position.x - card.position.x, y: dragged.position.y - card.position.y };
            return ns.map((n) => (n.id === dragged.id && n.type !== "answer" ? ({ ...n, data: { ...n.data, offset } } as AppNode) : n));
          });
        }}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodeOrigin={[0.5, 0.5]}
        minZoom={0.1}
        maxZoom={1.6}
        nodesConnectable={false}
        deleteKeyCode={null}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={28} size={1.4} />
        <Controls showInteractive={false} position="bottom-right" />
        {nodes.length > 3 && <MiniMap pannable zoomable position="bottom-left" nodeStrokeWidth={3} />}
      </ReactFlow>
      <header className="topbar">
        <button className={`icon-btn maps-btn ${sidebar ? "is-on" : ""}`} title="Your maps" onClick={() => (sidebar ? setSidebar(false) : (refreshList(), setSidebar(true)))}>
          ☰
        </button>
        <strong>branchmap</strong>
        {title && <span className="topbar-title" title={title}>{title}</span>}
        <button
          className={`web-toggle ${web ? "is-on" : ""}`}
          aria-pressed={web}
          title={web ? "Web search is on for new questions (slower, cites sources)" : "Web search is off: answers come from the model's own knowledge"}
          onClick={() => setWeb(!web)}
        >
          🌐 Web {web ? "on" : "off"}
        </button>
        {mapId && nodes.length > 0 && (
          <span className={`save-state is-${saveState}`}>{saveState === "saving" ? "Saving…" : saveState === "error" ? "Not saved, retrying" : "Saved"}</span>
        )}
        {nodes.length > 0 && (
          <button className="link" onClick={newMap}>
            New map
          </button>
        )}
      </header>
      {sidebar && (
        <Sidebar
          maps={maps}
          currentId={mapId}
          onOpen={(id) => openMap(id)}
          onNew={newMap}
          onRename={(id, t) => mapsApi.rename(id, t).then(refreshList)}
          onDelete={deleteMap}
          onClose={() => setSidebar(false)}
        />
      )}
      {!booting && nodes.length === 0 && <FirstQuestion onAsk={startMap} />}
    </ActionsCtx.Provider>
  );
}

function FirstQuestion({ onAsk }: { onAsk: (q: string) => void }) {
  const [q, setQ] = useState("");
  return (
    <div className="first">
      <h1>What do you want to explore?</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim()) onAsk(q.trim());
        }}
      >
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. How do black holes form?" />
        <button type="submit" disabled={!q.trim()}>
          Explore
        </button>
      </form>
    </div>
  );
}

export default function App() {
  return (
    <ReactFlowProvider>
      <Canvas />
    </ReactFlowProvider>
  );
}
