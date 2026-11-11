/**
 * Desktop host for Phone Swing: QR, WebSocket, live meter, fire into the engine.
 */

import { makeQrSvg, newRoomCode, isLocalEngineHost } from './qr-svg.js';
import { mapSwingPower } from './club-power-shot.js';

const HTTPS_PORT_DEFAULT = 8768;

function wsUrlFor(httpUrl) {
  const u = new URL(httpUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.toString();
}

async function resolvePairing(room) {
  const loc = window.location;
  const path = `/engine/phone-swing.html?room=${encodeURIComponent(room)}`;

  if (!isLocalEngineHost(loc.hostname)) {
    const pageUrl = `${loc.origin}${path}`;
    return {
      pageUrl,
      socketUrl: wsUrlFor(`${loc.origin}/api/swing-ws?room=${encodeURIComponent(room)}&role=host`),
      mode: 'portal',
    };
  }

  let info = null;
  try {
    const res = await fetch('/api/lan-info', { cache: 'no-store' });
    if (res.ok) info = await res.json();
  } catch { /* offline / old serve.js */ }

  const ip = Array.isArray(info?.ips) && info.ips[0];
  const httpsPort = Number(info?.httpsPort) || HTTPS_PORT_DEFAULT;
  if (!ip || info?.httpsReady === false) {
    return {
      pageUrl: null,
      socketUrl: wsUrlFor(`${loc.protocol}//${loc.host}/api/swing-ws?room=${encodeURIComponent(room)}&role=host`),
      mode: 'local-http',
      error: 'Local HTTPS is not ready. Restart the server after generating certs.',
    };
  }

  const origin = `https://${ip}:${httpsPort}`;
  const pageUrl = `${origin}${path}`;
  if (!pageUrl.startsWith('https://')) {
    return { pageUrl: null, socketUrl: null, mode: 'local-http', error: 'Refusing a non-HTTPS phone URL.' };
  }
  return {
    pageUrl,
    socketUrl: wsUrlFor(`${loc.protocol}//${loc.host}/api/swing-ws?room=${encodeURIComponent(room)}&role=host`),
    mode: 'local-https',
    ip,
    httpsPort,
  };
}

export function createPhoneSwingHost(vis) {
  const room = newRoomCode();
  let ws = null;
  let pairing = null;
  let statusText = 'Starting…';
  let phoneConnected = false;
  let lastShot = '';
  let displayPct = 0;
  let overswing = false;
  let roots = new Set();
  let disposed = false;
  let pollTimer = null;
  let panelOpen = false;

  function paint() {
    for (const root of roots) updateRoot(root);
  }

  function setStatus(text) {
    statusText = text;
    paint();
  }

  function clubPayload() {
    const club = vis.selectedClub || null;
    return {
      type: 'club',
      id: club?.id || null,
      name: club?.name || club?.label || '—',
      carry: club?.carry ?? null,
    };
  }

  function send(msg) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(msg));
  }

  function handleMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'joined') {
      phoneConnected = !!msg.peer;
      setStatus(phoneConnected ? 'Phone connected' : 'Waiting for iPhone…');
      return;
    }
    if (msg.type === 'peer-joined' && msg.role === 'phone') {
      phoneConnected = true;
      setStatus('Phone connected');
      send(clubPayload());
      return;
    }
    if (msg.type === 'peer-left' && msg.role === 'phone') {
      phoneConnected = false;
      displayPct = 0;
      overswing = false;
      setStatus('Waiting for iPhone…');
      return;
    }
    if (msg.type === 'meter') {
      const mapped = mapSwingPower(msg.powerPct);
      displayPct = mapped.displayPct;
      overswing = !!msg.overswing || mapped.overswing;
      paint();
      return;
    }
    if (msg.type === 'fire') {
      const mapped = mapSwingPower(msg.powerPct);
      displayPct = mapped.displayPct;
      overswing = !!msg.overswing || mapped.overswing;
      lastShot = `${Math.round(mapped.firePct)}%${overswing ? ' red' : ''}`;
      vis.fireClubPowerShot?.({
        powerPct: mapped.firePct,
        overswing,
      });
      paint();
    }
  }

  function connectSocket(socketUrl) {
    if (ws) {
      try { ws.close(); } catch { /* ignore */ }
      ws = null;
    }
    ws = new WebSocket(socketUrl);
    ws.addEventListener('open', () => {
      setStatus(phoneConnected ? 'Phone connected' : 'Waiting for iPhone…');
      send(clubPayload());
    });
    ws.addEventListener('message', (e) => handleMessage(e.data));
    ws.addEventListener('close', () => {
      if (disposed) return;
      phoneConnected = false;
      setStatus('Reconnecting…');
      setTimeout(() => {
        if (!disposed && pairing?.socketUrl) connectSocket(pairing.socketUrl);
      }, 1200);
    });
    ws.addEventListener('error', () => { /* close handler reconnects */ });
  }

  vis.addEventListener?.('golf:clubchange', () => send(clubPayload()));

  function applyPairing(next, { reconnect } = {}) {
    const urlChanged = next.pageUrl !== pairing?.pageUrl;
    const socketChanged = next.socketUrl !== pairing?.socketUrl;
    pairing = next;
    if (urlChanged) {
      for (const root of roots) {
        const qrEl = root.querySelector('[data-role="qr"]');
        if (qrEl) {
          delete qrEl.dataset.filled;
          qrEl.innerHTML = '';
        }
      }
    }
    if (reconnect && socketChanged && next.socketUrl) connectSocket(next.socketUrl);
    paint();
  }

  async function start() {
    applyPairing(await resolvePairing(room));
    if (pairing.error) setStatus(pairing.error);
    else setStatus('Waiting for iPhone…');
    if (pairing.socketUrl) connectSocket(pairing.socketUrl);
    pollTimer = setInterval(async () => {
      if (disposed) return;
      const next = await resolvePairing(room);
      if (next.pageUrl !== pairing?.pageUrl || next.error !== pairing?.error) {
        applyPairing(next, { reconnect: true });
        if (next.error) setStatus(next.error);
        else if (!phoneConnected) setStatus('Waiting for iPhone…');
      }
    }, 8000);
  }

  function updateRoot(root) {
    const statusEl = root.querySelector('[data-role="status"]');
    const urlEl = root.querySelector('[data-role="url"]');
    const qrEl = root.querySelector('[data-role="qr"]');
    const fillEl = root.querySelector('[data-role="meter-fill"]');
    const lastEl = root.querySelector('[data-role="last"]');
    const hintEl = root.querySelector('[data-role="summary-hint"]');
    if (statusEl) statusEl.textContent = statusText;
    if (hintEl) hintEl.textContent = lastShot || (phoneConnected ? 'Connected' : '');
    if (urlEl) urlEl.textContent = pairing?.pageUrl || '—';
    if (qrEl && pairing?.pageUrl && !qrEl.dataset.filled) {
      qrEl.innerHTML = makeQrSvg(pairing.pageUrl);
      qrEl.dataset.filled = '1';
    }
    if (fillEl) {
      fillEl.style.height = `${Math.min(displayPct, 130) / 130 * 100}%`;
      fillEl.classList.toggle('red', overswing);
    }
    if (lastEl) lastEl.textContent = lastShot ? `Last shot ${lastShot}` : '';
  }

  function mount(parent) {
    const wrap = document.createElement('details');
    wrap.className = 'phone-swing';
    wrap.open = panelOpen;
    wrap.addEventListener('toggle', () => { panelOpen = wrap.open; });
    wrap.innerHTML = `
      <summary class="club-section-label phone-swing-summary">
        Phone Swing
        <span class="phone-swing-summary-hint" data-role="summary-hint"></span>
      </summary>
      <div class="phone-swing-url" data-role="url"></div>
      <div class="phone-swing-row">
        <div class="phone-swing-qr" data-role="qr" title="Scan to open Phone Swing"></div>
        <div class="phone-swing-side">
          <div class="phone-swing-meter" aria-hidden="true">
            <div class="phone-swing-meter-fill" data-role="meter-fill"></div>
            <div class="phone-swing-meter-redline"></div>
          </div>
        </div>
      </div>
      <div class="phone-swing-status" data-role="status"></div>
      <div class="phone-swing-last" data-role="last"></div>
      <div class="phone-swing-help">
        Scan the QR, or paste the https:// URL in Safari.
        Hold like a club — hold the button, swing, release to hit.
      </div>
      <div class="phone-swing-help phone-swing-reqs">
        iPhone must be on the same Wi-Fi as this Mac. The Safari URL
        must start with https:// and match the line above.
        If Safari says Not Private: Show Details → visit this website.
        Do not tap Continue — iOS then retries HTTP and HTTPS-Only
        blocks it. If you already saw that error: Settings → Safari →
        Advanced → turn off HTTPS-Only Mode, then scan again.
        On the phone, tap the blue button and Allow. There is no
        Motion toggle under Safari Settings (Apple removed it).
      </div>
    `;
    parent.appendChild(wrap);
    for (const old of [...roots]) {
      if (!old.isConnected) roots.delete(old);
    }
    roots.add(wrap);
    if (pairing?.pageUrl) {
      const qrEl = wrap.querySelector('[data-role="qr"]');
      qrEl.innerHTML = makeQrSvg(pairing.pageUrl);
      qrEl.dataset.filled = '1';
    }
    updateRoot(wrap);
    return wrap;
  }

  function dispose() {
    disposed = true;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    roots.clear();
    if (ws) {
      try { ws.close(); } catch { /* ignore */ }
      ws = null;
    }
  }

  start();

  return { room, mount, dispose, sendClub: () => send(clubPayload()) };
}
