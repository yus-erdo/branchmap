export type ChainStep = { question: string; tldr: string };

export async function streamAnswer(
  req: { question: string; chain: ChainStep[]; parentBody?: string; web?: boolean },
  on: { delta: (text: string) => void; reset: () => void; search: (query: string) => void },
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch("/api/answer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`server ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (event === "delta") on.delta(JSON.parse(data));
      else if (event === "reset") on.reset();
      else if (event === "search") on.search(JSON.parse(data));
      else if (event === "error") throw new Error(JSON.parse(data));
      else if (event === "done") return;
    }
  }
  throw new Error("stream ended early");
}

export async function fetchFollowups(req: { question: string; tldr: string; body: string; chain: ChainStep[] }): Promise<string[]> {
  const res = await fetch("/api/followups", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error ?? `server ${res.status}`);
  return j.questions;
}

// ---- saved maps -------------------------------------------------------------
export type MapSummary = {
  id: string;
  title: string | null;
  firstQuestion: string | null;
  answers: number;
  createdAt: number;
  updatedAt: number;
};
export type SavedNode = { id: string; type: string; position: { x: number; y: number }; data: Record<string, unknown> };

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`server ${res.status}`);
  return res.json();
}

export const mapsApi = {
  list: () => fetch("/api/maps").then((r) => json<{ maps: MapSummary[] }>(r)).then((j) => j.maps),
  get: (id: string) => fetch(`/api/maps/${id}`).then((r) => json<{ map: MapSummary; nodes: SavedNode[] }>(r)),
  save: (id: string, nodes: SavedNode[], keepalive = false) => {
    const body = JSON.stringify({ nodes });
    return fetch(`/api/maps/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body,
      keepalive: keepalive && body.length < 60_000, // lets the last save finish while the tab closes (64KB cap)
    }).then((r) => json<{ changed: boolean }>(r));
  },
  rename: (id: string, title: string | null) =>
    fetch(`/api/maps/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) }).then((r) =>
      json<{ ok: boolean }>(r),
    ),
  remove: (id: string) => fetch(`/api/maps/${id}`, { method: "DELETE" }).then((r) => json<{ ok: boolean }>(r)),
};
