// Minimaler MCP-Server (Streamable HTTP, zustandslos, nur JSON-Antworten).
import { authorized, json } from './_lib.js';
import { listTranscripts, readTranscript } from './_store.js';

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];

const TOOLS = [
  {
    name: 'list_transcripts',
    description:
      'Listet Janoschs Aufnahmen aus der Diktier-App (Diktate, Kundengespräche, Meetings), neueste zuerst: id, Datum, Länge in Sekunden und Textanfang. ' +
      'Dient als Quelle für Infos, mit denen er danach weiterarbeitet.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Anzahl, Standard 20' } },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_transcript',
    description:
      'Gibt den vollständigen Text eines Diktats zurück. id aus list_transcripts. ' +
      'Sprecher sind nicht markiert: Sprechen mehrere Personen, aus Inhalt und Anrede ableiten, wer was sagt, und Unsicheres als Vermutung kennzeichnen.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    annotations: { readOnlyHint: true },
  },
];

const fmtDate = (ms) =>
  new Date(ms).toLocaleString('de-CH', { timeZone: 'Europe/Zurich', dateStyle: 'medium', timeStyle: 'short' });

async function callTool(name, args = {}) {
  if (name === 'list_transcripts') {
    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 20, 1), 100);
    const items = await listTranscripts(limit);
    if (!items.length) return 'Noch keine Diktate gespeichert.';
    return items
      .map((t) => `${t.id} | ${fmtDate(t.createdAt)} | ${Math.round(t.duration)} s | ${t.text.slice(0, 120)}`)
      .join('\n');
  }
  if (name === 'get_transcript') {
    const t = await readTranscript(String(args.id || ''));
    if (!t) throw new Error('Diktat nicht gefunden');
    return `${fmtDate(t.createdAt)}, ${Math.round(t.duration)} s\n\n${t.text}`;
  }
  throw new Error(`Unbekanntes Tool: ${name}`);
}

async function handle(msg) {
  const { id, method, params } = msg;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion;
      return ok({
        protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'diktier-app', version: '1.0.0' },
      });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS });
    case 'tools/call':
      try {
        const text = await callTool(params?.name, params?.arguments);
        return ok({ content: [{ type: 'text', text }] });
      } catch (e) {
        return ok({ content: [{ type: 'text', text: e.message }], isError: true });
      }
    default:
      return fail(-32601, `Methode nicht unterstützt: ${method}`);
  }
}

export async function POST(request) {
  if (!authorized(request, 'MCP_TOKEN')) return json({ error: 'Nicht berechtigt' }, 401);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
  }
  const batch = Array.isArray(body) ? body : [body];
  // Notifications (ohne id) brauchen keine Antwort.
  const replies = (await Promise.all(batch.map((m) => (m.id === undefined ? null : handle(m))))).filter(Boolean);
  if (!replies.length) return new Response(null, { status: 202 });
  return json(Array.isArray(body) ? replies : replies[0]);
}

// Kein Server-Push: GET-Stream wird laut Spezifikation mit 405 abgelehnt.
export const GET = () => new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST' } });
export const DELETE = GET;
