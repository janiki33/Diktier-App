// Diktat: Aufnahme in Stücken, sofort in IndexedDB, Upload-Warteschlange, Verlauf.
const SEG_MS = 30_000;
const MIN_SEG_S = 0.4;
const $ = (id) => document.getElementById(id);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

// ---------- IndexedDB ----------
const db = await new Promise((resolve, reject) => {
  const r = indexedDB.open('diktat', 1);
  r.onupgradeneeded = () => {
    r.result.createObjectStore('sessions', { keyPath: 'id' });
    r.result.createObjectStore('segments', { keyPath: 'key' }).createIndex('session', 'sessionId');
  };
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
function idb(store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}
const put = (store, v) => idb(store, 'readwrite', (s) => s.put(v));
const del = (store, k) => idb(store, 'readwrite', (s) => s.delete(k));
const all = (store) => idb(store, 'readonly', (s) => s.getAll());
const segmentsOf = (id) =>
  idb('segments', 'readonly', (s) => s.index('session').getAll(id)).then((l) => l.sort((a, b) => a.index - b.index));

// ---------- Helfer ----------
const newId = () => Date.now().toString(36).padStart(9, '0') + Math.random().toString(36).slice(2, 8);
const clock = (s) => {
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};
const dateCH = (ms) => {
  const d = new Date(ms);
  return `${d.toLocaleDateString('de-CH')}, ${String(d.getHours()).padStart(2, '0')}.${String(d.getMinutes()).padStart(2, '0')}`;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const token = () => localStorage.getItem('token') || '';
function setStatus(text = '') { $('status').textContent = text; }
function haptic() {
  // iOS 18+: Ein Schalter-Input löst beim Umschalten über das Label eine Vibration aus.
  document.querySelector('.haptic').click();
  navigator.vibrate?.(8);
}
const MIME = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || '';

// ---------- Aufnahme ----------
let rec = null; // laufende Aufnahme
let shownSession = null; // Diktat, dessen Text gerade sichtbar ist

async function getMic() {
  return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
}

async function startRecording() {
  if (!token()) return openSettings();
  let stream;
  try {
    stream = await getMic();
  } catch {
    return setStatus('Mikrofon nicht erlaubt. In den Einstellungen freigeben.');
  }
  const session = { id: newId(), createdAt: Date.now(), duration: 0, state: 'recording', text: '', synced: false };
  await put('sessions', session);
  rec = { session, stream: null, mr: null, index: 0, elapsed: 0, segStart: 0, active: true, interrupted: false, gap: 0 };
  showSession(session.id, true);
  attachStream(stream);
  startSegment();
  document.body.classList.add('recording');
  $('rec').setAttribute('aria-pressed', 'true');
  $('rec').setAttribute('aria-label', 'Aufnahme stoppen');
  setStatus('');
  keepAwake();
  tick();
}

function attachStream(stream) {
  rec.stream = stream;
  const track = stream.getAudioTracks()[0];
  // iOS beendet oder stummt das Mikrofon, wenn die App in den Hintergrund geht.
  track.onended = track.onmute = () => interrupt();
  meter.connect(stream);
}

function startSegment() {
  const r = rec;
  const mr = new MediaRecorder(r.stream, MIME ? { mimeType: MIME } : undefined);
  const seg = {
    key: `${r.session.id}:${String(r.index).padStart(5, '0')}`,
    sessionId: r.session.id, index: r.index++, type: mr.mimeType || MIME || 'audio/mp4',
    duration: 0, gapBefore: r.gap, status: 'recording', text: null, blob: null,
  };
  r.gap = 0;
  const chunks = [];
  const started = performance.now();
  r.segStart = started;
  const save = () => {
    seg.blob = new Blob(chunks, { type: seg.type });
    seg.duration = (performance.now() - started) / 1000;
    return put('segments', seg);
  };
  // Jede Sekunde sichern: Wird die App beendet, bleibt höchstens 1 s verloren.
  mr.ondataavailable = (e) => { if (e.data.size) { chunks.push(e.data); save(); } };
  mr.onstop = async () => {
    clearTimeout(timer);
    r.elapsed += (performance.now() - started) / 1000;
    r.segStart = 0;
    await save();
    seg.status = seg.duration < MIN_SEG_S || !seg.blob.size ? 'done' : 'pending';
    if (seg.status === 'done') seg.text = '';
    await put('segments', seg);
    pump();
    if (r.active && !r.interrupted) startSegment();
    else if (!r.active) finishRecording();
  };
  mr.start(1000);
  r.mr = mr;
  const timer = setTimeout(() => mr.state === 'recording' && mr.stop(), SEG_MS);
}

function stopRecording() {
  if (!rec) return;
  rec.active = false;
  if (rec.mr?.state === 'recording') rec.mr.stop();
  else finishRecording();
}

async function finishRecording() {
  const r = rec;
  if (!r || r.done) return;
  r.done = true;
  r.stream?.getTracks().forEach((t) => t.stop());
  meter.disconnect();
  releaseAwake();
  r.session.duration = r.elapsed;
  r.session.state = 'ended';
  await put('sessions', r.session);
  rec = null;
  document.body.classList.remove('recording');
  $('rec').setAttribute('aria-pressed', 'false');
  $('rec').setAttribute('aria-label', 'Aufnahme starten');
  $('timer').textContent = clock(r.elapsed);
  pump();
}

function interrupt() {
  if (!rec?.active || rec.interrupted) return;
  rec.interrupted = true;
  rec.interruptedAt = Date.now();
  setStatus('iOS hat das Mikrofon angehalten. Es läuft weiter, sobald die App wieder offen ist.');
  if (rec.mr?.state === 'recording') rec.mr.stop();
}

async function resume() {
  if (!rec?.active || !rec.interrupted || rec.resuming) return;
  rec.resuming = true;
  try {
    const old = rec.stream?.getAudioTracks()[0];
    const stream = old && old.readyState === 'live' && !old.muted ? rec.stream : await getMic();
    if (stream !== rec.stream) { rec.stream?.getTracks().forEach((t) => t.stop()); attachStream(stream); }
    rec.gap = (Date.now() - rec.interruptedAt) / 1000;
    rec.interrupted = false;
    setStatus('');
    startSegment();
    keepAwake();
  } catch {
    setStatus('Mikrofon nicht mehr verfügbar. Aufnahme beendet.');
    rec.active = false;
    finishRecording();
  } finally {
    if (rec) rec.resuming = false;
  }
}

function tick() {
  if (!rec) return;
  const live = rec.segStart ? (performance.now() - rec.segStart) / 1000 : 0;
  $('timer').textContent = clock(rec.elapsed + live);
  setTimeout(tick, 250);
}

// Bildschirm wach halten, damit iOS nicht sperrt und das Mikrofon nicht abstellt.
let wakeLock = null;
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* nicht verfügbar */ }
}
function releaseAwake() { wakeLock?.release().catch(() => {}); wakeLock = null; }

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    resume();
    if (rec?.active && !wakeLock) keepAwake();
    pump();
  }
});
addEventListener('online', () => pump());

