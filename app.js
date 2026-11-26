// Diktat: Spracherkennung von iOS-Safari (de-CH), Text laufend in IndexedDB, Verlauf, Kopie auf dem Server für Claude.
const $ = (id) => document.getElementById(id);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

// ---------- IndexedDB ----------
const db = await new Promise((resolve, reject) => {
  const r = indexedDB.open('diktat', 2);
  r.onupgradeneeded = () => {
    const d = r.result;
    if (!d.objectStoreNames.contains('sessions')) d.createObjectStore('sessions', { keyPath: 'id' });
    if (d.objectStoreNames.contains('segments')) d.deleteObjectStore('segments');
  };
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction('sessions', mode);
    const req = fn(t.objectStore('sessions'));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}
const put = (v) => idb('readwrite', (s) => s.put(v));
const del = (k) => idb('readwrite', (s) => s.delete(k));
const all = () => idb('readonly', (s) => s.getAll());

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
const swiss = (t) => t.replace(/ß/g, 'ss').replace(/\s+/g, ' ').trim();
const join = (a, b) => swiss(`${a} ${b}`);
const token = () => localStorage.getItem('token') || '';
const setStatus = (text = '') => { $('status').textContent = text; };
function haptic() {
  // iOS 18+: Ein Schalter-Input löst beim Umschalten über das Label eine Vibration aus.
  document.querySelector('.haptic').click();
  navigator.vibrate?.(8);
}

// ---------- Aufnahme ----------
let rec = null; // laufendes Diktat

async function startRecording() {
  const session = { id: newId(), createdAt: Date.now(), duration: 0, text: '', state: 'recording', synced: false };
  await put(session);
  rec = { session, active: true, t0: performance.now(), before: '', current: '', recog: null, restarts: 0 };
  resetView('Ich höre zu.');
  document.body.classList.add('recording');
  $('rec').setAttribute('aria-pressed', 'true');
  $('rec').setAttribute('aria-label', 'Aufnahme stoppen');
  setStatus('');
  if (SR) listen();
  else keyboardMode();
  keepAwake();
  tick();
}

function listen() {
  const r = new SR();
  r.lang = 'de-CH';
  r.continuous = true;
  r.interimResults = true;
  r.onaudiostart = () => meter.start();
  r.onresult = (e) => {
    if (rec?.recog !== r) return;
    // Jedes Mal die ganze Liste lesen: Safari meldet resultIndex und isFinal nicht immer sauber.
    let finals = '', interim = '';
    for (const res of e.results) (res.isFinal ? (finals += ` ${res[0].transcript}`) : (interim += ` ${res[0].transcript}`));
    rec.current = swiss(finals);
    rec.restarts = 0;
    meter.bump();
    render(join(rec.before, rec.current), swiss(interim));
    save();
  };
  r.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      setStatus('Spracherkennung nicht erlaubt. In den Einstellungen Mikrofon und Spracherkennung für Safari freigeben.');
      rec && (rec.active = false);
    } else if (e.error === 'audio-capture' && meter.live) {
      meter.giveUpMic(); // iOS teilt das Mikrofon manchmal nicht mit der Pegelanzeige
    }
  };
  r.onend = () => {
    if (rec?.recog !== r) return;
    // iOS beendet die Erkennung nach Pausen oder etwa einer Minute: Text sichern und neu starten.
    rec.before = join(rec.before, rec.current);
    rec.current = '';
    render(rec.before, '');
    if (rec.active && rec.restarts++ < 20) setTimeout(() => rec?.active && rec.recog === r && listen(), 120);
    else if (rec.active) interrupted();
    else finishRecording();
  };
  rec.recog = r;
  try { r.start(); } catch { interrupted(); }
}

// Wenn iOS die Erkennung nicht mehr startet (Hintergrund, gesperrt), beim Zurückkehren weiter.
function interrupted() {
  if (!rec?.active) return;
  rec.waiting = true;
  setStatus('iOS hat die Spracherkennung angehalten. Sie läuft weiter, sobald die App wieder offen ist.');
}

function stopRecording() {
  if (!rec) return;
  rec.active = false;
  if (rec.keyboard) return finishRecording();
  try { rec.recog?.stop(); } catch { /* schon beendet */ }
  // Falls onend nicht kommt
  setTimeout(() => rec && !rec.active && finishRecording(), 1500);
}

