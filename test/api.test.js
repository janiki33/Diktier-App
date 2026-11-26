import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.APP_TOKEN = 'app-secret';
process.env.MCP_TOKEN = 'mcp-secret';
process.env.OPENAI_API_KEY = 'sk-test';
process.env.ELEVENLABS_API_KEY = 'el-test';

const { swiss, authorized } = await import('../api/_lib.js');
const transcribe = await import('../api/transcribe.js');
const mcp = await import('../api/mcp.js');

const audio = (q = '', tok = 'app-secret') =>
  new Request(`https://x.test/api/transcribe${q}`, {
    method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'audio/mp4' }, body: new Uint8Array([1, 2, 3]),
  });

test('ss statt ß', () => {
  assert.equal(swiss(' Grüße, Straße '), 'Grüsse, Strasse');
});

test('Token: Header oder Query, getrennt für App und MCP', () => {
  assert.ok(authorized(new Request('https://x.test/', { headers: { authorization: 'Bearer app-secret' } })));
  assert.ok(authorized(new Request('https://x.test/?token=mcp-secret'), 'MCP_TOKEN'));
  assert.ok(!authorized(new Request('https://x.test/?token=app-secret'), 'MCP_TOKEN'));
  assert.ok(!authorized(new Request('https://x.test/')));
});

test('Transkription: falscher Token wird abgewiesen', async () => {
  assert.equal((await transcribe.POST(audio('', 'falsch'))).status, 401);
});

test('Transkription: Anbieter wählbar, Ausgabe ohne ß', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ text: 'Schöne Grüße aus Luzern' }), { status: 200 });
  };
  const r1 = await (await transcribe.POST(audio())).json();
  assert.equal(r1.provider, 'openai');
  assert.equal(r1.text, 'Schöne Grüsse aus Luzern');
  assert.match(calls[0].url, /openai\.com/);
  assert.equal(calls[0].init.body.get('language'), 'de');

  const r2 = await (await transcribe.POST(audio('?provider=elevenlabs'))).json();
  assert.equal(r2.provider, 'elevenlabs');
  assert.match(calls[1].url, /elevenlabs\.io/);
  assert.equal(calls[1].init.headers['xi-api-key'], 'el-test');

  assert.equal((await transcribe.POST(audio('?provider=gibtsnicht'))).status, 400);
});

test('Transkription: Anbieterfehler kommt als 502 zurück', async () => {
  globalThis.fetch = async () => new Response('kaputt', { status: 500 });
  const r = await transcribe.POST(audio());
  assert.equal(r.status, 502);
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
