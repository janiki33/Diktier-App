import { del } from '@vercel/blob';
import { authorized, json } from './_lib.js';
import { saveTranscript, validId } from './_store.js';

export async function POST(request) {
  if (!authorized(request)) return json({ error: 'Nicht berechtigt' }, 401);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Ungültiges JSON' }, 400);
  }
  const { id, createdAt, duration, text } = body || {};
  if (!validId(id) || typeof text !== 'string' || !Number.isFinite(createdAt) || !Number.isFinite(duration)) {
    return json({ error: 'Felder id, createdAt, duration, text nötig' }, 400);
  }
  if (text.length > 500_000) return json({ error: 'Text zu lang' }, 413);
  return json(await saveTranscript({ id, createdAt, duration, text }));
}

export async function DELETE(request) {
  if (!authorized(request)) return json({ error: 'Nicht berechtigt' }, 401);
  const id = new URL(request.url).searchParams.get('id');
  if (!validId(id)) return json({ error: 'Ungültige id' }, 400);
  await del(`transcripts/${id}.json`);
  return json({ ok: true });
}
