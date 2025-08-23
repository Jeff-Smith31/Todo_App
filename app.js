/* TickTock Tasks - core app logic */
(function(){
  'use strict';

  const STORAGE_KEY = 'ticktock_tasks_v1';
  const SETTINGS_KEY = 'ticktock_settings_v1';
  const BACKEND_URL = window.BACKEND_URL || localStorage.getItem('tt_backend_url') || '';
  const API = createApiClient(BACKEND_URL);

  /** Data Types
   * Task = {
   *   id: string,
   *   title: string,
   *   notes: string,
   *   everyDays: number, // recurrence in days (>=1)
   *   nextDue: string,   // yyyy-mm-dd
   *   remindAt: string,  // HH:MM 24h
   *   priority: boolean,
   *   lastCompleted?: string, // ISO
   * }
   */

  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));

  const elements = {
    form: $('#task-form'),
    id: $('#task-id'),
    title: $('#title'),
    notes: $('#notes'),
    frequency: $('#frequency'),
    customWrap: $('#custom-days-wrap'),
    customDays: $('#custom-days'),
    nextDue: $('#next-due'),
    remindAt: $('#remind-at'),
    saveBtn: $('#btn-save'),
    resetBtn: $('#btn-reset'),
    list: $('#task-list'),
    empty: $('#empty'),
    filterStatus: $('#filter-status'),
    search: $('#search'),
    permissionBtn: $('#btn-permission'),
    installBtn: $('#btn-install'),
    template: $('#task-item-template')
  };

  let tasks = loadTasks();
  let settings = loadSettings();
  let isAuthed = false;
  let deferredPrompt = null; // for PWA install
  const timers = new Map(); // id -> timeout handle

  // Initialization
  document.addEventListener('DOMContentLoaded', init);

  async function init(){
    // Defaults
    elements.nextDue.value = todayStr();

    // Event listeners
    elements.frequency.addEventListener('change', onFreqChange);
    elements.form.addEventListener('submit', onSaveTask);
    elements.resetBtn.addEventListener('click', resetForm);
    elements.filterStatus.addEventListener('change', render);
    elements.search.addEventListener('input', render);

    elements.permissionBtn.addEventListener('click', requestNotificationPermission);

    // Backend URL setter button
    const btnBackend = document.getElementById('btn-backend');
    if (btnBackend) {
      btnBackend.addEventListener('click', () => {
        try {
          const current = localStorage.getItem('tt_backend_url') || '';
          const input = prompt('Enter backend URL (e.g., https://192.168.1.6:8443)', current);
          if (input === null) return; // cancelled
          const url = String(input).trim().replace(/\/$/, '');
          const ok = /^(https?:)\/\/[^\s]+$/i.test(url);
          if (!ok) { alert('Please enter a valid http(s) URL, e.g., https://192.168.1.6:8443'); return; }
          localStorage.setItem('tt_backend_url', url);
          alert('Backend URL saved to localStorage. The app will reload to apply it.');
          window.location.reload();
        } catch (e) {
          alert('Could not save backend URL: ' + (e && e.message ? e.message : e));
        }
      });
      // Hint in title
      const current = localStorage.getItem('tt_backend_url') || '';
      if (current) btnBackend.title = 'Current backend: ' + current;
      else btnBackend.title = 'No backend set. Click to configure (uses local storage by default).';
    }

    // Auth
    const btnLogin = document.getElementById('btn-login');
    const btnRegister = document.getElementById('btn-register');
    const btnLogout = document.getElementById('btn-logout');
    const emailEl = document.getElementById('auth-email');
    const passEl = document.getElementById('auth-password');

    if (btnLogin && btnRegister && btnLogout) {
      btnLogin.addEventListener('click', async () => {
        try {
          await API.login(emailEl.value, passEl.value);
          await syncFromBackend();
          updateAuthUi(true);
        } catch (e) { alert(e.message || 'Login failed'); }
      });
      btnRegister.addEventListener('click', async () => {
        try {
          await API.register(emailEl.value, passEl.value);
          await syncFromBackend();
          updateAuthUi(true);
        } catch (e) { alert(e.message || 'Registration failed'); }
      });
      btnLogout.addEventListener('click', async () => {
        try {
          await unsubscribePush();
        } catch {}
        try { await API.logout(); } catch {}
        updateAuthUi(false);
        tasks = [];
        saveTasks();
        render();
      });
    }

    // PWA install
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      elements.installBtn.style.display = 'inline-block';
    });
    elements.installBtn.addEventListener('click', async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      elements.installBtn.style.display = 'none';
    });

    // Service worker
    if ('serviceWorker' in navigator){
      navigator.serviceWorker.register('sw.js').catch(()=>{});
    }

    // Try to request notifications on first run to streamline mobile setup
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      try { await requestNotificationPermission(); } catch {}
    }

    // Backend mode: check session and sync; otherwise local-only
    if (BACKEND_URL) {
      try {
        const me = await API.me();
        isAuthed = !!me;
        updateAuthUi(isAuthed);
        if (isAuthed) {
          await syncFromBackend();
          if (Notification.permission === 'granted') {
            try { await ensurePushSubscribed(); } catch {}
          }
        }
      } catch {}
    }

    // Handle missed tasks on load
    handleMissedTasks();

    // Render UI
    render();

    // Set up notifications for due tasks today
    scheduleAllNotificationsForToday();

    // Show permission button state
    refreshPermissionButton();
  }

  function onFreqChange(){
    const val = elements.frequency.value;
    elements.customWrap.classList.toggle('hidden', val !== 'custom');
  }

  async function onSaveTask(e){
    e.preventDefault();
    const id = elements.id.value || cryptoRandomId();
    const freqVal = elements.frequency.value;
    const everyDays = freqVal === 'custom' ? Math.max(1, parseInt(elements.customDays.value || '1', 10)) : parseInt(freqVal, 10);

    const t = {
      id,
      title: elements.title.value.trim(),
      notes: elements.notes.value.trim(),
      everyDays,
      nextDue: elements.nextDue.value,
      remindAt: elements.remindAt.value,
      priority: false,
    };

    if (!t.title) return;

    const idx = tasks.findIndex(x => x.id === id);
    if (idx >= 0) tasks[idx] = { ...tasks[idx], ...t };
    else tasks.push(t);

    if (BACKEND_URL && isAuthed) {
      try {
        if (idx >= 0) await API.updateTask(t);
        else await API.createTask(t);
        await syncFromBackend();
      } catch (err) { console.warn(err); }
    }

    saveTasks();
    render();
    scheduleNotificationForTask(t);
    resetForm();
  }

  function resetForm(){
    elements.id.value = '';
    elements.title.value = '';
    elements.notes.value = '';
    elements.frequency.value = '1';
    elements.customDays.value = '2';
    elements.customWrap.classList.add('hidden');
    elements.nextDue.value = todayStr();
    elements.remindAt.value = '09:00';
  }

  // CRUD helpers
  function editTask(id){
    const t = tasks.find(x => x.id === id);
    if (!t) return;
    elements.id.value = t.id;
    elements.title.value = t.title;
    elements.notes.value = t.notes || '';
    if (t.everyDays === 1 || t.everyDays === 7 || t.everyDays === 30) {
      elements.frequency.value = String(t.everyDays);
      elements.customWrap.classList.add('hidden');
    } else {
      elements.frequency.value = 'custom';
      elements.customWrap.classList.remove('hidden');
      elements.customDays.value = String(t.everyDays);
    }
    elements.nextDue.value = t.nextDue;
    elements.remindAt.value = t.remindAt;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function deleteTask(id){
    cancelScheduledNotification(id);
    tasks = tasks.filter(x => x.id !== id);
    if (BACKEND_URL && isAuthed) {
      try { await API.deleteTask(id); await syncFromBackend(); } catch (e) { console.warn(e); }
    }
    saveTasks();
    render();
  }

  async function toggleComplete(id, checked){
    const t = tasks.find(x => x.id === id);
    if (!t) return;

    const nowIso = new Date().toISOString();

    if (checked){
      // only allow checking if due today or overdue; complete occurrence, then schedule next
      if (isDueToday(t) || isOverdue(t)){
        t.lastCompleted = nowIso;
        // advance next due
        t.nextDue = addDays(t.nextDue, t.everyDays);
        t.priority = false; // once completed, clear priority
        if (BACKEND_URL && isAuthed) { try { await API.updateTask(t); await syncFromBackend(); } catch(e){ console.warn(e); } }
        saveTasks();
        render();
        scheduleNotificationForTask(t);
      }
    } else {
      // unchecking will move it back to immediate next due today if we just completed now
      const d = new Date();
      const todayStrVal = dateToYMD(d);
      if (!isDueTodayRawDateStr(t.nextDue, todayStrVal)){
        // revert by subtracting frequency but not before today
        const prev = addDays(t.nextDue, -t.everyDays);
        if (new Date(prev) >= startOfDay(d)) t.nextDue = prev;
        if (BACKEND_URL && isAuthed) { try { await API.updateTask(t); await syncFromBackend(); } catch(e){ console.warn(e); } }
        saveTasks();
        render();
        scheduleNotificationForTask(t);
      }
    }
  }

  // Rendering
  function render(){
    const filter = elements.filterStatus.value;
    const q = elements.search.value.trim().toLowerCase();

    const filtered = tasks.filter(t => {
      if (q && !(t.title.toLowerCase().includes(q) || (t.notes||'').toLowerCase().includes(q))) return false;
      if (filter === 'today') return isDueToday(t);
      if (filter === 'overdue') return isOverdue(t);
      if (filter === 'priority') return !!t.priority;
      return true;
    }).sort(sorter);

    elements.list.innerHTML = '';

    if (filtered.length === 0){
      elements.empty.style.display = 'block';
    } else {
      elements.empty.style.display = 'none';
    }

    for (const t of filtered){
      const node = elements.template.content.firstElementChild.cloneNode(true);
      const checkbox = node.querySelector('input.toggle');
      const title = node.querySelector('.title');
      const notes = node.querySelector('.notes');
      const meta = node.querySelector('.meta');
      const bPriority = node.querySelector('.badge.priority');
      const bOverdue = node.querySelector('.badge.overdue');
      const bToday = node.querySelector('.badge.due-today');

      title.textContent = t.title;
      notes.textContent = t.notes || '';

      const dueDate = t.nextDue;
      const dueTime = t.remindAt;
      meta.textContent = `Due: ${formatDate(dueDate)} at ${formatTime(dueTime)} • Every ${t.everyDays} day(s)`;

      // badges
      toggleHidden(bPriority, !t.priority);
      toggleHidden(bOverdue, !isOverdue(t));
      toggleHidden(bToday, !(isDueToday(t) && !isOverdue(t)));

      // checkbox is always unchecked in list; completion toggles schedule
      checkbox.checked = false;
      checkbox.addEventListener('change', () => toggleComplete(t.id, checkbox.checked));

      node.querySelector('button.edit').addEventListener('click', () => editTask(t.id));
      node.querySelector('button.delete').addEventListener('click', () => deleteTask(t.id));

      elements.list.appendChild(node);
    }
  }

  function sorter(a,b){
    // Priority first, then overdue, then due today, then by due date/time, then title
    const ap = a.priority ? 1 : 0;
    const bp = b.priority ? 1 : 0;
    if (ap !== bp) return bp - ap;
    const ao = isOverdue(a) ? 1 : 0; const bo = isOverdue(b) ? 1 : 0;
    if (ao !== bo) return bo - ao;
    const ad = isDueToday(a) ? 1 : 0; const bd = isDueToday(b) ? 1 : 0;
    if (ad !== bd) return bd - ad;
    const aDate = new Date(`${a.nextDue}T${a.remindAt}:00`);
    const bDate = new Date(`${b.nextDue}T${b.remindAt}:00`);
    if (aDate.getTime() !== bDate.getTime()) return aDate - bDate;
    return a.title.localeCompare(b.title);
  }

  // Storage
  function loadTasks(){
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; } catch { return []; }
  }
  function saveTasks(){
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
  }
  function loadSettings(){
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; }
  }
  function saveSettings(){
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }

  async function syncFromBackend(){
    if (!BACKEND_URL) return;
    try {
      const list = await API.getTasks();
      if (Array.isArray(list)) {
        tasks = list;
        saveTasks();
        render();
      }
    } catch (e) {
      console.warn('Sync failed', e);
    }
  }

  function updateAuthUi(authed){
    isAuthed = !!authed;
    const emailEl = document.getElementById('auth-email');
    const passEl = document.getElementById('auth-password');
    const btnLogin = document.getElementById('btn-login');
    const btnRegister = document.getElementById('btn-register');
    const btnLogout = document.getElementById('btn-logout');
    if (!emailEl || !passEl || !btnLogin || !btnRegister || !btnLogout) return;
    emailEl.style.display = authed ? 'none' : 'inline-block';
    passEl.style.display = authed ? 'none' : 'inline-block';
    btnLogin.style.display = authed ? 'none' : 'inline-block';
    btnRegister.style.display = authed ? 'none' : 'inline-block';
    btnLogout.style.display = authed ? 'inline-block' : 'none';
  }

  // Missed tasks handling: if due time has passed without completion, move to next day and mark priority
  function handleMissedTasks(){
    const now = new Date();
    let changed = false;
    for (const t of tasks){
      const dueDt = parseDueDateTime(t.nextDue, t.remindAt);
      if (dueDt.getTime() < now.getTime()){
        // Was due in the past and not completed; roll to next day and mark priority
        const nextDay = addDays(t.nextDue, 1);
        if (t.nextDue !== nextDay){ /* always true */ }
        t.nextDue = nextDay;
        t.priority = true;
        changed = true;
      }
    }
    if (changed) saveTasks();
  }

  // Notifications
  function refreshPermissionButton(){
    const state = Notification && Notification.permission || 'default';
    if (state === 'granted'){
      elements.permissionBtn.textContent = 'Notifications Enabled';
      elements.permissionBtn.disabled = true;
    } else {
      elements.permissionBtn.textContent = 'Enable Notifications';
      elements.permissionBtn.disabled = false;
    }
  }

  async function requestNotificationPermission(){
    if (!('Notification' in window)){
      alert('Notifications are not supported in this browser');
      return;
    }
    try {
      const res = await Notification.requestPermission();
      if (res !== 'granted') alert('To receive reminders, please allow notifications.');
    } catch (e) {}
    refreshPermissionButton();
    scheduleAllNotificationsForToday();
    if (Notification.permission === 'granted' && BACKEND_URL && isAuthed) {
      try { await ensurePushSubscribed(); } catch {}
    }
  }

  function scheduleAllNotificationsForToday(){
    // clear existing timers
    for (const [id, h] of timers.entries()){
      clearTimeout(h); timers.delete(id);
    }
    for (const t of tasks){
      scheduleNotificationForTask(t);
    }
  }

  function scheduleNotificationForTask(t){
    cancelScheduledNotification(t.id);
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;

    // Only schedule if due today
    const now = new Date();
    const dueDt = parseDueDateTime(t.nextDue, t.remindAt);
    const ms = dueDt.getTime() - now.getTime();

    if (ms <= 0){
      return; // missed tasks handled at load; will be picked next day
    }

    // only schedule if due date is today
    if (!isDueTodayRawDateStr(t.nextDue, dateToYMD(now))) return;

    const handle = setTimeout(() => {
      showTaskNotification(t);
    }, ms);

    timers.set(t.id, handle);
  }

  function cancelScheduledNotification(id){
    const h = timers.get(id);
    if (h){ clearTimeout(h); timers.delete(id); }
  }

  function showTaskNotification(t){
    const body = t.notes ? `${t.notes}\nEvery ${t.everyDays} day(s)` : `Every ${t.everyDays} day(s)`;
    const n = new Notification(t.title, {
      body,
      icon: 'icons/logo.svg',
      badge: 'icons/logo.svg',
      tag: `task-${t.id}`,
      vibrate: [100, 50, 100]
    });
    n.onclick = () => window.focus();
  }

  // Utilities
  function cryptoRandomId(){
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function todayStr(){ return dateToYMD(new Date()); }
  function dateToYMD(d){
    const y = d.getFullYear();
    const m = String(d.getMonth()+1).padStart(2,'0');
    const da = String(d.getDate()).padStart(2,'0');
    return `${y}-${m}-${da}`;
  }
  function startOfDay(d){
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }
  function parseDueDateTime(dateStr, timeStr){
    // timeStr HH:MM
    const [h,m] = timeStr.split(':').map(Number);
    const [y,mo,da] = dateStr.split('-').map(Number);
    return new Date(y, mo-1, da, h||0, m||0, 0, 0);
  }
  function addDays(dateStr, n){
    const d = new Date(dateStr);
    d.setDate(d.getDate() + n);
    return dateToYMD(d);
  }
  function isOverdue(t){
    const now = new Date();
    const dueDt = parseDueDateTime(t.nextDue, t.remindAt);
    return dueDt.getTime() < now.getTime();
  }
  function isDueToday(t){
    const today = todayStr();
    return isDueTodayRawDateStr(t.nextDue, today);
  }
  function isDueTodayRawDateStr(target, today){
    return target === today;
  }
  function formatDate(dateStr){
    const d = new Date(dateStr);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }
  function formatTime(timeStr){
    const [h,m] = timeStr.split(':').map(Number);
    const d = new Date(); d.setHours(h||0, m||0, 0, 0);
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  function toggleHidden(el, hidden){ el.classList.toggle('hidden', hidden); }

  // Push helpers
  async function ensurePushSubscribed(){
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return;
    const existing = await reg.pushManager.getSubscription();
    if (existing) {
      // ensure backend has it (idempotent upsert)
      await API.subscribePush(existing);
      return existing;
    }
    const { key } = await API.getVapidKey();
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key)
    });
    await API.subscribePush(sub);
    return sub;
  }
  async function unsubscribePush(){
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      try { await API.unsubscribePush(sub); } catch {}
      await sub.unsubscribe().catch(()=>{});
    }
  }
  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  // Simple API client
  function createApiClient(base){
    const baseUrl = (base || '').replace(/\/$/, '');
    const opts = { credentials: 'include', headers: { 'Content-Type': 'application/json' } };
    async function handle(res){
      const ct = res.headers.get('content-type') || '';
      const data = ct.includes('application/json') ? await res.json().catch(()=>null) : await res.text();
      if (!res.ok) throw new Error((data && data.error) || (typeof data === 'string' ? data : 'Request failed'));
      return data;
    }
    return {
      async register(email, password){ return handle(await fetch(baseUrl + '/api/auth/register', { method: 'POST', ...opts, body: JSON.stringify({ email, password }) })); },
      async login(email, password){ return handle(await fetch(baseUrl + '/api/auth/login', { method: 'POST', ...opts, body: JSON.stringify({ email, password }) })); },
      async logout(){ return handle(await fetch(baseUrl + '/api/auth/logout', { method: 'POST', ...opts })); },
      async me(){ try { const r = await fetch(baseUrl + '/api/auth/me', { ...opts }); if (!r.ok) return null; const j = await r.json(); return j.user; } catch { return null; } },
      async getTasks(){ const j = await handle(await fetch(baseUrl + '/api/tasks', { ...opts })); return j.tasks; },
      async createTask(t){ return handle(await fetch(baseUrl + '/api/tasks', { method: 'POST', ...opts, body: JSON.stringify(t) })); },
      async updateTask(t){ return handle(await fetch(baseUrl + '/api/tasks/' + encodeURIComponent(t.id), { method: 'PUT', ...opts, body: JSON.stringify(t) })); },
      async deleteTask(id){ return handle(await fetch(baseUrl + '/api/tasks/' + encodeURIComponent(id), { method: 'DELETE', ...opts })); },
      async getVapidKey(){ return handle(await fetch(baseUrl + '/api/push/vapid-public-key', { ...opts })); },
      async subscribePush(sub){ return handle(await fetch(baseUrl + '/api/push/subscribe', { method: 'POST', ...opts, body: JSON.stringify(sub) })); },
      async unsubscribePush(sub){ return handle(await fetch(baseUrl + '/api/push/subscribe', { method: 'DELETE', ...opts, body: JSON.stringify({ endpoint: sub.endpoint }) })); },
    };
  }

  // Delegation for clicks on list (ensure keyboard friendliness out of the box)
  elements.list.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      const btn = e.target.closest('button, input[type="checkbox"]');
      if (btn) { e.preventDefault(); btn.click(); }
    }
  });

})();
