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

test('unrelated providers, models and mismatched payloads keep their existing tier', async () => {
  for (const model of [{ ...sol, provider: 'anthropic' }, { ...sol, id: 'unsupported-model' }, sol]) {
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