// ---------- Upload-Warteschlange ----------
let pumping = false;
let retryTimer = null;
let backoff = 2000;

async function transcribe(seg) {
  const r = await fetch('/api/transcribe', {
    method: 'POST',
    headers: { authorization: `Bearer ${token()}`, 'content-type': seg.type },
    body: seg.blob,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || `Fehler ${r.status}`), { status: r.status });
  return data.text || '';
}

async function pump() {
  if (pumping) return;
  pumping = true;
  clearTimeout(retryTimer);
  try {
    const pending = (await all('segments')).filter((s) => s.status === 'pending').sort((a, b) => (a.key < b.key ? -1 : 1));
    for (const seg of pending) {
      try {
        seg.text = await transcribe(seg);
        seg.status = 'done';
        await put('segments', seg);
        backoff = 2000;
        if (seg.sessionId === shownSession) appendText(seg);
      } catch (e) {
        if (e.status === 401) { setStatus('Zugangscode fehlt oder ist falsch.'); return; }
        if (e.status === 400 || e.status === 413) { seg.status = 'done'; seg.text = ''; await put('segments', seg); continue; }
        setStatus(navigator.onLine ? 'Übertragung klappt gerade nicht. Neuer Versuch folgt.' : 'Offline. Die Aufnahme ist gesichert und wird später übertragen.');
        retryTimer = setTimeout(pump, backoff);
        backoff = Math.min(backoff * 2, 60_000);
        return;
      }
    }
    if (!rec?.interrupted) setStatus('');
    await finalize();
  } finally {
    pumping = false;
  }
}

