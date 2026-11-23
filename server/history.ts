/**
 * Replay a persisted harness session as ACP history.
 *
 * The harness resumes a session without replaying it, so an imported conversation
 * would open with an empty timeline. The session log holds every user message,
 * assistant message, thought, tool call and tool result, so this module turns that
 * log into the `session/update` notifications an ACP agent normally sends before
 * `session/load` resolves.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { zstdDecompressSync } from "node:zlib";

export interface HistoryUpdate {
  sessionUpdate: string;
  [key: string]: unknown;
}

const MAX_EVENTS = 400;
const MAX_TEXT = 8_000;
const MAX_TOOL_OUTPUT = 4_000;

/** Replayed updates for one session, oldest first; empty when unavailable. */
export function readSessionHistory(sessionId: string, harnessHome = process.env.DSH_HOME ?? join(homedir(), ".dsh")): HistoryUpdate[] {
  const file = findLog(sessionId, harnessHome);
  if (file === undefined) return [];

  let text: string;
  try {
    text = decompressAllFrames(readFileSync(file));
  } catch {
    return [];
  }

  const events: HistoryUpdate[] = [];
  let eventsSeen = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let event: { type?: string; seq?: number; data?: any };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const produced = convert(event);
    if (produced.length > 0) eventsSeen += produced.length;
    events.push(...produced);
  }
  // Very old turns stay out of the replay: the timeline is a reading surface, and
  // the agent keeps the full history on its side regardless.
  return events.length > MAX_EVENTS ? events.slice(events.length - MAX_EVENTS) : events;
}

/**
 * The harness appends one zstd frame per write, and Node's one-shot decoder stops
 * after the first frame. Split on the frame magic so the whole log is read.
 */
function decompressAllFrames(buffer: Buffer): string {
  const starts: number[] = [];
  for (let index = 0; index + 4 <= buffer.length; index++) {
    if (buffer[index] === 0x28 && buffer[index + 1] === 0xb5 && buffer[index + 2] === 0x2f && buffer[index + 3] === 0xfd) {
      starts.push(index);
    }
  }
  if (starts.length === 0) return "";

  const parts: string[] = [];
  for (let frame = 0; frame < starts.length; frame++) {
    const end = frame + 1 < starts.length ? starts[frame + 1] : buffer.length;
    try {
      parts.push(zstdDecompressSync(buffer.subarray(starts[frame], end)).toString("utf8"));
    } catch {
      // A magic sequence inside compressed data: that one frame stays unread.
    }
  }
  return parts.join("");
}

function findLog(sessionId: string, harnessHome: string): string | undefined {
  const root = join(harnessHome, "sessions");
  let buckets: string[];
  try {
    buckets = readdirSync(root);
  } catch {
    return undefined;
  }
  for (const bucket of buckets) {
    const file = join(root, bucket, sessionId, "session.v4.jsonl.zstd");
    if (existsSync(file)) return file;
  }
  return undefined;
}

function convert(event: { type?: string; seq?: number; data?: any }): HistoryUpdate[] {
  const data = event.data ?? {};
  switch (event.type) {
    case "user/message": {
      // The harness stores injected guidance (workspace instructions, runtime
      // context, skill catalog) as user messages; only a real prompt belongs in
      // the replayed conversation.
      if (data.source?.kind !== "user") return [];
      const text = textOf(data.content);
      if (text === "") return [];
      const messageId = typeof data.id === "string" ? data.id : `history-user-${event.seq}`;
      return [{ sessionUpdate: "user_message_chunk", messageId, content: { type: "text", text: clamp(text) } }];
    }

    case "assistant/message": {
      const blocks: any[] = Array.isArray(data.message?.content) ? data.message.content : [];
      const messageId = `history-assistant-${event.seq}`;
      const updates: HistoryUpdate[] = [];
      for (const block of blocks) {
        if (block?.type === "reasoning" && typeof block.text === "string" && block.text.trim() !== "") {
          updates.push({ sessionUpdate: "agent_thought_chunk", messageId, content: { type: "text", text: clamp(block.text) } });
        } else if (block?.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
          updates.push({ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text: clamp(block.text) } });
        }
      }
      return updates;
    }

    case "tool/call": {
      if (typeof data.callId !== "string") return [];
      const name = typeof data.name === "string" ? data.name : "tool";
      return [
        {
          sessionUpdate: "tool_call",
          toolCallId: data.callId,
          title: name,
          kind: "other",
          status: "completed",
          rawInput: parseArguments(data.arguments),
        },
      ];
    }

    case "tool/result": {
      if (typeof data.toolCallId !== "string") return [];
      const text = clamp(textOf(data.content), MAX_TOOL_OUTPUT);
      return [
        {
          sessionUpdate: "tool_call_update",
          toolCallId: data.toolCallId,
          status: "completed",
          content: text === "" ? [] : [{ type: "content", content: { type: "text", text } }],
        },
      ];
    }

    default:
      return [];
  }
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block?.type === "image") parts.push("[image]");
    else if (block?.type === "resource_link" && typeof block.name === "string") parts.push(`[${block.name}]`);
  }
  return parts.join("\n");
}

function parseArguments(raw: unknown): unknown {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { arguments: raw };
  }
}

function clamp(text: string, limit = MAX_TEXT): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
