import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fetchBalance, formatBalance } from "./balance.ts";
import { fetchCodexUsage, formatCodexUsage } from "./codex.ts";
import { UsageError } from "./request.ts";
import { UsagePanel } from "./ui.ts";

export default function usageExtension(pi: ExtensionAPI): void {
  let pending: AbortController | undefined;
  let panel: UsagePanel | undefined;

  pi.on("session_shutdown", () => {
    pending?.abort();
    pending = undefined;
    panel?.close();
    panel = undefined;
  });

  pi.registerCommand("usage", {
    description: "Show usage for the current model's provider (balance or quota)",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      if (args.trim()) {
        ctx.ui.notify("Usage: /usage (uses the current model's provider)", "error");
        return;
      }
      const provider = ctx.model?.provider;
      if (!provider) {
        ctx.ui.notify("No model selected. Use /model to select a DeepSeek or Codex model.", "error");
        return;
      }
      if (provider !== "deepseek" && provider !== "openai-codex") {
        const name = /^[a-z0-9_.-]{1,80}$/i.test(provider) ? `provider "${provider}"` : "the current provider";
        ctx.ui.notify(`Usage lookup is not supported for ${name}. Supported: deepseek, openai-codex.`, "error");
        return;
      }
      if (pending) {
        ctx.ui.notify("Usage view or query is already open.", "info");
        return;
      }

      // Reserve the command before custom UI creation, which may be asynchronous.
      const controller = new AbortController();
      pending = controller;
      let current: UsagePanel | undefined;
      const query = async (signal: AbortSignal) => {
        signal.throwIfAborted();
        // Delegate all credential sources and precedence to the running Pi instance.
        const apiKey = await ctx.modelRegistry.getApiKeyForProvider(provider);
        signal.throwIfAborted();
        if (!apiKey) {
          throw new UsageError(provider === "deepseek"
            ? "No DeepSeek API key available. Use /login deepseek or set DEEPSEEK_API_KEY."
            : "No Codex OAuth access token available. Use /login openai-codex in Pi.");
        }
        return provider === "deepseek" ? fetchBalance({ apiKey }, signal) : fetchCodexUsage(apiKey, signal);
      };

      try {
        if (ctx.mode === "tui") {
          await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
            current = new UsagePanel({
              title: provider === "deepseek" ? "DeepSeek balance" : "Codex usage",
              theme,
              keybindings,
              requestRender: () => tui.requestRender(),
              done: () => done(),
              query,
            });
            if (controller.signal.aborted) {
              // A delayed factory must not open a panel or query an old session.
              current.close();
            } else {
              panel = current;
              void current.refresh();
            }
            return current;
          });
        } else {
          const details = await query(controller.signal);
          if (!controller.signal.aborted) {
            if ("balance_infos" in details) {
              ctx.ui.notify(formatBalance(details), details.is_available ? "info" : "warning");
            } else {
              ctx.ui.notify(formatCodexUsage(details), details.limitReached ? "warning" : "info");
            }
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          ctx.ui.notify(error instanceof UsageError ? error.message : "Failed to fetch usage.", "error");
        }
      } finally {
        current?.dispose();
        if (panel === current) panel = undefined;
        if (pending === controller) pending = undefined;
      }
    },
  });
}