async function finalize() {
  for (const s of await all('sessions')) {
    if (s.state === 'ended') {
      const segs = await segmentsOf(s.id);
      if (segs.some((g) => g.status !== 'done')) continue;
      s.text = segs.map((g) => g.text).filter(Boolean).join(' ');
      s.state = 'final';
      await put('sessions', s);
      await Promise.all(segs.map((g) => del('segments', g.key)));
      if (s.id === shownSession && !s.text) { $('placeholder').hidden = false; $('placeholder').textContent = 'Kein Text erkannt.'; }
    }
    if (s.state === 'final' && !s.synced && s.text) {
      const r = await fetch('/api/transcripts', {
        method: 'POST',
        headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
        body: JSON.stringify({ id: s.id, createdAt: s.createdAt, duration: s.duration, text: s.text }),
      }).catch(() => null);
      if (r?.ok) { s.synced = true; await put('sessions', s); }
    }
  }
  renderHistory();
}

// ---------- Text ----------
let shownText = '';
async function showSession(id, fresh) {
  shownSession = id;
  shownText = '';
  const box = $('transcript');
  box.querySelectorAll('.seg, .gap').forEach((n) => n.remove());
  $('placeholder').hidden = !fresh;
  $('placeholder').textContent = fresh ? 'Ich höre zu.' : '';
  $('actions').hidden = true;
}

function appendText(seg) {
  const box = $('transcript');
  if (seg.gapBefore >= 2) {
    const g = document.createElement('span');
    g.className = 'gap';
    g.textContent = `${clock(seg.gapBefore)} nicht aufgenommen`;
    box.append(g);
  }
  if (!seg.text) return;
  $('placeholder').hidden = true;
  const p = document.createElement('span');
  p.className = 'seg';
  seg.text.split(/\s+/).forEach((word, i) => {
    const w = document.createElement('span');
    w.className = 'w';
    w.textContent = word;
    w.style.animationDelay = `${Math.min(i * 40, 2400)}ms`;
    p.append(w, ' ');
  });
  box.append(p);
  shownText = shownText ? `${shownText} ${seg.text}` : seg.text;
  $('actions').hidden = false;
  box.scrollTo({ top: box.scrollHeight, behavior: reduceMotion.matches ? 'auto' : 'smooth' });
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); haptic(); return true; } catch { return false; }
}
async function shareText(text) {
  if (navigator.share) { try { await navigator.share({ text }); } catch { /* abgebrochen */ } }
  else copyText(text);
}
$('copy').onclick = async () => { if (await copyText(shownText)) flash($('copy'), 'Kopiert'); };
$('share').onclick = () => shareText(shownText);
function flash(btn, label) {
  const old = btn.textContent;
  btn.textContent = label;
  setTimeout(() => (btn.textContent = old), 1400);
}

// ---------- Knopf ----------
const btn = $('rec');
btn.addEventListener('pointerdown', () => btn.classList.add('pressed'));
['pointerup', 'pointercancel', 'pointerleave'].forEach((e) => btn.addEventListener(e, () => btn.classList.remove('pressed')));
let busy = false;
btn.addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  haptic();
  try { rec ? stopRecording() : await startRecording(); } finally { busy = false; }
});

