import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATE_TYPE = "fast-mode";
const PROVIDERS = new Set(["openai", "openai-codex"]);

// Eligibility to request a tier is not a guarantee that the provider grants it.
function canRequestFast(model: ExtensionContext["model"]): boolean {
  return Boolean(model && PROVIDERS.has(model.provider) && model.id.startsWith("gpt-"));
}

/** User-selectable service tier. Task instructions, tools and reasoning are unchanged. */
export default function fastMode(pi: ExtensionAPI): void {
  let enabled = false;
  let requestedFast = false;
  let observed: { tier: string; requestedFast: boolean } | undefined;

  pi.registerFlag("fast", {
    description: "Request priority processing for openai/openai-codex gpt-* models in this session",
    type: "boolean",
    default: false,
  });

  function updateStatus(ctx: ExtensionContext): void {
    const state = canRequestFast(ctx.model) ? (enabled ? "ON" : "OFF") : "inactive";
    const result = observed ? ` · last: ${observed.tier}` : "";
    ctx.ui.setStatus(STATE_TYPE, `Fast: ${state}${result}`);
  }

  function describe(ctx: ExtensionContext): string {
    const selection = enabled ? "ON (priority requested)" : "OFF (Standard requested)";
    const scope = canRequestFast(ctx.model)
      ? ` for ${ctx.model!.id}`
      : "; inactive for the current model (requests priority for openai/openai-codex gpt-* models)";
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
    if (!canRequestFast(ctx.model) || !payload || typeof payload !== "object" || Array.isArray(payload)) return;
    const body = payload as Record<string, unknown>;
    // Do not change requests routed to another physical model by an extension.
    if (body.model !== ctx.model!.id) return;
    requestedFast = enabled;
    // A new request must not inherit a tier from the previous response.
    observed = undefined;
    updateStatus(ctx);
    // Explicit default also overrides any API-project default of Fast.
    return { ...body, service_tier: enabled ? "priority" : "default" };
  });

  pi.on("before_provider_headers", (event, ctx) => {
    // Codex's subscription backend also routes by this header (client.rs).
    // Pi invokes this hook before before_provider_request, during auth resolution.
    if (ctx.model?.provider === "openai-codex" && canRequestFast(ctx.model)) {
      event.headers["x-codex-routing-hint"] = `model=${ctx.model.id};tier=${enabled ? "priority" : "default"}`;
    }
  });

  pi.on("provider_stream_event", (event, ctx) => {
    if (!canRequestFast(ctx.model) || event.provider !== ctx.model!.provider || event.model !== ctx.model!.id) return;
    if (!event.data || typeof event.data !== "object" || Array.isArray(event.data)) return;
    const data = event.data as {
      type?: unknown;
      object?: unknown;
      response?: { service_tier?: unknown } | null;
      service_tier?: unknown;
    };
    let tier: unknown;
    if (data.type === "response.completed" || data.type === "response.done") {
      tier = data.response?.service_tier;
    } else if (event.api === "openai-completions" && data.object === "chat.completion.chunk") {
      tier = data.service_tier;
      // Some chunks (including trailing usage chunks) omit the tier; retain one already reported.
      if ((typeof tier !== "string" || tier.length === 0) && observed) return;
    } else {
      return;
    }
    const reported = typeof tier === "string" && tier.length > 0 ? tier : "not reported";
    // Avoid updating the status for every token when chunks repeat the same tier.
    if (observed?.tier === reported && observed.requestedFast === requestedFast) return;
    observed = { tier: reported, requestedFast };
    updateStatus(ctx);
  });
}
