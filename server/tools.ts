import type { AcpToolCallSnapshot, AcpTransformer } from "@getpaseo/plugin/server/acp";
import { z } from "zod";

/**
 * DeepSeek Harness reports every tool call as ACP `kind: "other"` with its own
 * snake_case arguments, so Paseo can only render a generic row. This transformer
 * rewrites the kind and the argument names Paseo reads, which turns file edits and
 * writes into diff rows.
 *
 * `detail` is honoured by Paseo 0.17 and later and ignored by 0.16, so both `kind`
 * and `detail` are supplied: 0.16 renders the edit it understands, newer hosts
 * also get the shell, read, search and fetch cards.
 */

type DetailedSnapshot = AcpToolCallSnapshot & { detail?: unknown };

const writeInput = z.object({ file_path: z.string(), content: z.string() });
const editInput = z.object({
  file_path: z.string(),
  old_string: z.string(),
  new_string: z.string(),
});
const readInput = z.object({ file_path: z.string() });
const bashInput = z.object({ command: z.string(), cwd: z.string().optional() });
const globInput = z.object({ pattern: z.string().optional(), path: z.string().optional() });
const grepInput = z.object({ pattern: z.string().optional(), path: z.string().optional() });
const webSearchInput = z.object({
  query: z.string().optional(),
  queries: z.array(z.string()).optional(),
});
const webFetchInput = z.object({ url: z.string(), prompt: z.string().optional() });

function rewrite(
  snapshot: AcpToolCallSnapshot,
  patch: Partial<AcpToolCallSnapshot>,
  detail: unknown,
): AcpToolCallSnapshot {
  return { ...snapshot, ...patch, detail } as DetailedSnapshot;
}

export const dshTools: AcpTransformer = {
  toolCall(toolCall) {
    const name = (toolCall.name ?? toolCall.title).toLowerCase();

    switch (name) {
      case "write": {
        const input = writeInput.safeParse(toolCall.input);
        if (!input.success) return toolCall;
        const { file_path: filePath, content } = input.data;
        return rewrite(toolCall, { kind: "edit", input: { filePath, newString: content } }, {
          type: "write",
          filePath,
          content,
        });
      }

      case "edit": {
        const input = editInput.safeParse(toolCall.input);
        if (!input.success) return toolCall;
        const filePath = input.data.file_path;
        const oldString = input.data.old_string;
        const newString = input.data.new_string;
        return rewrite(toolCall, { kind: "edit", input: { filePath, oldString, newString } }, {
          type: "edit",
          filePath,
          oldString,
          newString,
        });
      }

      case "read":
      case "read_image": {
        const input = readInput.safeParse(toolCall.input);
        if (!input.success) return toolCall;
        const filePath = input.data.file_path;
        return rewrite(toolCall, { kind: "read", input: { filePath } }, { type: "read", filePath });
      }

      case "bash": {
        const input = bashInput.safeParse(toolCall.input);
        if (!input.success) return toolCall;
        return rewrite(toolCall, { kind: "execute" }, {
          type: "shell",
          command: input.data.command,
          cwd: input.data.cwd,
        });
      }

      case "glob":
      case "grep": {
        const input = (name === "glob" ? globInput : grepInput).safeParse(toolCall.input);
        if (!input.success) return toolCall;
        const pattern = input.data.pattern;
        if (pattern === undefined) return toolCall;
        return rewrite(toolCall, { kind: "search" }, {
          type: "search",
          query: pattern,
          toolName: name,
        });
      }

      case "web_search": {
        const input = webSearchInput.safeParse(toolCall.input);
        if (!input.success) return toolCall;
        const query = input.data.query ?? input.data.queries?.[0];
        if (query === undefined) return toolCall;
        return rewrite(toolCall, { kind: "search" }, {
          type: "search",
          query,
          toolName: "web_search",
        });
      }

      case "web_fetch": {
        const input = webFetchInput.safeParse(toolCall.input);
        if (!input.success) return toolCall;
        return rewrite(toolCall, { kind: "fetch" }, {
          type: "fetch",
          url: input.data.url,
          prompt: input.data.prompt,
        });
      }

      default:
        return toolCall;
    }
  },
};
