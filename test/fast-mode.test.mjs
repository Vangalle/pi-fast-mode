import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { SessionManager } from '@earendil-works/pi-coding-agent';
import factory from '../src/pi-fast-mode.ts';

const catalogUrl = new URL('./providers/data/openai-codex.json', import.meta.resolve('@earendil-works/pi-ai/models'));
const catalog = JSON.parse(fs.readFileSync(catalogUrl, 'utf8'));
const sol = catalog['openai-codex-responses']['chat:gpt-6.1-sol'];

function harness({ manager = SessionManager.inMemory(), model = sol, fastFlag = false } = {}) {
  const handlers = new Map();
  const commands = new Map();
  const notifications = [];
  const statuses = new Map();
  const ctx = {
    model, sessionManager: manager,
    ui: {
      setStatus: (key, value) => statuses.set(key, value),
      notify: (message, type) => notifications.push({ message, type }),
    },
  };
  factory({
    on: (name, fn) => {
      const list = handlers.get(name) ?? [];
      list.push(fn);
      handlers.set(name, list);
    },
    registerCommand: (name, command) => commands.set(name, command),
    registerFlag: () => {},
    getFlag: () => fastFlag,
    appendEntry: (type, data) => manager.appendCustomEntry(type, data),
  });
  const emit = async (name, event = {}) => {
    let payload = event.payload;
    for (const fn of handlers.get(name) ?? []) {
      const result = await fn({ type: name, ...event, payload }, ctx);
      if (result !== undefined) payload = result;
    }
    return payload;
  };
  return { ctx, manager, notifications, statuses, emit,
    command: async (args) => commands.get('fast')?.handler(args, ctx),
  };
}

test('Fast on emits priority and off explicitly restores Standard without changing the task', async () => {
  const h = harness();
  await h.emit('session_start', { reason: 'startup' });
  const original = { model: 'gpt-6.1-sol', input: [{ role: 'user', content: 'Fix the bug' }],
    tools: [{ name: 'read' }], reasoning: { effort: 'high' }, service_tier: 'flex' };
  await h.command('on');
  assert.deepEqual(await h.emit('before_provider_request', { payload: original }),
    { ...original, service_tier: 'priority' });
  assert.equal(original.service_tier, 'flex');
  await h.command('off');
  assert.deepEqual(await h.emit('before_provider_request', { payload: original }),
    { ...original, service_tier: 'default' });
});

test('new sessions stay Standard while --fast enables only the requested session', async () => {
  const normal = harness();
  await normal.emit('session_start', { reason: 'startup' });
  assert.equal((await normal.emit('before_provider_request', { payload: { model: sol.id } })).service_tier, 'default');
  const fast = harness({ fastFlag: true });
  await fast.emit('session_start', { reason: 'startup' });
  assert.equal((await fast.emit('before_provider_request', { payload: { model: sol.id } })).service_tier, 'priority');
  await fast.command('off');
  await fast.emit('session_start', { reason: 'reload' });
  assert.equal((await fast.emit('before_provider_request', { payload: { model: sol.id } })).service_tier, 'default');
});

test('Fast selection survives resume and follows the active session branch', async () => {
  const first = harness();
  await first.command('on');
  const enabledEntry = first.manager.getLeafId();
  await first.command('off');
  const resumed = harness({ manager: first.manager });
  await resumed.emit('session_start', { reason: 'resume' });
  assert.equal((await resumed.emit('before_provider_request', { payload: { model: sol.id } })).service_tier, 'default');
  assert.ok(enabledEntry, 'Fast selection must be saved in the session');
  first.manager.branch(enabledEntry);
  await resumed.emit('session_tree');
  assert.equal((await resumed.emit('before_provider_request', { payload: { model: sol.id } })).service_tier, 'priority');
});

// Catches reintroducing a finite model allowlist or dropping the default tier on GPT variants.
for (const provider of ['openai', 'openai-codex']) {
  for (const id of ['gpt-4o', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-5-codex',
    'gpt-5.1-codex-mini', 'gpt-4o-2024-08-06', 'gpt-6-sol', 'gpt-future-preview']) {
    test(`${provider}/${id} accepts Fast and explicit Standard requests`, async () => {
      const h = harness({ model: { ...sol, provider, id } });
      await h.emit('session_start', { reason: 'startup' });
      assert.equal(h.statuses.get('fast-mode'), 'Fast: OFF');
      const payload = { model: id, service_tier: 'flex', input: ['unchanged'] };
      for (const [mode, tier] of [['on', 'priority'], ['off', 'default']]) {
        await h.command(mode);
        assert.deepEqual(await h.emit('before_provider_request', { payload }),
          { ...payload, service_tier: tier });
        const headers = { originator: 'pi' };
        await h.emit('before_provider_headers', { headers });
        assert.deepEqual(headers, provider === 'openai-codex'
          ? { originator: 'pi', 'x-codex-routing-hint': `model=${id};tier=${tier}` }
          : { originator: 'pi' });
      }
      assert.equal(payload.service_tier, 'flex');
    });
  }
}

