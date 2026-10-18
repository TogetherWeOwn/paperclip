import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

export const SHADOW_PROXY_POLICY = 'client-tools-only-v1';
const fields = new Set(['model', 'max_tokens', 'messages', 'system', 'metadata', 'stop_sequences', 'stream',
  'temperature', 'thinking', 'tools', 'tool_choice', 'top_k', 'top_p', 'output_config', 'context_management']);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const hash = value => createHash('sha256').update(value).digest();
function localInputsOnly(value) {
  if (Array.isArray(value)) return value.every(localInputsOnly);
  if (!object(value)) return true;
  if (typeof value.type === 'string' && /^(url|server_tool_use|web_|mcp_)/.test(value.type)) return false;
  if ('image_url' in value || 'file_url' in value) return false;
  return Object.values(value).every(localInputsOnly);
}
function allowed(body, models) {
  return object(body) && localInputsOnly(body.messages) && localInputsOnly(body.system) && Object.keys(body).every(k => fields.has(k))
    && typeof body.model === 'string' && models.has(body.model) && Array.isArray(body.messages)
    && (body.context_management === undefined || object(body.context_management)
      && Object.keys(body.context_management).every(k => k === 'edits')
      && Array.isArray(body.context_management.edits)
      && body.context_management.edits.every(edit => object(edit)
        && typeof edit.type === 'string' && /^clear_(thinking|tool_uses)_\d{8}$/.test(edit.type)))
    && (body.tools === undefined || Array.isArray(body.tools) && body.tools.every(tool =>
      object(tool) && (tool.type === undefined || tool.type === 'custom')
        && typeof tool.name === 'string' && object(tool.input_schema)
        && Object.keys(tool).every(k => ['type', 'name', 'description', 'input_schema', 'cache_control', 'strict', 'defer_loading'].includes(k))))
    && (body.tool_choice === undefined || object(body.tool_choice) && ['auto', 'any', 'none', 'tool'].includes(body.tool_choice.type));
}

/** Dedicated shadow credentials never authorize the unrestricted upstream. The
 * shadow UID's firewall MUST deny upstream port 8317 and allow only this 8318
 * listener. This process must run as a DIFFERENT, trusted UID. */
export function createShadowModelProxy({ token, upstreamToken, allowedModels, upstreamUrl = 'http://127.0.0.1:8317' }) {
  if (!Array.isArray(allowedModels) || !allowedModels.length
    || !allowedModels.every(model => typeof model === 'string' && model.trim() === model && model.length > 0)) {
    throw new Error('Explicit arm model allowlist required');
  }
  const models = new Set(allowedModels);
  if (!token || !upstreamToken || token === upstreamToken) throw new Error('Distinct proxy credentials required');
  if (!/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(upstreamUrl)) throw new Error('Loopback upstream required');
  return createServer(async (req, res) => {
    const reply = (status, error) => { res.writeHead(status, { 'content-type': 'application/json', 'x-paperclip-shadow-policy': SHADOW_PROXY_POLICY }); res.end(JSON.stringify({ error })); };
    const supplied = typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : (req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (!timingSafeEqual(hash(supplied), hash(token))) return reply(401, 'unauthorized');
    // The SDK beta path is the same messages operation, not an arbitrary query
    // escape. Strip the flag upstream and apply the identical body allowlist.
    if (req.method !== 'POST' || !['/v1/messages', '/v1/messages?beta=true'].includes(req.url)) return reply(403, 'shadow_proxy_route_denied');
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 8 * 1024 * 1024) return reply(413, 'request_too_large'); chunks.push(chunk); }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reply(400, 'invalid_json'); }
      if (!allowed(body, models)) return reply(403, 'shadow_proxy_provider_tools_denied');
      const response = await fetch(`${upstreamUrl}/v1/messages`, { method: 'POST', redirect: 'error', signal: abort.signal,
        headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', authorization: `Bearer ${upstreamToken}` },
        body: JSON.stringify(body) });
      res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/json' });
      if (response.body) await pipeline(Readable.fromWeb(response.body), res); else res.end();
    } catch { if (!res.headersSent) reply(502, 'upstream_unavailable'); else res.destroy(); }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createShadowModelProxy({ token: process.env.PAPERCLIP_GITHUB_SHADOW_PROXY_TOKEN,
    upstreamToken: process.env.PAPERCLIP_GITHUB_SHADOW_UPSTREAM_TOKEN,
    allowedModels: JSON.parse(process.env.PAPERCLIP_GITHUB_SHADOW_ALLOWED_MODELS ?? '[]') }).listen(8318, '127.0.0.1');
}
