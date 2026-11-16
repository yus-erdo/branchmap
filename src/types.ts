import type { Node, Edge } from "@xyflow/react";

export type AnswerData = {
  kind: "answer";
  question: string;
  raw: string; // model output as streamed: "TLDR: ...\n---\n<body>"
  status: "streaming" | "done" | "error";
  error?: string;
  parentId?: string;
  angle?: number; // outward direction from parent, degrees
  followups: "idle" | "loading" | "done" | "error";
  web?: boolean; // asked with web search on
  searching?: string; // the latest search query while it streams
};

export type GhostData = {
  kind: "ghost";
  question: string;
  parentId: string;
  angle: number;
  offset?: { x: number; y: number }; // set once you drag the chip: its spot relative to the card
};

export type AskerData = {
  kind: "asker"; // the "ask your own" chip that floats around a card like the follow-ups
  parentId: string;
  angle: number;
  offset?: { x: number; y: number };
};

export type AnswerNode = Node<AnswerData, "answer">;
export type GhostNode = Node<GhostData, "ghost">;
export type AskerNode = Node<AskerData, "asker">;
export type AppNode = AnswerNode | GhostNode | AskerNode;
export type AppEdge = Edge;

export function parseRaw(raw: string): { tldr: string; body: string } {
  const i = raw.indexOf("\n---");
  const head = i === -1 ? raw : raw.slice(0, i);
  const body = i === -1 ? "" : raw.slice(i + 4).replace(/^-*\n?/, "");
  return { tldr: head.replace(/^\s*\**TL;?DR:?\**\s*/i, "").trim(), body: body.trim() };
}
