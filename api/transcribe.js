import { authorized, json, swiss, providers, defaultProvider } from './_lib.js';

const MAX_BYTES = 4_000_000; // Vercel nimmt max. 4.5 MB pro Anfrage

export async function POST(request) {
  if (!authorized(request)) return json({ error: 'Nicht berechtigt' }, 401);

  const name = new URL(request.url).searchParams.get('provider') || defaultProvider();
  const provider = providers[name];
  if (!provider) return json({ error: `Unbekannter Anbieter: ${name}` }, 400);

  const type = request.headers.get('content-type') || 'audio/mp4';
  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength) return json({ error: 'Leere Aufnahme' }, 400);
  if (bytes.byteLength > MAX_BYTES) return json({ error: 'Stück zu gross' }, 413);

  try {
    const text = swiss(await provider(new Blob([bytes], { type })));
    return json({ text, provider: name });
  } catch (e) {
    return json({ error: e.message, provider: name }, 502);
  }
}
