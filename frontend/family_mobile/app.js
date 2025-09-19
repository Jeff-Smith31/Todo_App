(function(){
  'use strict';

  const API_BASE = (window.RUNTIME_CONFIG && window.RUNTIME_CONFIG.BACKEND_URL) ? window.RUNTIME_CONFIG.BACKEND_URL.replace(/\/$/,'') : '';
  let authToken = localStorage.getItem('ttf_auth') || '';
  let user = null;
  let tasks = [];
  const LAST_PUSH_TEST_KEY = 'ttf_last_push_test';

  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));

  function isMobile(){ return (typeof window.orientation !== 'undefined') || (navigator.userAgent||'').includes('Mobi') || window.innerWidth < 640; }

  document.addEventListener('DOMContentLoaded', init);

  async function init(){
    bindTabs();
    $('#btn-add-task').addEventListener('click', onAddTask);
    $('#btn-login').addEventListener('click', loginPrompt);
    if ('serviceWorker' in navigator) { try { await navigator.serviceWorker.register('/sw.js'); } catch {} }
    // Hook up install flow for the Family app page itself
    setupInstallUi();
    render();
    if (authToken) { await fetchMe(); await loadTasks(); try { if (user && isMobile() && typeof Notification !== 'undefined' && Notification.permission === 'granted') { await ensurePushSubscribed(); } } catch {} }
    $('#btn-refresh').addEventListener('click', () => refreshAnalytics());

    // Setup Update button behavior and version polling (match main app functionality)
    setupVersionUiAndUpdater();

    // Mobile: on first open, prompt for notifications and request storage persistence
    try {
      if (isMobile() && typeof Notification !== 'undefined' && Notification.permission === 'default') {
        setTimeout(() => { try { requestNotificationPermission(); } catch {} }, 800);
      }
      if (navigator.storage && navigator.storage.persist) { try { await navigator.storage.persist(); } catch {} }
    } catch {}

    // When app gains focus, ensure we have a push subscription (Android reliability)
    window.addEventListener('visibilitychange', async () => {
      if (document.hidden) return;
      try {
        if (!API_BASE || !user) return;
        if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (!sub) { await ensurePushSubscribed(); }
      } catch {}
    });
  }

  function setupVersionUiAndUpdater(){
    const current = (window.APP_VERSION || 'dev').toString();
    const btnUpdate = $('#btn-update');
    if (btnUpdate) {
      btnUpdate.addEventListener('click', async () => {
        btnUpdate.classList.remove('flash');
        try {
          if ('serviceWorker' in navigator) {
            // Prefer root registration so scope is entire site
            const reg = (await navigator.serviceWorker.getRegistration('/')) || (await navigator.serviceWorker.getRegistration());
            if (reg) {
              try { await reg.update(); } catch {}
              if (reg.waiting) {
                try { reg.waiting.postMessage({ type: 'SKIP_WAITING' }); } catch {}
              }
            }
          }
        } catch {}
        location.reload(true);
      });
    }

    async function checkLatest(){
      try {
        const res = await fetch(`/version.json?ts=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json().catch(()=>null);
        const latest = (data && data.version) ? String(data.version) : null;
        if (!latest) return;
        if (latest !== current && btnUpdate) {
          btnUpdate.style.display = 'inline-block';
          btnUpdate.classList.add('flash');
        }
      } catch {}
    }

    checkLatest();
    setInterval(checkLatest, 30000);
    window.addEventListener('visibilitychange', () => { if (!document.hidden) checkLatest(); });

    // If SW updates and takes control, we have latest
    if (navigator.serviceWorker) {
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (btnUpdate) btnUpdate.classList.remove('flash');
      });
    }
  }

  function bindTabs(){
    $$('.tab').forEach(btn => btn.addEventListener('click', () => {
      $$('.tab').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.getAttribute('data-tab');
      $('#tab-tasks').style.display = tab==='tasks'?'' : 'none';
      $('#tab-analytics').style.display = tab==='analytics'?'' : 'none';
      if (tab==='analytics') refreshAnalytics();
    }));
  }

  function setupInstallUi(){
    const btn = document.getElementById('btn-install');
    if (!btn) return;
    const params = new URLSearchParams(location.search);
    const autoInstall = params.get('install') === '1';
    // Prefer any early-captured event from index.html
    let deferredPrompt = window.__famBip || null;

    // Capture later events as well
    window.addEventListener('beforeinstallprompt', async (e) => {
      e.preventDefault();
      deferredPrompt = e;
      window.__famBip = e;
      btn.disabled = false;
      if (autoInstall) {
        try { await tryInstall(); } catch {}
      }
    });
    // Disable until we have a prompt (if any); will be enabled by early capture or listener above
    btn.disabled = !deferredPrompt;

    async function tryInstall(){
      const isiOS = /iphone|ipad|ipod/i.test(navigator.userAgent||'');
      const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
      if (isiOS && !standalone) {
        alert('On iPhone/iPad: Tap the Share icon, then "Add to Home Screen" to install TTT Family.');
        return;
      }
      // If an early capture exists, use it
      if (!deferredPrompt && window.__famBip) {
        deferredPrompt = window.__famBip;
      }
      if (deferredPrompt) {
        try { deferredPrompt.prompt(); await deferredPrompt.userChoice; } catch {}
        deferredPrompt = null;
        window.__famBip = null;
      } else {
        // If we don't yet have a prompt (e.g., Chrome hasn’t fired it), focus the button and show guidance
        btn.focus();
        alert('If your browser did not offer Install, open the menu and choose "Install app" or "Add to Home screen".');
      }
    }

    // Button click handler
    btn.addEventListener('click', tryInstall);

    // If autoInstall requested, attempt prompt shortly after load in case early event already captured
    if (autoInstall) {
      setTimeout(() => { try { tryInstall(); } catch {} }, 300);
      const isiOS = /iphone|ipad|ipod/i.test(navigator.userAgent||'');
      const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
      if (isiOS && !standalone) {
        alert('On iPhone/iPad: Tap the Share icon, then "Add to Home Screen" to install TTT Family.');
      }
    }

    // Clear stored prompt when installed
    window.addEventListener('appinstalled', () => { deferredPrompt = null; window.__famBip = null; });
  }

  function authHeaders(){ const h = { 'Content-Type': 'application/json' }; if (authToken) h.Authorization = 'Bearer ' + authToken; return h; }
  async function call(path, opts={}){
    if (!API_BASE) throw new Error('Backend URL not configured');
    const res = await fetch(API_BASE + path, { ...opts, headers: { ...(opts.headers||{}), ...authHeaders() }, credentials: 'include' });
    const ct = res.headers.get('content-type')||''; const body = ct.includes('json')? await res.json().catch(()=>null) : await res.text();
    if (!res.ok) throw new Error((body && body.error) || ('HTTP '+res.status));
    return body;
  }

  async function loginPrompt(){
    const email = prompt('Email:'); if (!email) return;
    const password = prompt('Password:'); if (!password) return;
    try {
      const data = await call('/api/auth/login', { method:'POST', body: JSON.stringify({ email, password }) });
      if (data && data.token) {
        authToken = data.token; localStorage.setItem('ttf_auth', authToken); user = data.user;
        $('#btn-login').textContent = 'Logout'; $('#btn-login').onclick = doLogout;
        // If notifications already granted, ensure a subscription and send a test push (throttled)
        try {
          if (isMobile() && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            await ensurePushSubscribed();
            await maybeTestPush('login');
          }
        } catch {}
        await loadTasks();
      }
    } catch(e){ alert(e.message || 'Login failed'); }
  }
  async function doLogout(){
    // Best-effort unsubscribe on logout
    try { await unsubscribePush(); } catch {}
    authToken=''; localStorage.removeItem('ttf_auth'); user=null; $('#btn-login').textContent='Login'; $('#btn-login').onclick = loginPrompt; tasks=[]; render(); }

  async function fetchMe(){ try { const me = await call('/api/auth/me'); user = me?.user || null; if (user) { $('#btn-login').textContent = 'Logout'; $('#btn-login').onclick = doLogout; } } catch { user = null; } }

  async function loadTasks(){ try { const res = await call('/api/family/tasks'); tasks = res.tasks || []; render(); } catch (e) { console.warn(e); } }
  async function onAddTask(){ const title = ($('#new-task-title').value || '').trim(); if (!title) return; try { await call('/api/family/tasks', { method:'POST', body: JSON.stringify({ title }) }); $('#new-task-title').value=''; await loadTasks(); } catch(e){ alert(e.message||'Failed'); } }

  async function completeTask(id){ try { await call('/api/family/tasks/'+encodeURIComponent(id)+'/complete', { method:'POST' }); await loadTasks(); } catch(e){ alert(e.message||'Failed'); } }

  // --- Notifications & Storage Permissions (mobile only) ---
  async function requestNotificationPermission(){
    try {
      if (!isMobile()) return; // only on phones
      if (!('Notification' in window)) return;
      const ua = navigator.userAgent || navigator.vendor || '';
      const isiOS = /iPad|iPhone|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
      if (isiOS && !standalone) {
        alert('To enable notifications on iPhone/iPad, please install TTT Family first: Share → Add to Home Screen, then open the installed app.');
        return;
      }
      const res = await Notification.requestPermission();
      if (res !== 'granted') return;
      // Request persistent storage to reduce eviction risk
      try { if (navigator.storage && navigator.storage.persist) { await navigator.storage.persist(); } } catch {}
      // Create/refresh push subscription if logged in
      try { if (API_BASE && user) { await ensurePushSubscribed(); await maybeTestPush('permission-granted'); } } catch {}
    } catch {}
  }

  async function ensurePushSubscribed(){
    if (!API_BASE || !user) return;
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    if (typeof Notification !== 'undefined' && Notification.permission !== 'granted') return;
    const reg = await (navigator.serviceWorker.ready.catch(() => navigator.serviceWorker.getRegistration()));
    if (!reg) return;

    // Fetch server VAPID public key
    let key = '';
    try {
      const r = await fetch(API_BASE + '/api/push/vapid-public-key', { credentials: 'include' });
      const j = await r.json().catch(()=>({key:''}));
      key = (j && j.key) ? j.key : '';
    } catch {}
    if (!key) return;

    const storedKey = localStorage.getItem('ttf_vapid_pub') || '';
    let existing = null;
    try { existing = await reg.pushManager.getSubscription(); } catch {}

    // If server key changed, clear old subscription
    if (existing && storedKey && storedKey !== key) {
      try { await fetch(API_BASE + '/api/push/subscribe', { method:'DELETE', credentials:'include', headers:{'Content-Type':'application/json', ...(authToken?{Authorization:'Bearer '+authToken}:{})}, body: JSON.stringify({ endpoint: existing.endpoint }) }); } catch {}
      try { await existing.unsubscribe(); } catch {}
      existing = null;
    }

    if (existing) {
      // Ensure backend knows about it (idempotent upsert)
      try {
        const tzOffsetMinutes = -new Date().getTimezoneOffset();
        const payload = Object.assign({}, existing, { tzOffsetMinutes });
        await fetch(API_BASE + '/api/push/subscribe', { method:'POST', credentials:'include', headers:{'Content-Type':'application/json', ...(authToken?{Authorization:'Bearer '+authToken}:{})}, body: JSON.stringify(payload) });
      } catch {}
      if (storedKey !== key) localStorage.setItem('ttf_vapid_pub', key);
      return existing;
    }

    // Create new subscription
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) });
    try {
      const tzOffsetMinutes = -new Date().getTimezoneOffset();
      const payload = Object.assign({}, sub, { tzOffsetMinutes });
      await fetch(API_BASE + '/api/push/subscribe', { method:'POST', credentials:'include', headers:{'Content-Type':'application/json', ...(authToken?{Authorization:'Bearer '+authToken}:{})}, body: JSON.stringify(payload) });
    } catch {}
    localStorage.setItem('ttf_vapid_pub', key);
    return sub;
  }

  async function unsubscribePush(){
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      try { await fetch(API_BASE + '/api/push/subscribe', { method:'DELETE', credentials:'include', headers:{'Content-Type':'application/json', ...(authToken?{Authorization:'Bearer '+authToken}:{})}, body: JSON.stringify({ endpoint: sub.endpoint }) }); } catch {}
      try { await sub.unsubscribe(); } catch {}
    }
  }

  async function maybeTestPush(reason){
    try {
      if (!API_BASE || !user) return;
      if (!isMobile()) return;
      const now = Date.now();
      const last = parseInt(localStorage.getItem(LAST_PUSH_TEST_KEY) || '0', 10) || 0;
      if (reason !== 'permission-granted' && now - last < 6*60*60*1000) return;
      const r = await fetch(API_BASE + '/api/push/test', { method:'POST', credentials:'include', headers:{ ...(authToken?{Authorization:'Bearer '+authToken}:{}) } });
      if (r.ok) {
        localStorage.setItem(LAST_PUSH_TEST_KEY, String(now));
        alert('A test notification has been sent to your device for TTT Family. If you do not receive it, ensure notifications are allowed for this app.');
      }
    } catch {}
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) { outputArray[i] = rawData.charCodeAt(i); }
    return outputArray;
  }

  function render(){ const cont = $('#tasks'); cont.innerHTML=''; if (!tasks.length){ $('#empty').style.display='block'; return; } $('#empty').style.display='none'; for (const t of tasks){ const div = document.createElement('div'); div.className='task'; div.innerHTML = `<div class=\"plus\" title=\"Log a completion\">+</div><div style=\"flex:1\"><div style=\"font-weight:600\">${escapeHtml(t.title)}</div><div style=\"color:#64748b;font-size:12px\">${t.count||0} completions</div></div>`; div.querySelector('.plus').addEventListener('click', () => completeTask(t.id)); cont.appendChild(div); } }

  function escapeHtml(s){ return String(s).replace(/[&<>"]+/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]||c)); }

  async function refreshAnalytics(){ try { const range = $('#range').value; const data = await call('/api/family/analytics?range='+encodeURIComponent(range)); drawChart(data); } catch(e){ console.warn(e); }}

  function drawChart(data){ const canvas = $('#chart'); const ctx = canvas.getContext('2d'); ctx.clearRect(0,0,canvas.width,canvas.height); // simple stacked bar chart per user
    const users = Object.keys(data.users||{}); const labels = data.labels||[]; const W = canvas.width, H = canvas.height; const leftPad=40, bottom=30, top=10, right=10; const chartW = W-leftPad-right, chartH=H-top-bottom; ctx.fillStyle='#fff'; ctx.fillRect(0,0,W,H); // axes
    ctx.strokeStyle='#94a3b8'; ctx.beginPath(); ctx.moveTo(leftPad, top); ctx.lineTo(leftPad, top+chartH); ctx.lineTo(leftPad+chartW, top+chartH); ctx.stroke();
    const max = Math.max(1, data.max || 1); const barW = chartW/(labels.length||1)*0.6; const gap = chartW/(labels.length||1)*0.4;
    labels.forEach((lab, i)=>{ const x0 = leftPad + i*(barW+gap) + gap/2; let accY = 0; users.forEach((u, ui)=>{ const val = (data.users[u][i]||0); const h = (val/max)*chartH; const y = top+chartH - accY - h; ctx.fillStyle = palette(ui); ctx.fillRect(x0, y, barW, h); accY += h; }); ctx.fillStyle='#111827'; ctx.font='10px sans-serif'; ctx.textAlign='center'; ctx.fillText(lab, x0+barW/2, top+chartH+12); });
    // legend
    users.forEach((u, ui)=>{ ctx.fillStyle = palette(ui); ctx.fillRect(W-150, 10+ui*16, 10, 10); ctx.fillStyle='#111'; ctx.fillText(u, W-135, 19+ui*16); });
  }
  function palette(i){ const colors = ['#16a34a','#4f46e5','#06b6d4','#f59e0b','#ef4444','#22c55e']; return colors[i%colors.length]; }

})();