test('unrelated providers, models and mismatched payloads keep their existing tier', async () => {
  for (const model of [{ ...sol, provider: 'anthropic' }, { ...sol, provider: 'openrouter' },
    { ...sol, provider: 'azure-openai-responses' }, { ...sol, id: 'unsupported-model' },
    { ...sol, id: 'o3' }, { ...sol, id: 'not-gpt-5' }, { ...sol, id: 'gpt' }, sol]) {
    const h = harness({ model });
    await h.command('on');
    const payload = { model: model === sol ? 'other-model' : model.id, service_tier: 'flex' };
    assert.strictEqual(await h.emit('before_provider_request', { payload }), payload);
  }
});

test('status reports an observed Standard fallback instead of claiming Fast was delivered', async () => {
  const h = harness();
  await h.command('on');
  await h.emit('before_provider_request', { payload: { model: sol.id } });
  await h.emit('provider_stream_event', { provider: 'openai-codex', api: sol.api, model: sol.id,
    data: { type: 'response.completed', response: { service_tier: 'default' } } });
  await h.command('status');
  assert.match(h.notifications.at(-1)?.message ?? '', /default/);
  assert.match(h.notifications.at(-1)?.message ?? '', /fallback/i);
});

test('Codex subscription routing hint follows the payload tier and preserves client identity', async () => {
  const h = harness();
  for (const [mode, tier] of [['on', 'priority'], ['off', 'default']]) {
    await h.command(mode);
    const headers = { originator: 'pi', 'User-Agent': 'pi-test', Authorization: 'offline-test' };
    // Pi's Models.applyAuth transforms headers before the adapter builds its payload.
    await h.emit('before_provider_headers', { headers });
    assert.deepEqual(headers, { originator: 'pi', 'User-Agent': 'pi-test', Authorization: 'offline-test',
      'x-codex-routing-hint': `model=${sol.id};tier=${tier}` });
    assert.equal((await h.emit('before_provider_request', { payload: { model: sol.id } })).service_tier, tier);
  }
  h.ctx.model = { ...sol, id: 'other-model' };
  const unrelated = { originator: 'pi' };
  await h.emit('before_provider_headers', { headers: unrelated });
  assert.deepEqual(unrelated, { originator: 'pi' });
  const api = harness({ model: { ...sol, provider: 'openai' } });
  await api.command('on');
  await api.emit('before_provider_request', { payload: { model: sol.id } });
  const apiHeaders = {};
  await api.emit('before_provider_headers', { headers: apiHeaders });
  assert.deepEqual(apiHeaders, {});
});

// Catches ignoring top-level Chat Completions tiers or erasing them on trailing usage chunks.
function completionChunk(model, fields = {}) {
  return { id: 'chatcmpl-offline', object: 'chat.completion.chunk', created: 0, model: model.id,
    choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: null }], ...fields };
}