// ---------- Pegel und Ringe ----------
const meter = (() => {
  const canvas = $('rings');
  const g = canvas.getContext('2d');
  let ctx, analyser, source, data, raf = 0;
  let level = 0, vel = 0, fade = 0;
  const size = () => {
    const dpr = devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  size();
  addEventListener('resize', size);

  function frame(t) {
    let target = 0;
    if (analyser) {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
      target = Math.min(1, Math.sqrt(sum / data.length) * 4.5);
    }
    // Feder statt linearem Glätten
    vel += ((target - level) * 0.22 - vel * 0.5);
    level = Math.max(0, level + vel);
    fade += ((rec ? 1 : 0) - fade) * 0.08;

    const w = canvas.clientWidth, h = canvas.clientHeight, cx = w / 2, cy = h / 2;
    g.clearRect(0, 0, w, h);
    const red = getComputedStyle(document.documentElement).getPropertyValue('--red').trim();
    g.strokeStyle = g.fillStyle = red;

    if (reduceMotion.matches) {
      g.globalAlpha = fade * (0.15 + level * 0.5);
      g.lineWidth = 3;
      g.beginPath(); g.arc(cx, cy, 96, 0, Math.PI * 2); g.stroke();
    } else {
      // Wellenform rund um den Knopf
      const n = 96, base = 88;
      g.globalAlpha = fade * 0.16;
      g.beginPath();
      for (let i = 0; i <= n; i++) {
        const a = (i / n) * Math.PI * 2;
        const s = analyser ? (data[(i * 7) % data.length] - 128) / 128 : 0;
        const r = base + 4 + Math.abs(s) * 46 * (0.35 + level) + Math.sin(a * 3 + t / 600) * 2 * level;
        i ? g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r) : g.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      }
      g.closePath(); g.fill();
      // Ringe, die mit der Lautstärke weiter hinausgehen
      g.lineWidth = 1.5;
      for (let i = 0; i < 3; i++) {
        const p = (t / 1800 + i / 3) % 1;
        g.globalAlpha = fade * (1 - p) * (0.12 + level * 0.5);
        g.beginPath(); g.arc(cx, cy, base + 2 + p * (22 + level * 38), 0, Math.PI * 2); g.stroke();
      }
    }
    g.globalAlpha = 1;
    raf = fade > 0.01 || rec ? requestAnimationFrame(frame) : 0;
    if (!raf) g.clearRect(0, 0, w, h);
  }

  return {
    connect(stream) {
      ctx ??= new (window.AudioContext || window.webkitAudioContext)();
      ctx.resume();
      source?.disconnect();
      source = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      data = new Uint8Array(analyser.fftSize);
      source.connect(analyser);
      if (!raf) raf = requestAnimationFrame(frame);
    },
    disconnect() { source?.disconnect(); source = null; analyser = null; },
  };
})();

// ---------- Verlauf ----------
async function renderHistory() {
  const list = $('history');
  const sessions = (await all('sessions')).filter((s) => s.state !== 'recording').sort((a, b) => b.createdAt - a.createdAt);
  list.replaceChildren(...sessions.map(historyItem));
}

