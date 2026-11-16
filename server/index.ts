import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { streamSSE } from "hono/streaming";
import { streamAnswer, followups, ANSWER_MODEL, FOLLOWUP_MODEL, type ChainStep } from "./llm.ts";
import { listMaps, getMap, saveMap, renameMap, deleteMap, DB_PATH, type NodeIn } from "./db.ts";

const app = new Hono();
const PORT = Number(process.env.PORT ?? 5180);
const HOST = process.env.HOST ?? "::";

app.get("/api/health", (c) => c.json({ ok: true, answerModel: ANSWER_MODEL, followupModel: FOLLOWUP_MODEL }));

app.post("/api/answer", async (c) => {
  const { question, chain = [], parentBody, web = false } = await c.req.json<{ question: string; chain?: ChainStep[]; parentBody?: string; web?: boolean }>();
  if (!question?.trim()) return c.json({ error: "question required" }, 400);
  const abort = new AbortController();
  c.req.raw.signal.addEventListener("abort", () => abort.abort());
  return streamSSE(c, async (stream) => {
    stream.onAbort(() => abort.abort());
    try {
      for await (const ev of streamAnswer(question, chain, parentBody, abort, web === true)) {
        if (ev.type === "text") await stream.writeSSE({ event: "delta", data: JSON.stringify(ev.text) });
        else if (ev.type === "reset") await stream.writeSSE({ event: "reset", data: "{}" });
        else await stream.writeSSE({ event: "search", data: JSON.stringify(ev.query) });
      }
      await stream.writeSSE({ event: "done", data: "{}" });
    } catch (e) {
      if (!abort.signal.aborted) {
        console.error("[answer]", e);
        await stream.writeSSE({ event: "error", data: JSON.stringify(String((e as Error).message ?? e)) });
      }
    }
  });
});

app.post("/api/followups", async (c) => {
  const { question, tldr = "", body = "", chain = [] } = await c.req.json<{ question: string; tldr?: string; body?: string; chain?: ChainStep[] }>();
  try {
    return c.json({ questions: await followups(question, tldr, body, chain) });
  } catch (e) {
    console.error("[followups]", e);
    return c.json({ error: String((e as Error).message ?? e) }, 500);
  }
});

// ---- saved maps -------------------------------------------------------------
const validId = (id: string) => /^[\w-]{1,80}$/.test(id);

app.get("/api/maps", (c) => c.json({ maps: listMaps() }));

app.get("/api/maps/:id", (c) => {
  const m = getMap(c.req.param("id"));
  return m ? c.json(m) : c.json({ error: "not found" }, 404);
});

// Create-or-replace: the client owns map ids, so the first save creates the map.
app.put("/api/maps/:id", async (c) => {
  const id = c.req.param("id");
  if (!validId(id)) return c.json({ error: "bad id" }, 400);
  const { nodes } = await c.req.json<{ nodes: NodeIn[] }>();
  if (!Array.isArray(nodes)) return c.json({ error: "nodes required" }, 400);
  return c.json(saveMap(id, nodes));
});

app.patch("/api/maps/:id", async (c) => {
  const { title } = await c.req.json<{ title: string | null }>();
  return renameMap(c.req.param("id"), title) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
});

app.delete("/api/maps/:id", (c) => (deleteMap(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404)));

if (process.env.NODE_ENV === "production") {
  app.use("/*", serveStatic({ root: "./dist" }));
}

serve({ fetch: app.fetch, port: PORT, hostname: HOST }, () =>
  console.log(`branchmap api on http://${HOST}:${PORT} (answers: ${ANSWER_MODEL}, follow-ups: ${FOLLOWUP_MODEL}, db: ${DB_PATH})`),
);
