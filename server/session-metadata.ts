/**
 * Session metadata the harness keeps outside the ACP wire.
 *
 * `session/list` reports only a session id and its working directory, so titles and
 * last-activity times come from the harness projection cache, with the session's own
 * directory as a fallback. Reads are cached per file generation because the daemon
 * lists sessions whenever the import panel opens.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface SessionFacts {
  title?: string;
  lastPromptAt?: number;
}

const CACHE_LIMIT = 512;

export class SessionMetadata {
  private readonly cache = new Map<string, { mtimeMs: number; size: number; facts: SessionFacts | null }>();

  constructor(private readonly harnessHome = process.env.DSH_HOME ?? join(homedir(), ".dsh")) {}

  /**
   * Title and last-activity time, or undefined when the harness never checkpointed
   * this session. Only the projection cache counts: a session directory exists from
   * creation, so its mtime would promote empty catalog probes into the import list.
   */
  factsFor(sessionId: string): SessionFacts | undefined {
    return this.fromProjectionCache(sessionId);
  }

  private fromProjectionCache(sessionId: string): SessionFacts | undefined {
    const directory = join(this.harnessHome, "storages", "session_projcache", "sessions");
    for (const name of [`${sessionId}.json`, `session-${sessionId}.json`]) {
      const file = join(directory, name);
      let stat;
      try {
        stat = statSync(file);
      } catch {
        continue;
      }
      const cached = this.cache.get(file);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.facts ?? undefined;

      const facts = readFacts(file);
      this.remember(file, stat.mtimeMs, stat.size, facts);
      if (facts !== null && (facts.title !== undefined || facts.lastPromptAt !== undefined)) return facts;
      // A projection cache that exists but carries neither field is not authoritative:
      // the directory fallback still describes the session.
      return undefined;
    }
    return undefined;
  }

  private remember(file: string, mtimeMs: number, size: number, facts: SessionFacts | null): void {
    if (this.cache.size >= CACHE_LIMIT) this.cache.clear();
    this.cache.set(file, { mtimeMs, size, facts });
  }
}

function readFacts(file: string): SessionFacts | null {
  try {
    const rows = JSON.parse(readFileSync(file, "utf8"))?.record?.rows ?? {};
    const facts: SessionFacts = {};
    const title = rows.title?.val;
    if (typeof title === "string" && title.trim() !== "") {
      facts.title = collapse(title).slice(0, 120);
    } else {
      const firstPrompt = rows.titleInput?.val?.first?.text;
      if (typeof firstPrompt === "string" && firstPrompt.trim() !== "") {
        facts.title = collapse(firstPrompt).slice(0, 80);
      }
    }
    const lastPromptAt = rows.sessionListMetadata?.val?.lastPromptAt;
    if (typeof lastPromptAt === "number" && Number.isFinite(lastPromptAt)) facts.lastPromptAt = lastPromptAt;
    return facts;
  } catch {
    // A torn projection cache must never break the session list.
    return null;
  }
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
