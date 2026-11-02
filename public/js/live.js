// Shared helpers: auto-reconnecting WebSocket + formatting.
(function () {
  function connectLive(params, handlers) {
    let ws, timer, ping, delay = 500, stopped = false;
    const qs = new URLSearchParams(params).toString();
    const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws?' + qs;
    function open() {
      clearTimeout(timer);
      if (stopped) return;
      ws = new WebSocket(url);
      ws.onopen = () => {
        delay = 500;
        handlers.onStatus && handlers.onStatus(true);
        clearInterval(ping);
        ping = setInterval(() => { try { ws.send('ping'); } catch (e) {} }, 20000);
      };
      ws.onmessage = (ev) => {
        if (ev.data === 'pong') return;
        let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (msg.type === 'state') handlers.onState(msg.data);
        else if (handlers.onMessage) handlers.onMessage(msg);
        if (msg.type === 'kicked' || msg.type === 'unauthorized') stopped = true;
      };
      ws.onclose = () => {
        clearInterval(ping);
        handlers.onStatus && handlers.onStatus(false);
        if (stopped) return;
        timer = setTimeout(open, delay);
        delay = Math.min(delay * 2, 5000);
      };
      ws.onerror = () => { try { ws.close(); } catch (e) {} };
    }
    // Phones suspend sockets when locked; reconnect instantly when they wake up.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && (!ws || ws.readyState > 1)) { delay = 300; open(); }
    });
    window.addEventListener('online', () => { if (!ws || ws.readyState > 1) open(); });
    open();
    return { stop() { stopped = true; try { ws.close(); } catch (e) {} } };
  }

  const money = (n) => n == null ? '' : '$' + Number(n).toLocaleString('en-US', {
    minimumFractionDigits: Number(n) % 1 ? 2 : 0, maximumFractionDigits: 2,
  });
  const pct = (x) => x == null ? '' : (x * 100).toFixed(x < 0.1 ? 1 : 0) + '%';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ordinal = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };

  // Same rules as the server's parseMoney — for instant feedback only; the server re-validates.
  function parseMoney(input) {
    const s = String(input || '').trim().replace(/[\s$,]/g, '');
    if (!/^(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
    const n = Number(s);
    if (!isFinite(n) || n <= 0 || n > 1e9) return null;
    const c = Math.round(n * 100);
    return c > 0 ? c / 100 : null;
  }

  // Placeholder "card" art when an item has no photo.
  function placeholderSVG(name) {
    const label = esc(String(name || '?').slice(0, 28));
    return `<svg viewBox="0 0 250 350" xmlns="http://www.w3.org/2000/svg" class="ph">
      <rect x="4" y="4" width="242" height="342" rx="16" fill="#2a2018" stroke="#e0a83a" stroke-width="4"/>
      <rect x="20" y="20" width="210" height="310" rx="10" fill="none" stroke="#c8562e" stroke-width="2" stroke-dasharray="6 6"/>
      <text x="125" y="160" text-anchor="middle" font-family="Georgia,serif" font-size="64" fill="#e0a83a">$?</text>
      <text x="125" y="215" text-anchor="middle" font-family="Georgia,serif" font-size="15" fill="#f3e6c8">${label}</text>
    </svg>`;
  }

  window.Live = { connectLive, money, pct, esc, ordinal, parseMoney, placeholderSVG };
})();
