/**
 * ACP connector for DeepSeek Harness.
 *
 * The harness speaks ACP v1 over stdio, but three things Paseo needs are missing or
 * misnamed on that wire:
 *
 * 1. `session/list` reports only `{ sessionId, cwd }`, so the import list would show
 *    untitled rows with an epoch date. The harness does persist a title and a
 *    last-prompt time, so this connector fills both in.
 * 2. Every catalog probe leaves a persisted session behind that carries no title and
 *    no activity, and one ACP page holds a hundred of them. The connector pages
 *    through the harness list itself and returns only sessions with metadata.
 * 3. The harness resumes persisted sessions but never advertises `loadSession`, and
 *    Paseo treats a provider as importable only when that flag is set. The connector
 *    advertises it and answers `session/load` with `session/resume`, which has the
 *    same response shape and likewise does not replay history.
 *
 * Running in-process (rather than as a child command) keeps the plugin free of any
 * machine-specific path, which is what makes it distributable.
 */
import { spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import type { AcpConnector, AcpStream, AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import { StringDecoder } from "node:string_decoder";
import { dshProviderSettings } from "./paseo-config";
import { SessionMetadata } from "./session-metadata";

const INNER_ID_PREFIX = "dsh-connector-";
/** Paseo times a plugin provider request out at 30 s. */
const LIST_TOTAL_BUDGET_MS = 20_000;
const LIST_PAGE_TIMEOUT_MS = 8_000;
const LIST_MAX_PAGES = 10;
const LIST_MAX_ENTRIES = 200;
const EXIT_GRACE_MS = 1_000;

interface SessionEntry {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export function createDshConnector(metadata = new SessionMetadata()): AcpConnector {
  return () => openStream(metadata);
}

function openStream(metadata: SessionMetadata): AcpStream {
  const settings = dshProviderSettings();
  const child = spawnProcess(settings.command[0], settings.command.slice(1), {
    env: { ...process.env, ...settings.env },
    stdio: "pipe",
  });

  const pendingInner = new Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  let sequence = 0;
  let closed = false;
  let emit: (message: AcpStreamMessage) => void = () => undefined;
  let closeReadable: () => void = () => undefined;
  const queued: AcpStreamMessage[] = [];

  const deliver = (message: AcpStreamMessage) => {
    if (closed) return;
    if (queued.length > 0 || emit === undefined) queued.push(message);
    else emit(message);
  };

  const fail = (error: Error) => {
    for (const entry of pendingInner.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pendingInner.clear();
  };

  const shutdown = (signal: NodeJS.Signals = "SIGTERM") => {
    if (closed) return;
    closed = true;
    fail(new Error("ACP connector closed"));
    try {
      child.stdin?.end();
    } catch {
      // The harness may already have exited.
    }
    terminateProcess(child);
    const forced = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }, EXIT_GRACE_MS);
    forced.unref?.();
  };

  // --- harness to Paseo -------------------------------------------------------

  const clientDecoder = new StringDecoder("utf8");
  let clientBuffer = "";

  const onHarnessFrame = (frame: AcpStreamMessage & { id?: string | number | null }) => {
    const id = frame.id;
    if (typeof id === "string" && pendingInner.has(id)) {
      const entry = pendingInner.get(id)!;
      pendingInner.delete(id);
      clearTimeout(entry.timer);
      if ("error" in frame && frame.error) entry.reject(new Error(frame.error.message));
      else entry.resolve((frame as { result?: Record<string, unknown> }).result ?? {});
      return;
    }
    if (typeof id === "string" && id.startsWith(INNER_ID_PREFIX)) {
      // A late answer to a timed-out inner request must never reach the client.
      return;
    }
    if (typeof id === "string" || typeof id === "number") explainResumeError(frame, id, rewrittenLoads);
    if ("result" in frame) advertiseLoadSession(frame);
    deliver(frame as AcpStreamMessage);
  };

  const onHarnessText = (chunk: string) => {
    clientBuffer += chunk;
    let newline;
    while ((newline = clientBuffer.indexOf("\n")) >= 0) {
      const line = clientBuffer.slice(0, newline).trim();
      clientBuffer = clientBuffer.slice(newline + 1);
      if (line === "") continue;
      try {
        onHarnessFrame(JSON.parse(line));
      } catch {
        // Not a protocol frame; drop it rather than corrupting the client's parser.
      }
    }
  };

  child.stdout.on("data", (chunk: Buffer) => onHarnessText(clientDecoder.write(chunk)));
  child.stdout.on("end", () => onHarnessText(clientDecoder.end()));
  // The harness writes diagnostics to stderr; Paseo does not surface them.
  child.stderr.on("data", () => undefined);
  child.stdout.on("error", () => shutdown());
  child.stdin.on("error", () => shutdown());
  child.on("error", () => shutdown());
  child.on("exit", () => {
    closed = true;
    fail(new Error("DeepSeek Harness exited"));
    try {
      closeReadable();
    } catch {
      // Already closed by the consumer.
    }
  });

  // --- Paseo to harness -------------------------------------------------------

  const writeRaw = (frame: unknown) => {
    if (closed) return;
    child.stdin.write(`${JSON.stringify(frame)}\n`);
  };

  const innerRequest = (method: string, params: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = `${INNER_ID_PREFIX}${++sequence}`;
      const timer = setTimeout(() => {
        pendingInner.delete(id);
        reject(new Error(`DeepSeek Harness did not answer ${method} in time`));
      }, LIST_PAGE_TIMEOUT_MS);
      timer.unref?.();
      pendingInner.set(id, { resolve, reject, timer });
      writeRaw({ jsonrpc: "2.0", id, method, params });
    });

  const answer = (id: string | number, message: Record<string, unknown>) => {
    deliver({ jsonrpc: "2.0", id, ...message } as AcpStreamMessage);
  };

  const runList = async (id: string | number, params: Record<string, unknown>) => {
    const requested = typeof params.limit === "number" && params.limit > 0 ? params.limit : LIST_MAX_ENTRIES;
    const wanted = Math.min(requested, LIST_MAX_ENTRIES);
    const cwd = typeof params.cwd === "string" ? params.cwd : undefined;
    const deadline = Date.now() + LIST_TOTAL_BUDGET_MS;
    const sessions: SessionEntry[] = [];
    let cursor = typeof params.cursor === "string" ? params.cursor : undefined;
    let exhausted = false;

    for (let page = 0; page < LIST_MAX_PAGES; page++) {
      if (Date.now() > deadline) break;
      let result: Record<string, unknown>;
      try {
        result = await innerRequest("session/list", {
          ...(cwd === undefined ? {} : { cwd }),
          ...(cursor === undefined ? {} : { cursor }),
        });
      } catch (error) {
        if (sessions.length > 0) break;
        answer(id, { error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
        return;
      }
      const pageSessions = Array.isArray(result.sessions) ? (result.sessions as SessionEntry[]) : [];
      for (const raw of pageSessions) {
        const entry = enrich(metadata, raw);
        if (entry.title === undefined && entry.updatedAt === undefined) continue;
        sessions.push(entry);
        if (sessions.length >= wanted) break;
      }
      cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
      if (sessions.length >= wanted || cursor === undefined) {
        exhausted = cursor === undefined;
        break;
      }
    }

    answer(id, {
      result: {
        sessions: sessions.slice(0, wanted),
        ...(exhausted || cursor === undefined ? {} : { nextCursor: cursor }),
      },
    });
  };

  const onClientFrame = (frame: AcpStreamMessage) => {
    const request = frame as { method?: string; id?: string | number | null; params?: Record<string, unknown> };
    if (typeof request.method === "string" && request.id !== undefined && request.id !== null) {
      if (request.method === "session/load") {
        rewrittenLoads.add(request.id);
        writeRaw({ ...frame, method: "session/resume" });
        return;
      }
      if (request.method === "session/list") {
        void runList(request.id, request.params ?? {});
        return;
      }
    }
    writeRaw(frame);
  };

  /** Ids whose `session/load` became `session/resume`, so its errors can be explained. */
  const rewrittenLoads = new Set<string | number>();

  const readable = new ReadableStream<AcpStreamMessage>({
    start(streamController) {
      closeReadable = () => streamController.close();
      emit = (message) => streamController.enqueue(message);
      for (const message of queued.splice(0)) streamController.enqueue(message);
    },
    cancel() {
      shutdown();
    },
  });

  const writable = new WritableStream<AcpStreamMessage>({
    write(message) {
      onClientFrame(message);
    },
    close() {
      shutdown("SIGTERM");
    },
    abort() {
      shutdown("SIGKILL");
    },
  });

  liveChildren.add(child);
  child.on("exit", () => liveChildren.delete(child));

  return { readable, writable };
}

/** Fill in the two ACP fields the harness leaves out of a list entry. */
function enrich(metadata: SessionMetadata, raw: SessionEntry): SessionEntry {
  if (typeof raw?.sessionId !== "string" || typeof raw?.cwd !== "string") return raw;
  const facts = metadata.factsFor(raw.sessionId);
  if (!facts) return raw;
  const entry: SessionEntry = { ...raw };
  if (entry.title === undefined && facts.title !== undefined) entry.title = facts.title;
  if (entry.updatedAt === undefined && facts.lastPromptAt !== undefined) {
    entry.updatedAt = new Date(facts.lastPromptAt).toISOString();
  }
  return entry;
}

/**
 * The harness refuses a resume while the desktop app still writes that session, and
 * Paseo only shows the generic message. Fold the harness detail into the message so
 * the import failure says what to do about it.
 */
function explainResumeError(
  frame: AcpStreamMessage,
  id: string | number,
  rewrittenLoads: Set<string | number>,
): void {
  if (!rewrittenLoads.delete(id)) return;
  const error = (frame as { error?: { message?: string; data?: { details?: unknown } } }).error;
  if (!error || typeof error.message !== "string") return;
  const details = error.data?.details;
  if (typeof details !== "string" || details === "") return;
  if (error.message.includes(details)) return;
  error.message = `${error.message}: ${details}`;
}

/** Paseo gates importability on `loadSession`, which the harness omits. */
function advertiseLoadSession(frame: AcpStreamMessage): void {
  const result = (frame as { result?: { agentCapabilities?: Record<string, unknown> } }).result;
  const capabilities = result?.agentCapabilities;
  if (!capabilities || capabilities.loadSession === true) return;
  result!.agentCapabilities = { ...capabilities, loadSession: true };
}

/** Harness processes still alive, killed if the plugin process is torn down. */
const liveChildren = new Set<ReturnType<typeof spawnProcess>>();

process.on("exit", () => {
  for (const child of liveChildren) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
});