for (const api of ['openai-responses', 'openai-codex-responses', 'openai-completions']) {
  for (const tier of ['priority', 'default', undefined]) {
    test(`${api} reports ${tier ?? 'not reported'} without claiming priority was delivered`, async () => {
      // Keep the already-supported Sol ID to isolate event parsing from model matching.
      const model = { ...sol, api };
      const h = harness({ model });
      await h.command('on');
      await h.emit('before_provider_request', { payload: { model: model.id } });
      const data = api === 'openai-completions'
        ? completionChunk(model, { service_tier: tier })
        : { type: 'response.completed', response: { service_tier: tier } };
      await h.emit('provider_stream_event', { provider: model.provider, api, model: model.id, data });
      if (api === 'openai-completions') {
        await h.emit('provider_stream_event', { provider: model.provider, api, model: model.id,
          data: completionChunk(model, { service_tier: null, choices: [],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) });
      }
      assert.equal(h.statuses.get('fast-mode'), `Fast: ON · last: ${tier ?? 'not reported'}`);
      await h.command('status');
      assert.equal(/Standard fallback/.test(h.notifications.at(-1).message), tier === 'default');
    });
  }
}

test('a completion without a tier must not reuse the previous request tier', async () => {
  const model = { ...sol, api: 'openai-completions' };
  const h = harness({ model });
  await h.command('on');
  for (const tier of ['priority', undefined]) {
    await h.emit('before_provider_request', { payload: { model: model.id } });
    await h.emit('provider_stream_event', { provider: model.provider, api: model.api, model: model.id,
      data: completionChunk(model, { service_tier: tier }) });
  }
  assert.equal(h.statuses.get('fast-mode'), 'Fast: ON · last: not reported');
});

test('unrelated stream events cannot overwrite the observed tier', async () => {
  const h = harness();
  await h.command('on');
  await h.emit('before_provider_request', { payload: { model: sol.id } });
  const event = { provider: sol.provider, api: sol.api, model: sol.id,
    data: { type: 'response.done', response: { service_tier: 'priority' } } };
  await h.emit('provider_stream_event', event);
  for (const patch of [{ provider: 'openrouter' }, { model: 'other-model' },
    { data: { type: 'response.created', response: { service_tier: 'default' } } },
    { data: completionChunk(sol, { service_tier: 'default' }) },
    { data: null }, { data: [] }]) {
    await h.emit('provider_stream_event', { ...event, ...patch });
    assert.equal(h.statuses.get('fast-mode'), 'Fast: ON · last: priority');
  }
});

test('the real Chat Completions adapter sends GPT tiers and reports an observed fallback offline', async () => {
  const { stream } = await import('@earendil-works/pi-ai/api/openai-completions');
  const model = { ...sol, provider: 'openai', id: 'gpt-4o', api: 'openai-completions',
    baseUrl: 'https://api.openai.com/v1', reasoning: false };
  const h = harness({ model });
  const captured = [];
  for (const mode of ['on', 'off']) {
    await h.command(mode);
    const result = stream(model, { messages: [{ role: 'user', content: 'Say OK.', timestamp: 1 }] }, {
      apiKey: 'offline-test', maxRetries: 0,
      onPayload: (payload) => h.emit('before_provider_request', { payload }),
      onProviderStreamEvent: (data) => h.emit('provider_stream_event',
        { provider: model.provider, api: model.api, model: model.id, data }),
      // Only the HTTP boundary is replaced; the SDK and Pi adapter parse real SSE frames.
      fetch: async (input, init) => {
        const request = new Request(input, init);
        assert.equal(request.url, 'https://api.openai.com/v1/chat/completions');
        captured.push(await request.json());
        const chunks = [completionChunk(model, { service_tier: 'default',
          choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }] }),
          completionChunk(model, { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })];
        const sse = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
        return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      },
    });
    assert.equal((await result.result()).stopReason, 'stop');
    assert.equal(h.statuses.get('fast-mode'), `Fast: ${mode === 'on' ? 'ON' : 'OFF'} · last: default`);
    await h.command('status');
    assert.equal(/Standard fallback/.test(h.notifications.at(-1).message), mode === 'on');
  }
  assert.deepEqual(captured.map((body) => body.service_tier), ['priority', 'default']);
  assert.deepEqual(captured.map((body) => body.model), ['gpt-4o', 'gpt-4o']);
});

test('the real Responses adapter constructs GPT mini priority and Standard requests offline', async () => {
  const { stream } = await import('@earendil-works/pi-ai/api/openai-responses');
  const openaiCatalog = JSON.parse(fs.readFileSync(new URL('./openai.json', catalogUrl), 'utf8'));
  const model = openaiCatalog['openai-responses']['chat:gpt-4.1-mini'];
  const h = harness({ model });
  const captured = [];
  for (const mode of ['on', 'off']) {
    await h.command(mode);
    const result = stream(model, { messages: [{ role: 'user', content: 'Say OK.', timestamp: 1 }] }, {
      apiKey: 'offline-test', maxRetries: 0,
      onPayload: async (payload) => {
        captured.push(await h.emit('before_provider_request', { payload }));
        throw new Error('Offline payload capture complete');
      },
    });
    await result.result();
  }
  assert.deepEqual(captured.map((body) => body.service_tier), ['priority', 'default']);
  assert.deepEqual(captured.map((body) => body.model), ['gpt-4.1-mini', 'gpt-4.1-mini']);
});

test('the real Pi Codex adapter constructs priority then default requests with high reasoning', async () => {
  const { stream } = await import('@earendil-works/pi-ai/api/openai-codex-responses');
  const h = harness();
  const jwt = `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'offline-test' } })).toString('base64url')}.signature`;
  const captured = [];
  for (const mode of ['on', 'off']) {
    await h.command(mode);
    const result = stream(sol, { messages: [
      { role: 'system', content: 'Test only.', timestamp: 0 },
      { role: 'user', content: 'Say OK.', timestamp: 1 },
    ] }, { apiKey: jwt, reasoningEffort: 'high', transport: 'sse',
      onPayload: async (payload) => {
        captured.push(await h.emit('before_provider_request', { payload }));
        // Stop before authentication headers or network I/O; inspect the real adapter payload.
        throw new Error('Offline payload capture complete');
      },
    });
    await result.result();
  }
  assert.deepEqual(captured.map((p) => p.service_tier), ['priority', 'default']);
  assert.deepEqual(captured.map((p) => p.reasoning.effort), ['high', 'high']);
  assert.equal(captured[0].model, 'gpt-6.1-sol');
  assert.equal(captured[0].instructions, 'Test only.');
});
