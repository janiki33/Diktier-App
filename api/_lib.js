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

// Schweizer Schreibweise: kein ß.
export const swiss = (text) => text.replace(/ß/g, 'ss').replace(/ẞ/g, 'SS').trim();

const PROMPT =
  'Aufnahme auf Schweizerdeutsch. Schreibe den Inhalt in Hochdeutsch mit Schweizer Rechtschreibung, ' +
  'also immer ss statt ß. Satzzeichen setzen.';

function extFor(type) {
  if (type.includes('mp4') || type.includes('aac') || type.includes('m4a')) return 'm4a';
  if (type.includes('webm')) return 'webm';
  if (type.includes('ogg')) return 'ogg';
  if (type.includes('wav')) return 'wav';
  return 'mp3';
}

// Jeder Anbieter: (Blob) -> Text. Neuen Anbieter hier ergänzen, fertig.
export const providers = {
  async openai(audio) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error('OPENAI_API_KEY fehlt');
    const form = new FormData();
    form.append('file', audio, `audio.${extFor(audio.type)}`);
    form.append('model', process.env.OPENAI_MODEL || 'gpt-4o-transcribe');
    form.append('language', 'de');
    form.append('prompt', PROMPT);
    form.append('response_format', 'json');
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: form,
    });
    if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return (await r.json()).text || '';
  },

  async elevenlabs(audio) {
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) throw new Error('ELEVENLABS_API_KEY fehlt');
    const form = new FormData();
    form.append('file', audio, `audio.${extFor(audio.type)}`);
    form.append('model_id', process.env.ELEVENLABS_MODEL || 'scribe_v2');
    form.append('language_code', process.env.ELEVENLABS_LANGUAGE || 'de');
    form.append('tag_audio_events', 'false');
    const r = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': key },
      body: form,
    });
    if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return (await r.json()).text || '';
  },
};

export const defaultProvider = () => process.env.STT_PROVIDER || 'openai';