async function finishRecording() {
  const r = rec;
  if (!r || r.done) return;
  r.done = true;
  rec = null;
  if (r.keyboard) r.before = swiss($('kbd').value);
  r.session.text = join(r.before, r.current);
  r.session.duration = (performance.now() - r.t0) / 1000;
  r.session.state = 'final';
  await put(r.session);
  meter.stop();
  releaseAwake();
  document.body.classList.remove('recording', 'keyboard');
  setStatus('');
  $('kbd').blur();
  $('rec').setAttribute('aria-pressed', 'false');
  $('rec').setAttribute('aria-label', 'Aufnahme starten');
  $('timer').textContent = clock(r.session.duration);
  render(r.session.text, '');
  if (!r.session.text) resetView('Kein Text erkannt.');
  sync();
}

// Zwischenstand bei jedem Ergebnis sichern, damit beim Wegwischen nichts verloren geht.
function save() {
  if (!rec) return;
  rec.session.text = join(rec.before, rec.current);
  rec.session.duration = (performance.now() - rec.t0) / 1000;
  put(rec.session);
}
addEventListener('pagehide', save);

function tick() {
  if (!rec) return;
  $('timer').textContent = clock((performance.now() - rec.t0) / 1000);
  setTimeout(tick, 250);
}

// Ohne Spracherkennung (z. B. als Homescreen-App, falls iOS sie dort sperrt): Diktieren über die Tastatur.
function keyboardMode() {
  rec.keyboard = true;
  document.body.classList.add('keyboard');
  const kbd = $('kbd');
  kbd.value = '';
  kbd.oninput = () => { rec && (rec.before = swiss(kbd.value)); save(); };
  kbd.focus();
  setStatus('Auf der Tastatur das Mikrofon tippen. Fertig: grossen Knopf drücken.');
}

// Bildschirm wach halten, damit iOS nicht sperrt und die Erkennung nicht abbricht.
let wakeLock = null;
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* nicht verfügbar */ }
}
function releaseAwake() { wakeLock?.release().catch(() => {}); wakeLock = null; }

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (rec?.active && !wakeLock) keepAwake();
  if (rec?.active && rec.waiting) { rec.waiting = false; rec.restarts = 0; setStatus(''); listen(); }
  sync();
});
addEventListener('online', () => sync());

// ---------- Kopie auf dem Server (für Claude) ----------
async function sync() {
  if (!token()) return;
  for (const s of await all()) {
    if (s.state !== 'final' || s.synced || !s.text) continue;
    const r = await fetch('/api/transcripts', {
      method: 'POST',
      headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id: s.id, createdAt: s.createdAt, duration: s.duration, text: s.text }),
    }).catch(() => null);
    if (r?.status === 401) return setStatus('Zugangscode für die Ablage ist falsch.');
    if (r?.ok) { s.synced = true; await put(s); }
  }
  renderHistory();
}

// ---------- Text ----------
let shownText = '';
let shownWords = [];
function resetView(placeholder) {
  shownText = '';
  shownWords = [];
  $('words').replaceChildren();
  $('interim').textContent = '';
  $('placeholder').hidden = !placeholder;
  $('placeholder').textContent = placeholder || '';
  $('actions').hidden = true;
}

