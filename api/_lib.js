// Gemeinsame Helfer für alle Serverfunktionen.

// App und MCP haben getrennte Tokens: Der MCP-Token steckt in der Connector-URL bei claude.ai.
export function authorized(request, envName = 'APP_TOKEN') {
  const token = process.env[envName];
  if (!token) return false; // ohne gesetzten Token ist alles gesperrt
  const url = new URL(request.url);
  const header = request.headers.get('authorization') || '';
  const given = header.replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || '';
  return timingSafeEqual(given, token);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
