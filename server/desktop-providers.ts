/**
 * Reuse the model providers added in the DeepSeek Harness desktop app.
 *
 * The desktop app writes "add model provider" into its own profile
 * (`$DSH_HOME/profiles/desktop/cordis.patch.yml`, entry `id: llm-pi-ai`), while this
 * plugin boots the separate `acp` profile. Profiles are isolated on purpose (different
 * bundles, UI settings, permission defaults); only `~/.dsh/.credentials.yaml` is shared.
 * So the provider list is the one thing worth carrying over: this module copies that
 * single entry into a content-addressed overlay file, and the connector passes it to
 * the harness as `--patch`, which applies after the profile's own layer.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dshProviderSettings } from "./paseo-config";

/** The loader patch entry that holds the user's custom model providers. */
export const PROVIDERS_ENTRY_ID = "llm-pi-ai";
/** Superseded overlays older than this are removed; younger ones may still be booting. */
const STALE_OVERLAY_MS = 10 * 60_000;

export interface ProvidersOverlay {
  /** Overlay file to pass as `--patch`. */
  path: string;
  /** Content hash of the copied entry, stable while the desktop list is unchanged. */
  hash: string;
}

export function dshHome(env: Record<string, string | undefined>): string {
  return env.DSH_HOME && env.DSH_HOME !== "" ? env.DSH_HOME : join(homedir(), ".dsh");
}

/**
 * Pick one top-level entry out of a dsh patch list by id.
 *
 * dsh writes patch files as a block-style YAML sequence whose entries start with `-`
 * in column 0, so a line scan is enough and keeps the plugin free of a YAML parser.
 * Returns undefined when the entry is missing or the file is not in that shape.
 */
export function extractPatchEntry(source: string, id: string): string | undefined {
  const lines = source.split(/\r?\n/);
  const blocks: string[][] = [];
  let current: string[] | undefined;
  for (const line of lines) {
    if (/^- /.test(line)) {
      current = [line];
      blocks.push(current);
    } else if (/^\S/.test(line) && !line.startsWith("#")) {
      // Any other column-0 content (a bare `-`, flow style, a mapping) ends the
      // sequence this scan understands; the entry is then simply not inherited.
      current = undefined;
    } else if (current) {
      current.push(line);
    }
  }
  const idLine = new RegExp(`^(?:- +| +)id: *(["']?)${escapeRegExp(id)}\\1 *(?:#.*)?$`);
  const block = blocks.find((candidate) => {
    // Only the entry's own keys count: the first line, or lines indented like it.
    const indent = /^- +/.exec(candidate[0])![0].length;
    return candidate.some((line, index) =>
      index === 0 ? idLine.test(line) : line.startsWith(" ".repeat(indent)) && !line.startsWith(" ".repeat(indent + 1)) && idLine.test(line),
    );
  });
  if (!block) return undefined;
  while (block.length > 0 && /^\s*(#.*)?$/.test(block[block.length - 1])) block.pop();
  return `${block.join("\n")}\n`;
}

/**
 * Write the desktop profile's providers entry as an overlay, or return undefined when
 * there is nothing to inherit. Never throws: a missing or odd desktop profile simply
 * leaves the harness on its own profile.
 *
 * The overlay lives under `$DSH_HOME` (user-only, unlike a shared /tmp) and is
 * rewritten on every launch, so a file someone else placed there is never trusted.
 */
export function desktopProvidersOverlay(
  sourceProfile: string,
  env: Record<string, string | undefined>,
): ProvidersOverlay | undefined {
  try {
    const home = dshHome(env);
    const source = readFileSync(join(home, "profiles", sourceProfile, "cordis.patch.yml"), "utf8");
    const entry = extractPatchEntry(source, PROVIDERS_ENTRY_ID);
    if (entry === undefined) return undefined;
    const hash = createHash("sha256").update(entry).digest("hex").slice(0, 16);
    const directory = join(home, "cache", "paseo-dsh-provider");
    const name = `${PROVIDERS_ENTRY_ID}-${hash}.yml`;
    const path = join(directory, name);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const staging = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(
      staging,
      `# Copied by paseo-dsh-provider from profiles/${sourceProfile}/cordis.patch.yml; do not edit.\n${entry}`,
      { mode: 0o600 },
    );
    renameSync(staging, path);
    removeStaleOverlays(directory, name);
    return { path, hash };
  } catch {
    return undefined;
  }
}

function removeStaleOverlays(directory: string, keep: string): void {
  const cutoff = Date.now() - STALE_OVERLAY_MS;
  for (const name of readdirSync(directory)) {
    if (name === keep || !name.startsWith(`${PROVIDERS_ENTRY_ID}-`)) continue;
    try {
      const file = join(directory, name);
      if (statSync(file).mtimeMs < cutoff) unlinkSync(file);
    } catch {
      // Another connection may have removed it first.
    }
  }
}

/**
 * Where `--patch <overlay>` goes: right after the `--profile <name>` pair, where
 * launcher flags belong. Undefined for a command without that pair, or one that
 * already boots the source profile.
 */
export function overlayInsertIndex(command: readonly string[], sourceProfile: string): number | undefined {
  const index = command.indexOf("--profile");
  if (index < 1 || index + 1 >= command.length) return undefined;
  if (command[index + 1] === sourceProfile) return undefined;
  return index + 2;
}

export interface DshLaunch {
  command: readonly [string, ...string[]];
  env: Record<string, string | undefined>;
  /**
   * Identity of what shapes the model catalogue, for Paseo's cache key. Undefined
   * without an overlay, which keeps Paseo's default per-workspace caching.
   */
  catalogKey: string | undefined;
}

/** Resolve the harness command for a new connection, inherited providers included. */
export function dshLaunch(): DshLaunch {
  const settings = dshProviderSettings();
  const env = { ...process.env, ...settings.env };
  const source = settings.inheritProvidersFrom;
  const at = source === null ? undefined : overlayInsertIndex(settings.command, source);
  const overlay = at === undefined ? undefined : desktopProvidersOverlay(source!, env);
  if (at === undefined || overlay === undefined) {
    return { command: settings.command, env, catalogKey: undefined };
  }
  const [executable, ...args] = settings.command;
  const command: [string, ...string[]] = [
    executable,
    ...args.slice(0, at - 1),
    "--patch",
    overlay.path,
    ...args.slice(at - 1),
  ];
  // Hashed so configured environment values (possibly secrets) never leave the plugin.
  const catalogKey = createHash("sha256")
    .update(JSON.stringify({ command, env: settings.env }))
    .digest("hex")
    .slice(0, 32);
  return { command, env, catalogKey };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
