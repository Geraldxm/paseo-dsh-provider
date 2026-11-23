import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import type { ProviderRegistration } from "@getpaseo/plugin/server/provider";
import { createDshConnector } from "./connector";
import { dshTools } from "./tools";

/**
 * DeepSeek Harness as an ACP provider.
 *
 * The connector owns the harness process, so this plugin carries no machine-specific
 * path: `dsh --profile acp` is spawned from PATH, and `agents.providers.dsh` in
 * `~/.paseo/config.json` can replace the command or add environment. The profile is
 * created from the shipped template on first launch and shares `~/.dsh` credentials
 * with the desktop app, so the provider needs no key of its own.
 */
export function createDshProvider(): ProviderRegistration {
  return runAcpProvider({
    id: "dsh",
    label: "DeepSeek Harness",
    description: "DeepSeek Harness over ACP (`dsh --profile acp`)",
    icon: "icon.svg",
    connector: createDshConnector(),
    transformers: [dshTools],
    acpOptions: { startupTimeoutMs: 20_000 },
  });
}
