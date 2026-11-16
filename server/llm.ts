import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { tmpdir } from "node:os";

export const ANSWER_MODEL = process.env.ANSWER_MODEL ?? "claude-opus-5-5";
export const FOLLOWUP_MODEL = process.env.FOLLOWUP_MODEL ?? "claude-haiku-5-5";
const ANSWER_EFFORT = (process.env.ANSWER_EFFORT ?? "low") as Options["effort"];

export type ChainStep = { question: string; tldr: string };

// Plain text-in/text-out: no tools (web mode adds WebSearch only), no user settings/CLAUDE.md, no saved sessions.
function baseOptions(model: string, systemPrompt: string, abort?: AbortController): Options {
  return {
    model,
    systemPrompt,
    tools: [],
    maxTurns: 1,
    settingSources: [],
    persistSession: false,
    cwd: tmpdir(),
    abortController: abort,
    // Use an installed, logged-in `claude` when CLAUDE_PATH is set; else the SDK's bundled CLI.
    pathToClaudeCodeExecutable: process.env.CLAUDE_PATH || undefined,
    env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "branchmap/0.1" },
  };
}

const ANSWER_SYSTEM = `You write entries for an exploration mind map. Each entry is a condensed, Wikipedia-style summary: factual, neutral, dense, skimmable.

Output EXACTLY this format, nothing before or after:
TLDR: <one sentence, max 25 words, that answers the question directly>
---
<body in Markdown: 2-4 short sections with "### " headings, bullets or 1-3 sentence paragraphs. Bold key terms. 120-250 words total. No intro line, no closing remarks, no follow-up offers.>`;

function chainContext(chain: ChainStep[], parentBody?: string): string {
  if (!chain.length) return "";
  const path = chain.map((s, i) => `${i + 1}. Q: ${s.question}\n   TLDR: ${s.tldr}`).join("\n");
  return `The reader reached this question by following this path through the map (earliest first):\n${path}\n${
    parentBody ? `\nThe entry they are branching from:\n${parentBody}\n` : ""
  }\nAnswer the new question in that context; don't repeat what the path already covers.\n\n`;
}

const WEB_ADDENDUM = `

You have a WebSearch tool. Search first (1-3 searches), and write nothing before or between searches. Then write the entry from what you found, preferring current facts over memory. End the body with a "### Sources" section: 2-5 bullets, each a Markdown link [Site or title](url) to a page you actually used.`;

/** What the answer stream sends: text to append, "start over" (text written before a search), or a search in progress. */
export type AnswerEvent = { type: "text"; text: string } | { type: "reset" } | { type: "search"; query: string };

export async function* streamAnswer(
  question: string,
  chain: ChainStep[],
  parentBody: string | undefined,
  abort: AbortController,
  web = false,
): AsyncGenerator<AnswerEvent> {
  const prompt = `${chainContext(chain, parentBody)}New question: ${question}`;
  const base = baseOptions(ANSWER_MODEL, ANSWER_SYSTEM + (web ? WEB_ADDENDUM : ""), abort);
  const options: Options = web
    ? // web mode: WebSearch only, pre-approved (nobody is there to answer a permission prompt), a few turns to search then write
      { ...base, tools: ["WebSearch"], allowedTools: ["WebSearch"], permissionMode: "dontAsk", maxTurns: 6 }
    : base;
  const q = query({ prompt, options: { ...options, includePartialMessages: true, effort: ANSWER_EFFORT } });
  let streamed = false;
  for await (const msg of q) {
    if (msg.type === "stream_event" && msg.parent_tool_use_id === null) {
      const ev = msg.event;
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
        streamed = true;
        yield { type: "text", text: ev.delta.text };
      } else if (ev.type === "content_block_start" && ev.content_block.type === "tool_use") {
        if (streamed) yield { type: "reset" }; // anything said before a search isn't the entry
        streamed = false;
      }
    } else if (msg.type === "assistant" && msg.parent_tool_use_id === null) {
      for (const b of msg.message.content) {
        if (b.type === "tool_use" && b.name === "WebSearch") yield { type: "search", query: String((b.input as { query?: string }).query ?? "") };
      }
    } else if (msg.type === "result") {
      if (msg.subtype !== "success") throw new Error(`answer failed: ${msg.subtype}`);
      if (!streamed && msg.result) yield { type: "text", text: msg.result };
    }
  }
}

const FOLLOWUP_SYSTEM = `You suggest follow-up questions for an exploration mind map.
Given an entry, propose 5 short, curious, varied follow-up questions a reader would want to branch into next: mix going deeper, zooming out, origins/history, comparisons, and surprising angles. Each under 12 words. Don't repeat questions already on the path.
Output only the 5 questions, one per line, no numbering, no bullets.`;

export async function followups(question: string, tldr: string, body: string, chain: ChainStep[]): Promise<string[]> {
  const path = chain.map((s) => `- ${s.question}`).join("\n");
  const prompt = `${path ? `Path so far:\n${path}\n\n` : ""}Entry question: ${question}\nTLDR: ${tldr}\n\n${body}`;
  let text = "";
  for await (const msg of query({ prompt, options: { ...baseOptions(FOLLOWUP_MODEL, FOLLOWUP_SYSTEM), effort: "low" } })) {
    if (msg.type === "result") {
      if (msg.subtype !== "success") throw new Error(`followups failed: ${msg.subtype}`);
      text = msg.result;
    }
  }
  return text
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter((l) => l.length > 3)
    .slice(0, 6);
}