function historyItem(s) {
  const li = document.createElement('li');
  li.className = 'item';
  li.innerHTML = `
    <button class="item-delete">Löschen</button>
    <div class="item-body">
      <div class="item-meta"><span></span><span></span></div>
      <p class="item-text"></p>
      <div class="item-tools"><button class="text-btn" data-a="copy">Kopieren</button><button class="text-btn" data-a="share">Teilen</button></div>
    </div>`;
  const [d, len] = li.querySelectorAll('.item-meta span');
  d.textContent = dateCH(s.createdAt);
  len.textContent = clock(s.duration);
  li.querySelector('.item-text').textContent = s.state === 'final' ? s.text || 'Kein Text erkannt.' : 'Wird übertragen …';
  const body = li.querySelector('.item-body');

  li.querySelector('[data-a=copy]').onclick = async (e) => { if (await copyText(s.text)) flash(e.target, 'Kopiert'); };
  li.querySelector('[data-a=share]').onclick = () => shareText(s.text);
  li.querySelector('.item-delete').onclick = async () => {
    haptic();
    li.style.transition = 'opacity .25s';
    li.style.opacity = '0';
    await Promise.all([del('sessions', s.id), ...(await segmentsOf(s.id)).map((g) => del('segments', g.key))]);
    if (s.synced) fetch(`/api/transcripts?id=${encodeURIComponent(s.id)}`, { method: 'DELETE', headers: { authorization: `Bearer ${token()}` } }).catch(() => {});
    setTimeout(() => li.remove(), 250);
  };

  // Nach links wischen zeigt «Löschen», Tippen klappt auf.
  let x0 = 0, y0 = 0, dx = 0, open = false, swiping = false;
  body.addEventListener('pointerdown', (e) => { x0 = e.clientX; y0 = e.clientY; dx = 0; swiping = false; body.setPointerCapture(e.pointerId); });
  body.addEventListener('pointermove', (e) => {
    if (!body.hasPointerCapture(e.pointerId)) return;
    const mx = e.clientX - x0, my = e.clientY - y0;
    if (!swiping && Math.abs(mx) > 8 && Math.abs(mx) > Math.abs(my)) swiping = true;
    if (!swiping) return;
    dx = Math.min(0, mx + (open ? -96 : 0));
    body.style.transition = 'none';
    body.style.transform = `translateX(${Math.max(dx, -160)}px)`;
  });
  body.addEventListener('pointerup', (e) => {
    body.style.transition = '';
    if (swiping) {
      open = dx < -48;
      body.style.transform = open ? 'translateX(-96px)' : '';
    } else if (!e.target.closest('button')) {
      if (open) { open = false; body.style.transform = ''; } else li.classList.toggle('open');
    }
  });
  return li;
}

// Sheet mit Wischgeste
const sheet = $('sheet');
function openSheet() {
  renderHistory();
  document.body.classList.add('sheet-open');
  sheet.setAttribute('aria-hidden', 'false');
  haptic();
}
function closeSheet() {
  sheet.style.transform = '';
  sheet.classList.add('closing');
  document.body.classList.remove('sheet-open');
  sheet.setAttribute('aria-hidden', 'true');
  setTimeout(() => sheet.classList.remove('closing'), 550);
}
$('openHistory').onclick = openSheet;
$('scrim').onclick = closeSheet;
for (const handle of [$('grabber'), sheet.querySelector('.sheet-head')]) {
  let y0 = 0, t0 = 0, dy = 0;
  handle.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    y0 = e.clientY; t0 = performance.now(); dy = 0;
    handle.setPointerCapture(e.pointerId);
    sheet.classList.add('dragging');
  });
  handle.addEventListener('pointermove', (e) => {
    if (!handle.hasPointerCapture(e.pointerId)) return;
    dy = e.clientY - y0;
    // Nach oben mit Widerstand, wie bei iOS
    sheet.style.transform = `translateY(${dy > 0 ? dy : -Math.sqrt(-dy) * 2}px)`;
  });
  handle.addEventListener('pointerup', () => {
    if (!sheet.classList.contains('dragging')) return;
    sheet.classList.remove('dragging');
    const v = dy / Math.max(1, performance.now() - t0);
    if (dy > 140 || v > 0.6) closeSheet();
    else sheet.style.transform = '';
  });
}

// ---------- Zugang ----------
function openSettings() {
  $('token').value = token();
  $('settings').showModal();
}
$('openSettings').onclick = openSettings;
$('settings').addEventListener('close', () => {
  if ($('settings').returnValue === 'save') {
    localStorage.setItem('token', $('token').value.trim());
    setStatus('');
    pump();
  }
});

// ---------- Start ----------
// Abgebrochene Aufnahmen (App weggewischt, iOS beendet) nachholen.
for (const s of await all('sessions')) {
  if (s.state === 'recording') {
    const segs = await segmentsOf(s.id);
    s.duration = segs.reduce((sum, g) => sum + g.duration, 0);
    s.state = 'ended';
    await put('sessions', s);
  }
}
for (const g of await all('segments')) {
  if (g.status === 'recording') {
    g.status = g.blob?.size && g.duration >= MIN_SEG_S ? 'pending' : 'done';
    if (g.status === 'done') g.text = '';
    await put('segments', g);
  }
}
if (!MIME && !window.MediaRecorder) setStatus('Dieser Browser kann nicht aufnehmen.');
pump();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
