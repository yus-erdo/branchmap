import type { AppNode } from "./types.ts";

export const SLOTS = 6; // chips around a card: 5 suggested questions + 1 "ask your own"
const CHIP_GAP = 260; // min distance between two chips
const CHIP_W = 230;
const CHIP_H = 72;
const CARD_W = 480;
const CARD_H = 700; // estimate before a card is measured / has finished streaming
const MARGIN = 30; // card edge -> chip edge

const rad = (d: number) => (d * Math.PI) / 180;
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
const angDiff = (a: number, b: number) => Math.abs((((a - b) % 360) + 540) % 360 - 180);
export const angleTo = (from: { x: number; y: number }, to: { x: number; y: number }) =>
  (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;

/** Distance from a box's centre to its edge along a direction. */
function edge(w: number, h: number, deg: number) {
  const c = Math.abs(Math.cos(rad(deg)));
  const s = Math.abs(Math.sin(rad(deg)));
  return Math.min(c > 1e-6 ? w / 2 / c : Infinity, s > 1e-6 ? h / 2 / s : Infinity);
}

const sizeOf = (n: AppNode) => ({
  w: n.measured?.width ?? (n.type === "answer" ? CARD_W : CHIP_W),
  h: n.measured?.height ?? (n.type === "answer" ? CARD_H : CHIP_H),
});

/** Centre of a chip sitting just outside a card, in a given direction. */
export function chipSpot(card: AppNode, deg: number) {
  const { w, h } = sizeOf(card);
  // edge of the card grown by the chip's size + margin: boxes can't overlap, even at the corners
  const r = edge(w + CHIP_W + 2 * MARGIN, h + CHIP_H + 2 * MARGIN, deg);
  return { x: card.position.x + r * Math.cos(rad(deg)), y: card.position.y + r * Math.sin(rad(deg)) };
}

/** The chip slots around a card: a full ring for the root, a fan pointing outward elsewhere. */
export function slotAngles(outward?: number, n = SLOTS): number[] {
  if (outward === undefined) return Array.from({ length: n }, (_, i) => -90 + (i * 360) / n);
  const spread = 240;
  return Array.from({ length: n }, (_, i) => outward - spread / 2 + (i * spread) / (n - 1));
}

/** The input chip takes the slot pointing most "forward" (straight down for the root). */
export function askerAngle(outward?: number): number {
  const target = outward ?? 90;
  return slotAngles(outward).reduce((best, a) => (angDiff(a, target) < angDiff(best, target) ? a : best));
}

const clearOf = (p: { x: number; y: number }, nodes: AppNode[]) =>
  nodes.every((n) => dist(p, n.position) > (n.type === "answer" ? edge(sizeOf(n).w, sizeOf(n).h, angleTo(n.position, p)) + 140 : CHIP_GAP));

/** Positions for suggested-question chips: the free slots, minus any that would land on something. */
export function placeGhosts(card: AppNode, count: number, nodes: AppNode[]) {
  const outward = card.data.kind === "answer" ? card.data.angle : undefined;
  const others = nodes.filter((n) => n.id !== card.id);
  const out: { position: { x: number; y: number }; angle: number }[] = [];
  for (const a of slotAngles(outward)) {
    if (out.length >= count) break;
    const p = chipSpot(card, a);
    if (clearOf(p, [...others, ...out.map((o) => ({ position: o.position, type: "ghost" }) as AppNode)])) out.push({ position: p, angle: a });
  }
  return out;
}

/** The emptiest direction around a card (used to move the input chip after it's been used). */
export function freeAngle(card: AppNode, nodes: AppNode[], ignoreId?: string): number {
  const used = nodes.filter((n) => n.data.parentId === card.id && n.id !== ignoreId).map((n) => angleTo(card.position, n.position));
  const gp = card.data.parentId && nodes.find((n) => n.id === card.data.parentId);
  if (gp) used.push(angleTo(card.position, gp.position));
  const outward = card.data.kind === "answer" ? card.data.angle ?? 90 : 90;
  let best = outward;
  let bestScore = -1;
  for (let a = 0; a < 360; a += 15) {
    const gap = used.length ? Math.min(...used.map((u) => angDiff(a, u))) : 180;
    const score = gap - angDiff(a, outward) * 0.01;
    if (score > bestScore) [best, bestScore] = [a, score];
  }
  return best;
}

type Box = { x: number; y: number; w: number; h: number };
const boxOf = (n: AppNode, pad = 0): Box => {
  const { w, h } = sizeOf(n);
  return { x: n.position.x, y: n.position.y, w: w + 2 * pad, h: h + 2 * pad };
};
const overlaps = (a: Box, b: Box) => Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2;
const CARD_PAD = CHIP_H + MARGIN + 40; // room for a ring of chips around every card

/** Does a card at this centre (with this size) clear every other card and chip? */
function fits(p: { x: number; y: number }, w: number, h: number, nodes: AppNode[]) {
  const me: Box = { x: p.x, y: p.y, w: w + 2 * CARD_PAD, h: h + 2 * CARD_PAD };
  return nodes.every((n) => !overlaps(me, n.type === "answer" ? boxOf(n, CARD_PAD) : boxOf(n)));
}

/** Where a child answer goes: just beyond the parent's chip ring in that direction, nudged until it fits. */
export function placeChild(parent: AppNode, angle: number, nodes: AppNode[], ignoreId?: string) {
  const others = nodes.filter((n) => n.id !== ignoreId);
  const { w, h } = sizeOf(parent);
  // centre distance at which the two padded cards would just touch
  const base = edge(w + CARD_W + 4 * CARD_PAD, h + CARD_H + 4 * CARD_PAD, angle);
  for (const k of [1, 1.3, 1.6, 2, 2.5, 3]) {
    for (const off of [0, 15, -15, 30, -30, 45, -45]) {
      const a = angle + off;
      const r = base * k;
      const p = { x: parent.position.x + r * Math.cos(rad(a)), y: parent.position.y + r * Math.sin(rad(a)) };
      if (fits(p, CARD_W, CARD_H, others)) return { position: p, angle: a };
    }
  }
  const r = base * 3.5;
  return { position: { x: parent.position.x + r * Math.cos(rad(angle)), y: parent.position.y + r * Math.sin(rad(angle)) }, angle };
}

/** After a card has grown to its real size: slide it outward from its parent until it overlaps nothing. */
export function settle(card: AppNode, nodes: AppNode[]): { x: number; y: number } | null {
  const pid = card.data.parentId;
  const parent = pid && nodes.find((n) => n.id === pid);
  if (!parent || card.type !== "answer") return null;
  const own = new Set([card.id, ...nodes.filter((n) => n.data.parentId === card.id).map((n) => n.id)]);
  const others = nodes.filter((n) => !own.has(n.id));
  const { w, h } = sizeOf(card);
  const a = angleTo(parent.position, card.position);
  let p = card.position;
  for (let i = 0; i < 40 && !fits(p, w, h, others); i++) p = { x: p.x + 60 * Math.cos(rad(a)), y: p.y + 60 * Math.sin(rad(a)) };
  return p === card.position ? null : p;
}
