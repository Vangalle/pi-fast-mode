import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATE_TYPE = "fast-mode";
const MODELS = new Set(["gpt-6.1-sol", "gpt-6-sol"]);
const PROVIDERS = new Set(["openai", "openai-codex"]);

function supportsFast(model: ExtensionContext["model"]): boolean {
  return Boolean(model && PROVIDERS.has(model.provider) && MODELS.has(model.id));
}

/** User-selectable service tier. Task instructions, tools and reasoning are unchanged. */
export default function fastMode(pi: ExtensionAPI): void {
  let enabled = false;
  let requestedFast = false;
  let observed: { tier: string; requestedFast: boolean } | undefined;

  pi.registerFlag("fast", {
    description: "Request Fast processing for GPT-6.1 Sol or GPT-6 Sol in this session",
    type: "boolean",
    default: false,
  });

  function updateStatus(ctx: ExtensionContext): void {
    const state = supportsFast(ctx.model) ? (enabled ? "ON" : "OFF") : "inactive";
    const result = observed ? ` · last: ${observed.tier}` : "";
    ctx.ui.setStatus(STATE_TYPE, `Fast: ${state}${result}`);
  }

  function describe(ctx: ExtensionContext): string {
    const selection = enabled ? "ON (priority requested)" : "OFF (Standard requested)";
    const scope = supportsFast(ctx.model)
      ? ` for ${ctx.model!.id}`
      : "; inactive for the current model (supports openai/openai-codex GPT-6.1 Sol and GPT-6 Sol)";
    const fallback = observed?.requestedFast && observed.tier === "default" ? " (Standard fallback)" : "";
    const result = observed ? ` Last response: ${observed.tier}${fallback}.` : " Response tier has not been reported yet.";
    return `Fast ${selection}${scope}.${result}`;
  }

  function persist(): void {
    pi.appendEntry(STATE_TYPE, { enabled });
  }

  function restore(ctx: ExtensionContext): void {
    enabled = false;
    requestedFast = false;
    observed = undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
      const data = entry.data as { enabled?: unknown } | undefined;
      if (typeof data?.enabled === "boolean") enabled = data.enabled;
    }
    updateStatus(ctx);
  }

  pi.on("session_start", (event, ctx) => {
    restore(ctx);
    // A command-line choice applies at process startup, not again after /reload or /new.
    if ((event.reason === "startup" || event.reason === "resume") && pi.getFlag("fast") === true) {
      enabled = true;
      persist();
      updateStatus(ctx);
    }
  });

  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("model_select", (_event, ctx) => {
    observed = undefined;
    updateStatus(ctx);
  });

  pi.registerCommand("fast", {
    description: "Toggle Fast processing, or use /fast on, /fast off, /fast status",
    handler: async (args, ctx) => {
      const mode = args.trim().toLowerCase();
      if (mode === "status") {
        ctx.ui.notify(describe(ctx), "info");
        return;
      }
      if (mode !== "" && mode !== "on" && mode !== "off") {
        ctx.ui.notify("Usage: /fast [on|off|status]", "info");
        return;
      }
      enabled = mode === "" ? !enabled : mode === "on";
      persist();
      updateStatus(ctx);
      ctx.ui.notify(describe(ctx), "info");
    },
  });

  pi.on("before_provider_request", (event, ctx) => {
    const payload = event.payload;
    if (!supportsFast(ctx.model) || !payload || typeof payload !== "object" || Array.isArray(payload)) return;
    const body = payload as Record<string, unknown>;
    // Do not change requests routed to another physical model by an extension.
    if (body.model !== ctx.model!.id) return;
    requestedFast = enabled;
    // Explicit default also overrides any API-project default of Fast.
    return { ...body, service_tier: enabled ? "priority" : "default" };
  });

  pi.on("before_provider_headers", (event, ctx) => {
    // Codex's subscription backend also routes by this header (client.rs).
    // Pi invokes this hook before before_provider_request, during auth resolution.
    if (ctx.model?.provider === "openai-codex" && supportsFast(ctx.model)) {
      event.headers["x-codex-routing-hint"] = `model=${ctx.model.id};tier=${enabled ? "priority" : "default"}`;
    }
  });

  pi.on("provider_stream_event", (event, ctx) => {
    if (!supportsFast(ctx.model) || event.provider !== ctx.model!.provider || event.model !== ctx.model!.id) return;
    const data = event.data as { type?: string; response?: { service_tier?: unknown } } | null;
    if (!data || (data.type !== "response.completed" && data.type !== "response.done")) return;
    const tier = data.response?.service_tier;
    observed = { tier: typeof tier === "string" ? tier : "not reported", requestedFast };
    updateStatus(ctx);
  });
}
