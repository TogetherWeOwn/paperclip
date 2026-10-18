import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';

test('provisioning template cannot grant the candidate direct access to the unrestricted proxy', async () => {
  const script = await readFile(new URL('./provision-github-shadow-host.sh', import.meta.url), 'utf8');
  assert.match(script, /--dports 3100,8318 -j ACCEPT/);
  assert.doesNotMatch(script, /--dports [^\n]*8317/);
});
import { createShadowModelProxy, SHADOW_PROXY_POLICY } from './github-shadow-model-proxy.mjs';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}
test('restricted model route rejects provider tools and arbitrary endpoints before upstream I/O', async () => {
  let upstreamCalls = 0;
  const upstream = createServer((req, res) => { upstreamCalls++; res.end('{}'); });
  const upstreamUrl = await listen(upstream);
  const proxy = createShadowModelProxy({ token: 'shadow-only', upstreamToken: 'private-upstream', upstreamUrl });
  const url = await listen(proxy);
  try {
    const base = { model: 'fixture', max_tokens: 1, messages: [{ role: 'user', content: 'test' }] };
    for (const extra of [
      { tools: [{ type: 'web_search_20250305', name: 'web_search' }] },
      { tools: [{ type: 'web_fetch_20250910', name: 'web_fetch' }] },
      // A schema does not turn a provider-executed tool into a local tool (N12).
      { tools: [{ type: 'web_search_20250305', name: 'web_search', input_schema: { type: 'object' } }] },
      { tools: [{ type: 'web_fetch_20250910', name: 'web_fetch', input_schema: { type: 'object' } }] },
      { tools: [{ type: 'computer_20250124', name: 'computer' }] },
      { mcp_servers: [{ type: 'url', url: 'https://github.com' }] },
      { unknown_provider_extension: true },
      { messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'url', url: 'https://github.com' } }] }] },
      { messages: [{ role: 'user', content: [{ type: 'server_tool_use', name: 'web_search', input: {} }] }] },
    ]) {
      const response = await fetch(`${url}/v1/messages`, { method: 'POST', headers: { authorization: 'Bearer shadow-only' }, body: JSON.stringify({ ...base, ...extra }) });
      assert.equal(response.status, 403);
      assert.equal(response.headers.get('x-paperclip-shadow-policy'), SHADOW_PROXY_POLICY);
    }
    for (const path of ['/v1/responses', '/admin', '/v1/messages?tool=web_search']) {
      assert.equal((await fetch(`${url}${path}`, { method: 'POST', headers: { authorization: 'Bearer shadow-only' }, body: JSON.stringify(base) })).status, 403);
    }
    assert.equal((await fetch(`${url}/v1/messages`, { method: 'POST', body: JSON.stringify(base) })).status, 401);
    assert.equal(upstreamCalls, 0);
  } finally { await Promise.all([new Promise(r => proxy.close(r)), new Promise(r => upstream.close(r))]); }
});
test('restricted model route forwards only client tools, preserving stream bytes and isolating credentials', async () => {
  let observed;
  const upstream = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    observed = { headers: req.headers, body: JSON.parse(body), path: req.url };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('event: message\ndata: {"ok":true}\n\n');
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createShadowModelProxy({ token: 'shadow-only', upstreamToken: 'private-upstream', upstreamUrl });
  const url = await listen(proxy);
  const body = { model: 'fixture', stream: true, max_tokens: 1, messages: [], tools: [{ name: 'Bash', description: 'shell', input_schema: { type: 'object' } }] };
  try {
    const response = await fetch(`${url}/v1/messages?beta=true`, { method: 'POST', headers: { 'x-api-key': 'shadow-only', 'x-forwarded-host': 'github.com', 'anthropic-beta': 'unsafe-server-tools' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'event: message\ndata: {"ok":true}\n\n');
    assert.deepEqual(observed.body, body);
    assert.equal(observed.headers.authorization, 'Bearer private-upstream');
    assert.equal(observed.headers['x-api-key'], undefined);
    assert.equal(observed.headers['x-forwarded-host'], undefined);
    assert.equal(observed.headers['anthropic-beta'], undefined);
    assert.equal(observed.path, '/v1/messages');
  } finally { await Promise.all([new Promise(r => proxy.close(r)), new Promise(r => upstream.close(r))]); }
});
