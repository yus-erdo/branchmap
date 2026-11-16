import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Lives outside the app folder: redeploys rsync --delete the app dir.
export const DB_PATH = process.env.DB_PATH ?? join(homedir(), ".branchmap", "branchmap.db");
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS maps (
    id         TEXT PRIMARY KEY,
    title      TEXT,                 -- NULL = use the first question
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS nodes (
    id        TEXT NOT NULL,
    map_id    TEXT NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
    parent_id TEXT,                  -- NULL only for the map's first question
    type      TEXT NOT NULL,         -- answer | ghost | asker
    x         REAL NOT NULL,
    y         REAL NOT NULL,
    data      TEXT NOT NULL,         -- JSON: question, raw answer, status, angle, offset...
    PRIMARY KEY (map_id, id)
  );
  CREATE INDEX IF NOT EXISTS nodes_by_map ON nodes(map_id);
`);

export type NodeIn = { id: string; type: string; position: { x: number; y: number }; data: Record<string, unknown> };

const r1 = (v: number) => Math.round(v * 10) / 10;
const canonical = (nodes: { id: string; type: string; x: number; y: number; data: string }[]) =>
  JSON.stringify([...nodes].sort((a, b) => a.id.localeCompare(b.id)).map((n) => [n.id, n.type, r1(n.x), r1(n.y), n.data]));

const q = {
  list: db.prepare(`
    SELECT m.id, m.title, m.created_at AS createdAt, m.updated_at AS updatedAt,
           (SELECT json_extract(n.data, '$.question') FROM nodes n
             WHERE n.map_id = m.id AND n.type = 'answer' AND n.parent_id IS NULL LIMIT 1) AS firstQuestion,
           (SELECT count(*) FROM nodes n WHERE n.map_id = m.id AND n.type = 'answer') AS answers
    FROM maps m ORDER BY m.updated_at DESC`),
  map: db.prepare(`SELECT id, title, created_at AS createdAt, updated_at AS updatedAt FROM maps WHERE id = ?`),
  nodes: db.prepare(`SELECT id, type, x, y, data FROM nodes WHERE map_id = ?`),
  upsertMap: db.prepare(`INSERT INTO maps (id, created_at, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING`),
  touch: db.prepare(`UPDATE maps SET updated_at = ? WHERE id = ?`),
  clearNodes: db.prepare(`DELETE FROM nodes WHERE map_id = ?`),
  insertNode: db.prepare(`INSERT INTO nodes (id, map_id, parent_id, type, x, y, data) VALUES (?, ?, ?, ?, ?, ?, ?)`),
  rename: db.prepare(`UPDATE maps SET title = ? WHERE id = ?`),
  del: db.prepare(`DELETE FROM maps WHERE id = ?`),
};

export function listMaps() {
  return q.list.all();
}

export function getMap(id: string) {
  const map = q.map.get(id);
  if (!map) return null;
  const nodes = (q.nodes.all(id) as { id: string; type: string; x: number; y: number; data: string }[]).map((n) => ({
    id: n.id,
    type: n.type,
    position: { x: n.x, y: n.y },
    data: JSON.parse(n.data),
  }));
  return { map, nodes };
}

/** Replace a map's nodes (creating the map if new). Only bumps updated_at when something actually changed. */
export function saveMap(id: string, nodes: NodeIn[]): { changed: boolean } {
  const rows = nodes.map((n) => ({
    id: n.id,
    type: n.type,
    x: n.position.x,
    y: n.position.y,
    parent: (n.data.parentId as string | undefined) ?? null,
    data: JSON.stringify(n.data),
  }));
  const now = Date.now();
  db.exec("BEGIN");
  try {
    q.upsertMap.run(id, now, now);
    const before = canonical(q.nodes.all(id) as never);
    const changed = before !== canonical(rows);
    if (changed) {
      q.clearNodes.run(id);
      for (const r of rows) q.insertNode.run(r.id, id, r.parent, r.type, r.x, r.y, r.data);
      q.touch.run(now, id);
    }
    db.exec("COMMIT");
    return { changed };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function renameMap(id: string, title: string | null) {
  return q.rename.run(title?.trim() || null, id).changes > 0;
}

export function deleteMap(id: string) {
  return q.del.run(id).changes > 0;
}
