/**
 * Read the provider entry the daemon already resolved, so the plugin honours the
 * same `agents.providers.dsh` settings without duplicating Paseo's config model.
 *
 * The plugin runs with `PASEO_HOME` in its environment and no access to its own
 * directory, so this file is the only reliable place to learn the configured
 * command and environment.
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DshProviderSettings {
  command: readonly [string, ...string[]];
  env: Record<string, string>;
}

const DEFAULT_COMMAND = ["dsh", "--profile", "acp"] as const;

function paseoConfigPath(): string {
  return join(process.env.PASEO_HOME ?? join(homedir(), ".paseo"), "config.json");
}

let cached: { mtimeMs: number; settings: DshProviderSettings } | undefined;

/** Resolve the configured provider entry, falling back to `dsh` on PATH. */
export function dshProviderSettings(): DshProviderSettings {
  const path = paseoConfigPath();
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return { command: DEFAULT_COMMAND, env: {} };
  }
  if (cached?.mtimeMs === mtimeMs) return cached.settings;

  const settings: DshProviderSettings = { command: DEFAULT_COMMAND, env: {} };
  try {
    const entry = JSON.parse(readFileSync(path, "utf8"))?.agents?.providers?.dsh ?? {};
    if (Array.isArray(entry.command)) {
      const parts = entry.command.filter((part: unknown): part is string => typeof part === "string" && part !== "");
      if (parts.length > 0) settings.command = parts as unknown as [string, ...string[]];
    }
    if (entry.env !== null && typeof entry.env === "object" && !Array.isArray(entry.env)) {
      for (const [key, value] of Object.entries(entry.env)) {
        if (typeof value === "string") settings.env[key] = value;
      }
    }
  } catch {
    // A malformed config keeps the defaults; the daemon reports the real error.
  }
  cached = { mtimeMs, settings };
  return settings;
}