function render(text, interim) {
  if (rec?.keyboard) return;
  const words = text ? text.split(' ') : [];
  const box = $('words');
  const prefixOk = shownWords.every((w, i) => words[i] === w);
  if (!prefixOk) { box.replaceChildren(); shownWords = []; }
  // Nur neue Wörter einblenden, eins nach dem anderen
  words.slice(shownWords.length).forEach((word, i) => {
    const w = document.createElement('span');
    w.className = prefixOk ? 'w' : '';
    w.textContent = word;
    w.style.animationDelay = `${Math.min(i * 45, 1200)}ms`;
    box.append(w, ' ');
  });
  shownWords = words;
  shownText = text;
  $('interim').textContent = interim;
  $('placeholder').hidden = Boolean(text || interim);
  $('actions').hidden = !text;
  const t = $('transcript');
  t.scrollTo({ top: t.scrollHeight, behavior: reduceMotion.matches ? 'auto' : 'smooth' });
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); haptic(); return true; } catch { return false; }
}
async function shareText(text) {
  if (navigator.share) { try { await navigator.share({ text }); } catch { /* abgebrochen */ } }
  else copyText(text);
}
function flash(btn, label) {
  const old = btn.textContent;
  btn.textContent = label;
  setTimeout(() => (btn.textContent = old), 1400);
}
$('copy').onclick = async () => { if (await copyText(shownText)) flash($('copy'), 'Kopiert'); };
$('share').onclick = () => shareText(shownText);

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
// Pegel aus dem Mikrofon, wenn iOS es parallel zur Erkennung hergibt, sonst aus den Erkennungs-Ereignissen.
const meter = (() => {
  const canvas = $('rings');
  const g = canvas.getContext('2d');
  let ctx, analyser, stream, data, raf = 0;
  let level = 0, vel = 0, fade = 0, pulse = 0;
  const noMic = () => localStorage.getItem('noMeterMic') === '1';
  const size = () => {
    const dpr = devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  size();
  addEventListener('resize', size);

  function frame(t) {
    let target = pulse;
    pulse *= 0.94;
    if (analyser) {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
      target = Math.min(1, Math.sqrt(sum / data.length) * 4.5);
    }
    // Feder statt linearem Glätten
    vel += (target - level) * 0.22 - vel * 0.5;
    level = Math.max(0, level + vel);
    fade += ((rec ? 1 : 0) - fade) * 0.08;

    const w = canvas.clientWidth, h = canvas.clientHeight, cx = w / 2, cy = h / 2;
    g.clearRect(0, 0, w, h);
    g.strokeStyle = g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--red').trim();
    const base = 88;
    if (reduceMotion.matches) {
      g.globalAlpha = fade * (0.15 + level * 0.5);
      g.lineWidth = 3;
      g.beginPath(); g.arc(cx, cy, 96, 0, Math.PI * 2); g.stroke();
    } else {
      // Wellenform rund um den Knopf
      const n = 96;
      g.globalAlpha = fade * 0.16;
      g.beginPath();
      for (let i = 0; i <= n; i++) {
        const a = (i / n) * Math.PI * 2;
        const s = analyser ? Math.abs(data[(i * 7) % data.length] - 128) / 128 : (Math.sin(a * 5 + t / 260) + 1) * 0.25;
        const r = base + 4 + s * 46 * (0.35 + level) + Math.sin(a * 3 + t / 600) * 2 * level;
        const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
        i ? g.lineTo(x, y) : g.moveTo(x, y);
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
  const run = () => { if (!raf) raf = requestAnimationFrame(frame); };

  return {
    get live() { return Boolean(stream); },
    async start() {
      run();
      if (stream || noMic()) return;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        ctx ??= new (window.AudioContext || window.webkitAudioContext)();
        await ctx.resume();
        analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        data = new Uint8Array(analyser.fftSize);
        ctx.createMediaStreamSource(stream).connect(analyser);
      } catch { this.stop(); }
    },
    bump() { pulse = Math.min(1, pulse + 0.5); run(); },
    giveUpMic() { localStorage.setItem('noMeterMic', '1'); this.stop(); },
    stop() { stream?.getTracks().forEach((t) => t.stop()); stream = null; analyser = null; },
  };
})();

// ---------- Verlauf ----------
async function renderHistory() {
  const sessions = (await all()).filter((s) => s.state === 'final').sort((a, b) => b.createdAt - a.createdAt);
  $('history').replaceChildren(...sessions.map(historyItem));
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
  li.querySelector('.item-text').textContent = s.text || 'Kein Text erkannt.';
  const body = li.querySelector('.item-body');

  li.querySelector('[data-a=copy]').onclick = async (e) => { if (await copyText(s.text)) flash(e.target, 'Kopiert'); };
  li.querySelector('[data-a=share]').onclick = () => shareText(s.text);
  li.querySelector('.item-delete').onclick = async () => {
    haptic();
    li.style.transition = 'opacity .25s';
    li.style.opacity = '0';
    await del(s.id);
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

// ---------- Zugang (nur für die Ablage, die Claude liest) ----------
$('openSettings').onclick = () => { $('token').value = token(); $('settings').showModal(); };
$('settings').addEventListener('close', () => {
  if ($('settings').returnValue !== 'save') return;
  localStorage.setItem('token', $('token').value.trim());
  setStatus('');
  sync();
});

// ---------- Start ----------
// Diktat, das beim Wegwischen noch lief: Zwischenstand ist gesichert, also abschliessen.
for (const s of await all()) if (s.state === 'recording') { s.state = 'final'; await put(s); }
sync();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
