import { put, list, get } from '@vercel/blob';

const PREFIX = 'transcripts/';
const ID = /^[A-Za-z0-9_-]{6,64}$/;

export const validId = (id) => typeof id === 'string' && ID.test(id);

export async function saveTranscript({ id, createdAt, duration, text }) {
  const doc = { id, createdAt, duration, text };
  await put(`${PREFIX}${id}.json`, JSON.stringify(doc), {
    access: 'private',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
  });
  return doc;
}

export async function readTranscript(id) {
  if (!validId(id)) return null;
  const res = await get(`${PREFIX}${id}.json`, { access: 'private', useCache: false });
  if (!res || res.statusCode !== 200) return null;
  return JSON.parse(await new Response(res.stream).text());
}

// Neueste zuerst. Die ID beginnt mit der Zeit, darum reicht der Pfad zum Sortieren.
export async function listTranscripts(limit = 20) {
  const items = [];
  let cursor;
  do {
    const page = await list({ prefix: PREFIX, cursor, limit: 1000 });
    items.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  items.sort((a, b) => (a.pathname < b.pathname ? 1 : -1));
  const ids = items.slice(0, limit).map((b) => b.pathname.slice(PREFIX.length, -'.json'.length));
  return (await Promise.all(ids.map(readTranscript))).filter(Boolean);
}
