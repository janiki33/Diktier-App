import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.APP_TOKEN = 'app-secret';
process.env.MCP_TOKEN = 'mcp-secret';

const { authorized } = await import('../api/_lib.js');
const transcripts = await import('../api/transcripts.js');
const mcp = await import('../api/mcp.js');

test('Token: Header oder Query, getrennt für App und MCP', () => {
  assert.ok(authorized(new Request('https://x.test/', { headers: { authorization: 'Bearer app-secret' } })));
  assert.ok(authorized(new Request('https://x.test/?token=mcp-secret'), 'MCP_TOKEN'));
  assert.ok(!authorized(new Request('https://x.test/?token=app-secret'), 'MCP_TOKEN'));
  assert.ok(!authorized(new Request('https://x.test/')));
});

test('Ablage: falscher Token und ungültige Felder werden abgewiesen', async () => {
  const req = (body, tok = 'app-secret') =>
    new Request('https://x.test/api/transcripts', { method: 'POST', headers: { authorization: `Bearer ${tok}` }, body: JSON.stringify(body) });
  assert.equal((await transcripts.POST(req({}, 'falsch'))).status, 401);
  assert.equal((await transcripts.POST(req({ id: '../x', createdAt: 1, duration: 1, text: 'a' }))).status, 400);
  assert.equal((await transcripts.POST(req({ id: 'abcdef12', createdAt: 1, duration: 1 }))).status, 400);
});

const rpc = (body, tok = 'mcp-secret') =>
  mcp.POST(new Request(`https://x.test/api/mcp?token=${tok}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));

test('MCP: initialize, tools/list, Notification, Auth', async () => {
  const init = await (await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })).json();
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.ok(init.result.capabilities.tools);

  const list = await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
  assert.deepEqual(list.result.tools.map((t) => t.name), ['list_transcripts', 'get_transcript']);

  assert.equal((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  assert.equal((await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, 'app-secret')).status, 401);

  const bad = await (await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_transcript', arguments: { id: '../x' } } })).json();
  assert.equal(bad.result.isError, true);
  assert.equal(mcp.GET().status, 405);
});
