# pi-fast-mode

Request priority processing for all `gpt-*` model IDs on Pi's `openai` and `openai-codex` providers, without changing prompts, tools, or reasoning settings. Whether priority is available is decided by the provider, not by this extension.

## Install

```bash
pi install git:github.com/Vangalle/pi-fast-mode
```

Run `/reload` if Pi is already open. Verified with Pi 1.1.0; requires Node.js 22.19 or newer and Pi's `before_provider_request`, `before_provider_headers`, and `provider_stream_event` hooks.

If you already have the original standalone `fast-mode.ts` (or `pi-fast-mode.ts`) in `~/.pi/agent/extensions`, move it outside that directory before reloading. Load only one copy to avoid duplicate `/fast` commands and handlers. Existing session choices remain compatible.

## Usage

```text
/fast             Toggle priority processing
/fast on          Request priority processing
/fast off         Explicitly request Standard processing
/fast status      Show the selection and last reported response tier
```

Start a session with priority processing requested:

```bash
pi --fast
```

New sessions default to Standard. The selection is saved in the session and follows the active branch when resuming or navigating the session tree. The CLI flag applies on startup or resume, not again on `/reload` or `/new`.

## Scope and limitations

- Allows priority requests for any model ID beginning with `gpt-` on `openai` or `openai-codex`, including mini/nano variants, Codex variants, dated snapshots, and future GPT IDs. No per-model allowlist is maintained. This does not make an unavailable model accessible on a provider.
- Other providers (including OpenRouter and Azure) and non-GPT IDs (including `o*` reasoning models) are unchanged.
- Sends `service_tier: "priority"` when enabled and `"default"` when disabled. Codex requests also receive the corresponding `x-codex-routing-hint` header.
- Preserves prompts, tools, reasoning effort, and client identity headers. Requests whose payload names a different model are left unchanged.
- Reads the reported tier from both Responses terminal events and Chat Completions chunks. A priority request that returns `default` is reported as a Standard fallback; an omitted tier is shown as `not reported`. Later chunks without a tier do not erase a tier already reported by that request. A new eligible request clears the previous observation to avoid showing a stale tier.
- **This requests priority; it cannot guarantee Fast access, lower latency, or subscription eligibility.** The provider may reject the tier for a model or fall back to Standard. This extension does not retry or resubmit requests automatically. Earlier testing of the ChatGPT subscription route returned Standard despite a priority request. API priority processing may have additional costs; check your provider's current pricing and eligibility.
- No runtime dependencies or separate network calls. No credentials or conversation content are stored by this extension; only the enabled/disabled selection is appended to the session.

This is the Vangalle GitHub plugin, not the unrelated npm package with the same name. Use the Git install command above.

## Development

```bash
npm install --ignore-scripts
npm run check
pi -ne -e ./src/pi-fast-mode.ts
```

Tests run offline without model credentials. They cover GPT variants, request tiers, session defaults and restoration, provider/model boundaries, fallback reporting, routing headers, and real Pi Responses, Chat Completions, and Codex adapters. Chat Completions streaming is tested through the real SDK using a fake HTTP response, without network I/O. GitHub Actions checks Node.js 22 and 24.

## License

MIT
