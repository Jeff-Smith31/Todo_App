/* TickTock Tasks - core app logic */
(function(){
  'use strict';

  const STORAGE_KEY = 'ticktock_tasks_v1';
  const SETTINGS_KEY = 'ticktock_settings_v1';
  const STAY_KEY = 'tt_stay_logged_in';
  const LAST_PUSH_TEST_KEY = 'tt_last_push_test';
  const runtimeCfg = window.RUNTIME_CONFIG || {};
  const hasRuntimeBE = Object.prototype.hasOwnProperty.call(runtimeCfg, 'BACKEND_URL');
  const runtimeBE = hasRuntimeBE ? runtimeCfg.BACKEND_URL : undefined; // allow empty string intentionally
  // No auto-derivation of api.<domain>; rely on config.js or user override in localStorage
  const BACKEND_URL = (runtimeBE ?? window.BACKEND_URL ?? '');
  let authToken = localStorage.getItem('tt_auth_token') || '';
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
    category: $('#category'),
    frequency: $('#frequency'),
    customWrap: $('#custom-days-wrap'),
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
    addCategoryBtn: $('#btn-add-category'),
    template: $('#task-item-template'),
  };

  let tasks = loadTasks();
  let settings = loadSettings();
  let isAuthed = false;
  let deferredPrompt = null; // for PWA install
  const timers = new Map(); // key -> timeout handle; key format: `${taskId}|day|1h|due`

  // Initialization
  document.addEventListener('DOMContentLoaded', init);

  function isMobile() {
    return (typeof window.orientation !== 'undefined') || (navigator.userAgent || '').indexOf('Mobi') >= 0 || window.innerWidth < 640;
  }

  async function init(){
    // Defaults
    elements.nextDue.value = todayStr();

    // Event listeners
    elements.frequency.addEventListener('change', onFreqChange);
    elements.form.addEventListener('submit', onSaveTask);
    elements.resetBtn.addEventListener('click', resetForm);
    elements.filterStatus.addEventListener('change', render);
    elements.search.addEventListener('input', render);

    // Search toggle (mobile): show search bar when tapping the icon next to title
    const btnSearchToggle = document.getElementById('btn-search-toggle');
    if (btnSearchToggle) {
      btnSearchToggle.addEventListener('click', (e) => {
        e.preventDefault();
        elements.search.classList.toggle('active');
        if (elements.search.classList.contains('active')) {
          elements.search.focus();
        }
      });
      // Collapse when clicking outside on mobile
      document.addEventListener('click', (ev) => {
        if (!isMobile()) return;
        const ts = document.querySelector('.title-and-search');
        if (!ts) return;
        if (!ts.contains(ev.target)) {
          elements.search.classList.remove('active');
        }
      });
    }

    elements.permissionBtn.addEventListener('click', requestNotificationPermission);


    // Categories init and UI
    ensureCategoryState();
    populateCategorySelect();
    if (elements.addCategoryBtn) elements.addCategoryBtn.addEventListener('click', addCategoryViaPrompt);


    // Auth
    const btnLogin = document.getElementById('btn-login');
    const btnRegister = document.getElementById('btn-register');
    const btnLogout = document.getElementById('btn-logout');
    const emailEl = document.getElementById('auth-email');
    const passEl = document.getElementById('auth-password');
    const stayEl = document.getElementById('stay-logged-in');
    if (stayEl) { stayEl.checked = localStorage.getItem(STAY_KEY) === 'true'; }

    if (btnLogin && btnRegister && btnLogout) {
      btnLogin.addEventListener('click', async () => {
        try {
          const stay = !!(stayEl && stayEl.checked);
          localStorage.setItem(STAY_KEY, stay ? 'true' : 'false');
          await API.login(emailEl.value, passEl.value);
          await syncFromBackend();
          updateAuthUi(true);
          if (Notification.permission === 'granted') { try { await ensurePushSubscribed(); await maybeTestPush('login'); } catch {} }
          location.hash = '#/tasks';
          route();
        } catch (e) { alert(e.message || 'Login failed'); }
      });
      btnRegister.addEventListener('click', async () => {
        try {
          const stay = !!(stayEl && stayEl.checked);
          localStorage.setItem(STAY_KEY, stay ? 'true' : 'false');
          await API.register(emailEl.value, passEl.value);
          await syncFromBackend();
          updateAuthUi(true);
          if (Notification.permission === 'granted') { try { await ensurePushSubscribed(); await maybeTestPush('register'); } catch {} }
          location.hash = '#/tasks';
          route();
        } catch (e) { alert(e.message || 'Registration failed'); }
      });
      btnLogout.addEventListener('click', async () => {
        try {
          await unsubscribePush();
        } catch {}
        try { await API.logout(); } catch {}
        localStorage.setItem(STAY_KEY, 'false');
        updateAuthUi(false);
        tasks = [];
        saveTasks();
        render();
        location.hash = '#/login';
        route();
      });
    }

    // Create/cancel task navigation
    const btnCreate = document.getElementById('btn-create');
    if (btnCreate) btnCreate.addEventListener('click', () => { resetForm(); location.hash = '#/tasks/new'; route(); });
    const btnCancel = document.getElementById('btn-cancel');
    if (btnCancel) btnCancel.addEventListener('click', () => { location.hash = '#/tasks'; route(); });

    // Router events
    window.addEventListener('hashchange', route);

    // PWA install
    function isStandalone(){
      return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || (window.navigator && window.navigator.standalone);
    }
    function isNativeWebView(){
      return !!window.ReactNativeWebView;
    }
    function hideInstall(){ if (elements.installBtn) elements.installBtn.style.display = 'none'; }
    function showInstall(){ if (elements.installBtn) elements.installBtn.style.display = 'inline-block'; }
    function isIosSafari(){
      const ua = navigator.userAgent || navigator.vendor || window.opera || '';
      const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      const isSafari = /^((?!chrome|android).)*safari/i.test(ua);
      return isIOS && isSafari;
    }
    // Initial visibility logic: if not installed and not inside native webview, show the button.
    if (elements.installBtn){
      if (isStandalone() || isNativeWebView()) {
        hideInstall();
      } else {
        showInstall();
      }
      window.addEventListener('appinstalled', hideInstall);
      if (window.matchMedia){
        try { window.matchMedia('(display-mode: standalone)').addEventListener('change', () => { if (isStandalone()) hideInstall(); }); } catch {}
      }
    }
    window.addEventListener('beforeinstallprompt', (e) => {
      if (isStandalone() || isNativeWebView()) return; // do not show inside mobile app or installed PWA
      e.preventDefault();
      deferredPrompt = e;
      showInstall();
    });
    function isAndroid(){
      return /Android/i.test(navigator.userAgent || '');
    }
    function isAndroidChromeOrEdge(){
      const ua = navigator.userAgent || '';
      return isAndroid() && (/Chrome\//i.test(ua) || /EdgA\//i.test(ua));
    }
    function isInAppBrowser(){
      const ua = (navigator.userAgent || '').toLowerCase();
      // Common in-app browsers where install prompt is not supported
      return ua.includes('instagram') || ua.includes('fbav') || ua.includes('fban') || ua.includes('line') || ua.includes('kakaotalk') || ua.includes('twitter') || ua.includes('snapchat') || ua.includes('gsa') || ua.includes('wv') || ua.includes('apk') || ua.includes('okhttp');
    }
    function showInstallHelp(){
      // Minimal, text-only guidance to keep footprint small
      if (isIosSafari()){
        alert('To install on iPhone/iPad: Tap the Share button, then "Add to Home Screen". This adds TickTock Tasks to your Home Screen with notifications.');
        return;
      }
      if (isInAppBrowser()){
        alert('Install is not available inside this in-app browser. Please open this page in Chrome (or your main browser) and use the menu → Install app. Tip: Tap the ••• or ⋮ menu → Open in Browser, then Install.');
        return;
      }
      if (isAndroidChromeOrEdge()){
        alert('To install on Android: Tap the ⋮ menu and choose "Install app" (or "Add to Home screen"). If you don\'t see it, browse the app for a bit and try again.');
        return;
      }
      alert('Your browser did not offer an install prompt. You can still add this app from your browser menu (Add to Home Screen or Install app).');
    }
    if (elements.installBtn){
      elements.installBtn.addEventListener('click', async () => {
        if (isStandalone() || isNativeWebView()) { hideInstall(); return; }
        if (deferredPrompt){
          try {
            deferredPrompt.prompt();
            await deferredPrompt.userChoice;
          } catch {}
          deferredPrompt = null;
          hideInstall();
        } else {
          // Fallback: show simple guidance when no install prompt is available yet (e.g., iOS Safari)
          showInstallHelp();
        }
      });
    }

    // Service worker
    if ('serviceWorker' in navigator){
      navigator.serviceWorker.register('sw.js').catch(()=>{});
    }

    // Desktop browsers: do not keep push subscriptions. We only support phone notifications.
    if (!isMobile()) {
      try { await unsubscribePush(); } catch {}
      if (elements.permissionBtn) elements.permissionBtn.style.display = 'none';
    } else {
      // On mobile: verify notification permission on every load; prompt if not granted
      try {
        if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
          // Small delay to avoid clashing with browser/UI load
          setTimeout(() => { try { requestNotificationPermission(); } catch {} }, 800);
        }
      } catch {}
    }


    // Backend mode: check session and sync; otherwise local-only
    // Connectivity diagnostics UI removed.

    if (BACKEND_URL) {
      if (authToken) {
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
        } catch (e) {
          // Surface connectivity error if any
          await updateBackendConnectivityStatus(e);
        }
      } else {
        // No token present → skip calling /api/auth/me to avoid 401 noise; remain in local mode
        isAuthed = false;
        updateAuthUi(false);
      }
    }

    // Handle missed tasks on load
    handleMissedTasks();

    // Rollover: after a day boundary, advance nextDue for tasks completed on a prior day (once)
    applyCompletionRollover();

    // Render UI
    render();

    // Set up notifications for due tasks today
    scheduleAllNotificationsForToday();

    // Show permission button state
    refreshPermissionButton();

    // Version UI and update checks
    setupVersionUiAndUpdater();

    // On focus, ensure we have an active push subscription (Android reliability)
    window.addEventListener('visibilitychange', async () => {
      if (document.hidden) return;
      try {
        if (!BACKEND_URL || !isAuthed) return;
        if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (!sub) { await ensurePushSubscribed(); }
      } catch {}
    });
    
    // Initial route
    const stay = localStorage.getItem(STAY_KEY) === 'true';
    if (!location.hash) {
      location.hash = (stay && isAuthed) ? '#/tasks' : '#/login';
    }
    route();
  }

  function onFreqChange(){
    const val = elements.frequency.value;
    elements.customWrap.classList.toggle('hidden', val !== 'custom');
  }

  function readSelectedWeekdays(){
    const boxes = Array.from(document.querySelectorAll('#custom-days-wrap input.wd'));
    return boxes.filter(b=>b.checked).map(b=>parseInt(b.value,10));
  }

  function setSelectedWeekdays(days){
    const boxes = Array.from(document.querySelectorAll('#custom-days-wrap input.wd'));
    for (const b of boxes){ b.checked = Array.isArray(days) && days.includes(parseInt(b.value,10)); }
  }

  // Simple router to separate Login, Tasks list, and Task form pages
  function route(){
    const pageLogin = document.getElementById('page-login');
    const pageTasks = document.getElementById('page-tasks');
    const pageForm = document.getElementById('page-task-form');
    const show = (pg) => {
      if (pageLogin) pageLogin.classList.add('hidden');
      if (pageTasks) pageTasks.classList.add('hidden');
      if (pageForm) pageForm.classList.add('hidden');
      if (pg) pg.classList.remove('hidden');
      // focus management could be added here if needed
    };

    const raw = (location.hash || '').replace(/^#/, '');
    const parts = raw.split('/').filter(Boolean); // e.g., ['tasks','new'] or ['tasks', '<id>', 'edit']

    // Auth-aware navigation: allow local mode even if a backend is configured.
    // Only redirect away from the login page when already authenticated AND Stay Logged In is enabled.
    if (BACKEND_URL && isAuthed && (localStorage.getItem(STAY_KEY) === 'true')) {
      if (parts[0] === 'login') {
        location.hash = '#/tasks';
        if (pageTasks) show(pageTasks);
        return;
      }
    }

    // Routes
    if (parts.length === 0) {
      // default: show login when not authenticated
      if (!isAuthed) {
        show(pageLogin);
      } else {
        show(pageTasks);
        render();
      }
      return;
    }

    const [root, p1, p2] = parts;
    if (root === 'login') {
      show(pageLogin);
      return;
    }
    if (root === 'tasks') {
      if (p1 === 'new') {
        resetForm();
        show(pageForm);
        return;
      }
      if (p2 === 'edit' && p1) {
        const id = decodeURIComponent(p1);
        const t = tasks.find(x => x.id === id);
        if (t) {
          elements.id.value = t.id;
          elements.title.value = t.title;
          elements.notes.value = t.notes || '';
          if (t.scheduleDays && t.scheduleDays.length) {
            elements.frequency.value = 'custom';
            elements.customWrap.classList.remove('hidden');
            setSelectedWeekdays(t.scheduleDays);
          } else if (t.oneOff === true) {
            elements.frequency.value = 'once';
            elements.customWrap.classList.add('hidden');
          } else if (t.everyDays === 1 || t.everyDays === 7 || t.everyDays === 30) {
            elements.frequency.value = String(t.everyDays);
            elements.customWrap.classList.add('hidden');
          } else {
            elements.frequency.value = 'custom';
            elements.customWrap.classList.remove('hidden');
            // No numeric custom interval; leave weekday selection empty by default
          }
          elements.nextDue.value = t.nextDue;
          elements.remindAt.value = t.remindAt;
          if (elements.category) {
            ensureCategoryState();
            populateCategorySelect();
            elements.category.value = t.category || 'Default';
          }
          show(pageForm);
          return;
        }
        // if task not found, go back to list
        location.hash = '#/tasks';
        show(pageTasks);
        render();
        return;
      }
      // default tasks list
      show(pageTasks);
      render();
      return;
    }

    // Fallback
    if (!isAuthed) {
      show(pageLogin);
    } else {
      show(pageTasks);
      render();
    }
  }

  async function onSaveTask(e){
    e.preventDefault();
    const id = elements.id.value || cryptoRandomId();
    const freqVal = elements.frequency.value;
    const scheduleDays = (freqVal === 'custom') ? readSelectedWeekdays() : undefined;
    const isOnce = (freqVal === 'once');
    const everyDays = (freqVal === 'custom') ? 7 : (isOnce ? 1 : parseInt(freqVal, 10));

    const t = {
      id,
      title: elements.title.value.trim(),
      notes: elements.notes.value.trim(),
      category: elements.category ? (elements.category.value || 'Default') : 'Default',
      everyDays,
      scheduleDays,
      nextDue: elements.nextDue.value,
      remindAt: elements.remindAt.value,
      priority: false,
      oneOff: isOnce, 
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
    location.hash = '#/tasks';
    route();
  }

  function resetForm(){
    elements.id.value = '';
    elements.title.value = '';
    elements.notes.value = '';
    elements.frequency.value = '1';
    elements.customWrap.classList.add('hidden');
    elements.nextDue.value = todayStr();
    elements.remindAt.value = '09:00';
    if (elements.category) {
      ensureCategoryState();
      populateCategorySelect();
      elements.category.value = settings.categories[0] || 'Default';
    }
  }

  // CRUD helpers
  function editTask(id){
    // Navigate to edit page; form will be prefilled by router
    location.hash = '#/tasks/' + encodeURIComponent(id) + '/edit';
    route();
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
      // If one-off, delete immediately after marking complete
      if (t.oneOff === true) {
        try { t.lastCompleted = nowIso; } catch {}
        await deleteTask(t.id);
        return;
      }
      // Mark complete but DO NOT advance nextDue until the next day (post-rollover)
      t.lastCompleted = nowIso;
      t.priority = false; // clear priority once completed
      // Track that we have not yet rolled this completion into the schedule
      t.rolledFromCompletion = t.rolledFromCompletion || null;
      if (BACKEND_URL && isAuthed) { try { await API.updateTask(t); await syncFromBackend(); } catch(e){ console.warn(e); } }
      saveTasks();
      render();
      scheduleNotificationForTask(t);
    } else {
      // Unchecking the same day should simply clear lastCompleted; do not modify nextDue
      const todayStrVal = dateToYMD(new Date());
      const completedToday = !!t.lastCompleted && dateToYMD(new Date(t.lastCompleted)) === todayStrVal;
      if (completedToday) {
        t.lastCompleted = null;
        // Also clear any pending rolledFromCompletion marker for today
        if (t.rolledFromCompletion === todayStrVal) t.rolledFromCompletion = null;
      }
      if (BACKEND_URL && isAuthed) { try { await API.updateTask(t); await syncFromBackend(); } catch(e){ console.warn(e); } }
      saveTasks();
      render();
      scheduleNotificationForTask(t);
    }
  }

  // Rendering
  function render(){
    const filter = elements.filterStatus.value;
    const q = elements.search.value.trim().toLowerCase();

    const filtered = tasks.filter(t => {
      if (!t.category) t.category = 'Default';
      if (q && !(t.title.toLowerCase().includes(q) || (t.notes||'').toLowerCase().includes(q))) return false;
      if (filter === 'today') {
        const lc = t.lastCompleted ? dateToYMD(new Date(t.lastCompleted)) : '';
        const today = todayStr();
        return isDueToday(t) || lc === today;
      }
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

    // Categories to render: union of known categories and those present in filtered tasks
    ensureCategoryState();
    const presentCats = Array.from(new Set(filtered.map(t => t.category || 'Default')));
    const catOrder = Array.from(new Set([...(settings.categories || []), ...presentCats]));

    for (const catName of catOrder){
      const catTasks = filtered.filter(t => (t.category || 'Default') === catName);
      // Build section
      const details = document.createElement('details');
      details.className = 'category-section';
      details.open = settings.categoryOpen[catName] !== false; // default open
      details.addEventListener('toggle', () => setCategoryOpen(catName, details.open));

      const summary = document.createElement('summary');
      summary.innerHTML = `<strong>${catName}</strong> <span style="opacity:0.7">(${catTasks.length})</span>`;

      // Controls: rename/delete (icon buttons like task items)
      const actions = document.createElement('span');
      actions.className = 'cat-actions';
      const btnRen = document.createElement('button');
      btnRen.type = 'button';
      btnRen.className = 'btn icon edit';
      btnRen.title = 'Rename category';
      btnRen.setAttribute('aria-label', 'Rename category');
      btnRen.textContent = '✏️';
      btnRen.addEventListener('click', (e)=>{ e.preventDefault(); e.stopPropagation(); renameCategory(catName); });
      const btnDel = document.createElement('button');
      btnDel.type = 'button';
      btnDel.className = 'btn icon delete';
      btnDel.title = 'Delete category';
      btnDel.setAttribute('aria-label', 'Delete category');
      btnDel.textContent = '🗑️';
      btnDel.addEventListener('click', (e)=>{ e.preventDefault(); e.stopPropagation(); deleteCategory(catName); });
      if (catName === 'Default') btnDel.disabled = true;
      actions.appendChild(btnRen); actions.appendChild(btnDel);
      summary.appendChild(actions);

      details.appendChild(summary);

      const ul = document.createElement('ul');
      ul.className = 'task-list';

      for (const t of catTasks){
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
        const scheduleText = (t.oneOff === true)
          ? `• Once`
          : (t.scheduleDays && t.scheduleDays.length)
            ? `• ${t.scheduleDays.map(d=>['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d]).join(', ')}`
            : `• Every ${t.everyDays} day(s)`;
        meta.textContent = `Due: ${formatDate(dueDate)} at ${formatTime(dueTime)} ${scheduleText}`;

        // badges
        toggleHidden(bPriority, !t.priority);
        toggleHidden(bOverdue, !isOverdue(t));
        toggleHidden(bToday, !(isDueToday(t) && !isOverdue(t)));

        // checkbox reflects if task was completed today; keep it checked until next day
        const todayStrVal = dateToYMD(new Date());
        const completedToday = !!t.lastCompleted && dateToYMD(new Date(t.lastCompleted)) === todayStrVal;
        checkbox.checked = completedToday;
        if (completedToday) {
          node.classList.add('completed-today');
        } else {
          node.classList.remove('completed-today');
        }

        // Grey out tasks that are not due today (future) without crossing out; keep overdue and today normal prominence
        const dueToday = isDueToday(t);
        const overdue = isOverdue(t);
        // Highlight due-today (uncompleted) items and grey out only future (not-today) ones
        if (!completedToday && !overdue && !dueToday) {
          node.classList.add('not-today');
        } else {
          node.classList.remove('not-today');
        }
        if (!completedToday && dueToday && !overdue) {
          node.classList.add('due-today-item');
        } else {
          node.classList.remove('due-today-item');
        }

        checkbox.addEventListener('change', () => toggleComplete(t.id, checkbox.checked));

        node.querySelector('button.edit').addEventListener('click', () => editTask(t.id));
        node.querySelector('button.delete').addEventListener('click', () => deleteTask(t.id));

        ul.appendChild(node);
      }

      details.appendChild(ul);
      elements.list.appendChild(details);
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

  // Categories
  function ensureCategoryState(){
    if (!settings.categories || !Array.isArray(settings.categories) || settings.categories.length === 0){
      settings.categories = ['Default'];
    }
    if (!settings.categoryOpen || typeof settings.categoryOpen !== 'object') settings.categoryOpen = {};
    if (typeof settings.categoryOpen['Default'] === 'undefined') settings.categoryOpen['Default'] = true;
    // Migrate tasks without category
    let changed = false;
    for (const t of tasks){
      if (!t.category) { t.category = 'Default'; changed = true; }
    }
    if (changed) saveTasks();
    saveSettings();
  }

  function populateCategorySelect(){
    if (!elements.category) return;
    // Clear
    elements.category.innerHTML = '';
    for (const name of settings.categories){
      const opt = document.createElement('option');
      opt.value = name; opt.textContent = name;
      elements.category.appendChild(opt);
    }
    // Ensure a value is selected
    const cur = elements.category.value;
    if (!cur || !settings.categories.includes(cur)) elements.category.value = settings.categories[0] || 'Default';
  }

  function addCategoryViaPrompt(){
    const name = (prompt('New category name:') || '').trim();
    if (!name) return;
    if (settings.categories.includes(name)) { alert('Category already exists'); return; }
    settings.categories.push(name);
    settings.categoryOpen[name] = true;
    saveSettings();
    populateCategorySelect();
    render();
  }

  async function renameCategory(oldName){
    const name = (prompt('Rename category:', oldName) || '').trim();
    if (!name || name === oldName) return;
    if (settings.categories.includes(name)) { alert('A category with that name already exists'); return; }

    const idx = settings.categories.indexOf(oldName);
    if (idx >= 0) settings.categories[idx] = name;

    // Collect tasks to update
    const toUpdate = tasks.filter(t => (t.category || 'Default') === oldName);
    for (const t of toUpdate) { t.category = name; }

    // Preserve open/closed state for the renamed section
    settings.categoryOpen[name] = !!settings.categoryOpen[oldName];
    delete settings.categoryOpen[oldName];

    // Persist locally first for instant UX
    saveTasks();
    saveSettings();
    populateCategorySelect();
    render();

    // If connected, persist category change for affected tasks to backend
    if (BACKEND_URL && isAuthed && toUpdate.length) {
      try {
        await Promise.allSettled(toUpdate.map(t => API.updateTask(t)));
        await syncFromBackend();
      } catch (e) { console.warn('Category rename sync failed', e); }
    }
  }

  function deleteCategory(name){
    if (name === 'Default') { alert('Default category cannot be deleted'); return; }
    const used = tasks.some(t => t.category === name);
    if (used) { alert('Category has tasks. Move or edit tasks before deleting.'); return; }
    settings.categories = settings.categories.filter(n => n !== name);
    delete settings.categoryOpen[name];
    saveSettings();
    populateCategorySelect();
    render();
  }

  function setCategoryOpen(name, open){
    settings.categoryOpen[name] = !!open;
    saveSettings();
  }

  async function syncFromBackend(){
    if (!BACKEND_URL) return;
    try {
      const list = await API.getTasks();
      if (Array.isArray(list)) {
        tasks = list;
        saveTasks();
        render();
        // Reschedule local notifications for updated tasks (no-op when backend push is used)
        scheduleAllNotificationsForToday();
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
    if (emailEl) emailEl.style.display = authed ? 'none' : 'inline-block';
    if (passEl) passEl.style.display = authed ? 'none' : 'inline-block';
    if (btnLogin) btnLogin.style.display = authed ? 'none' : 'inline-block';
    if (btnRegister) btnRegister.style.display = authed ? 'none' : 'inline-block';
    if (btnLogout) btnLogout.style.display = authed ? 'inline-block' : 'none';
  }

  // Missed tasks handling: if due time has passed without completion, move to next day and mark priority
  function handleMissedTasks(){
    // In local-only mode, roll missed tasks and show a local notification about new deadline.
    if (BACKEND_URL && isAuthed) return; // backend handles missed
    const now = new Date();
    let changed = false;
    for (const t of tasks){
      const dueDt = parseDueDateTime(t.nextDue, t.remindAt);
      if (dueDt.getTime() < now.getTime()){
        // de-dup missed notification by base key
        const baseKey = `${t.nextDue}T${t.remindAt}|missed`;
        if (!settings.sent) settings.sent = {};
        if (!settings.sent[baseKey]){
          // Show local missed notification if permission is granted
          try {
            if (typeof Notification !== 'undefined' && Notification.permission === 'granted'){
              const body = (t.notes ? `${t.notes}\n` : '') + `Missed. New deadline: tomorrow at ${t.remindAt}`;
              new Notification(`Missed: ${t.title}`, { body, icon: 'icons/logo.svg', badge: 'icons/logo.svg', tag: `task-${t.id}` });
            }
          } catch {}
          settings.sent[baseKey] = true;
          saveSettings();
        }
        // Move to next day and mark priority
        const nextDay = addDays(t.nextDue, 1);
        t.nextDue = nextDay;
        t.priority = true;
        changed = true;
      }
    }
    if (changed) saveTasks();
  }

  // Completion rollover: advance nextDue the day AFTER a completion, exactly once per completed day
  function applyCompletionRollover(){
    const today = todayStr();
    let changed = false;
    for (const t of tasks){
      if (!t.lastCompleted) continue;
      const lcYmd = dateToYMD(new Date(t.lastCompleted));
      if (lcYmd < today) {
        // Only roll once per completion day
        if (t.rolledFromCompletion !== lcYmd) {
          t.nextDue = addDays(t.nextDue, t.everyDays);
          t.rolledFromCompletion = lcYmd;
          changed = true;
        }
      }
    }
    if (changed) { saveTasks(); }
  }

  // Notifications
  function refreshPermissionButton(){
    if (!elements.permissionBtn) return;
    // Desktop Chrome/Web: do not offer push; only mobile devices should see this.
    if (!isMobile()) {
      elements.permissionBtn.style.display = 'none';
      return;
    }
    const supported = typeof Notification !== 'undefined' && Notification && typeof Notification.permission === 'string';
    const state = supported ? Notification.permission : 'denied';
    if (!supported) {
      elements.permissionBtn.style.display = 'none';
      return;
    }
    const ua = navigator.userAgent || navigator.vendor || '';
    const isiOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const inStandalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || (window.navigator && window.navigator.standalone === true);
    if (state === 'granted'){
      // Hide the button completely once enabled
      elements.permissionBtn.style.display = 'none';
    } else {
      elements.permissionBtn.disabled = false;
      elements.permissionBtn.style.display = 'inline-block';
      if (isiOS && !inStandalone) {
        elements.permissionBtn.textContent = 'Enable Notifications (Install App Required on iOS)';
      } else {
        elements.permissionBtn.textContent = 'Enable Notifications';
      }
    }
  }

  async function requestNotificationPermission(){
    // Only mobile devices should enable notifications for this app.
    if (!isMobile()) {
      alert('Notifications are only available on the mobile app. Please use your phone to receive reminders.');
      return;
    }
    if (!('Notification' in window)){
      alert('Notifications are not supported in this browser');
      return;
    }
    // iOS requires the app to be installed (standalone) to allow Web Push
    const ua = navigator.userAgent || navigator.vendor || '';
    const isiOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const inStandalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || (window.navigator && window.navigator.standalone === true);
    if (isiOS && !inStandalone) {
      alert('To enable push notifications on iPhone/iPad, please install the app first: tap the Share button and choose "Add to Home Screen", then open the installed app to enable notifications.');
      return;
    }
    try {
      const res = await Notification.requestPermission();
      if (res !== 'granted') {
        alert('To receive reminders, please allow notifications. You can change this in your browser settings.');
      } else {
        // Ask for storage persistence to improve reliability on mobile
        if (navigator.storage && navigator.storage.persist) { try { await navigator.storage.persist(); } catch {} }
        // Ensure push subscription with backend and run a self-test
        try {
          await ensurePushSubscribed();
          await maybeTestPush('permission-granted');
        } catch {}
      }
    } catch (e) {}
    refreshPermissionButton();
    scheduleAllNotificationsForToday();
  }

  function scheduleAllNotificationsForToday(){
    // clear existing timers
    for (const [key, h] of timers.entries()){
      clearTimeout(h); timers.delete(key);
    }
    for (const t of tasks){
      scheduleNotificationForTask(t);
    }
  }

  function scheduleNotificationForTask(t){
    cancelScheduledNotification(t.id);
    // When connected to backend and authed, backend push will handle all stages.
    if (BACKEND_URL && isAuthed) return;
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    scheduleNotificationsForTaskStages(t);
  }

  function scheduleNotificationsForTaskStages(t){
    const now = new Date();
    const today = dateToYMD(now);
    const dueDt = parseDueDateTime(t.nextDue, t.remindAt);
    const baseKey = `${t.nextDue}T${t.remindAt}`;

    if (!settings.sent) settings.sent = {};

    // Helper to schedule with dedup and key in timers map
    function scheduleAt(when, kind, fireIfPast=false){
      const sentKey = `${baseKey}|${kind}`;
      if (settings.sent[sentKey]) return;
      const delay = when.getTime() - Date.now();
      const run = () => {
        if (settings.sent[sentKey]) return;
        // Show notification
        let title = t.title;
        let body;
        if (kind === 'day') {
          title = `Today: ${t.title}`;
          body = (t.notes ? `${t.notes}\n` : '') + `Due today at ${t.remindAt}`;
        } else if (kind === '1h') {
          title = `1 hour left: ${t.title}`;
          body = (t.notes ? `${t.notes}\n` : '') + `~1 hour until due (${t.remindAt})`;
        } else {
          // due
          body = t.notes ? `${t.notes}\nEvery ${t.everyDays} day(s)` : `Every ${t.everyDays} day(s)`;
        }
        showTaskNotification(t, title, body);
        settings.sent[sentKey] = true;
        saveSettings();
      };
      const key = `${t.id}|${baseKey}|${kind}`;
      if (delay <= 0) {
        if (fireIfPast) {
          // fire soon (next tick)
          const handle = setTimeout(run, 0);
          timers.set(key, handle);
        }
        return;
      }
      const handle = setTimeout(run, delay);
      timers.set(key, handle);
    }

    // Only schedule for today to keep timers bounded
    if (!isDueTodayRawDateStr(t.nextDue, today)) return;

    // Day-of: if before due time and not yet sent → fire immediately
    if (now < dueDt) {
      scheduleAt(now, 'day', true);
    }

    // 1-hour before
    const oneHourBefore = new Date(dueDt.getTime() - 60*60*1000);
    if (oneHourBefore > now) {
      scheduleAt(oneHourBefore, '1h');
    } else if (dueDt > now) {
      // If we are already within the last hour and not sent yet, fire now
      scheduleAt(now, '1h', true);
    }

    // Due-time
    if (dueDt > now) {
      scheduleAt(dueDt, 'due');
    }
  }

  function cancelScheduledNotification(id){
    // cancel all timers for this task id
    for (const [key, h] of Array.from(timers.entries())){
      if (key.startsWith(id + '|')) { clearTimeout(h); timers.delete(key); }
    }
  }

  function showTaskNotification(t, titleOverride, bodyOverride){
    let defaultBody;
    if (t.oneOff === true) {
      defaultBody = t.notes ? `${t.notes}\nOne-off task` : 'One-off task';
    } else {
      defaultBody = t.notes ? `${t.notes}\nEvery ${t.everyDays} day(s)` : `Every ${t.everyDays} day(s)`;
    }
    const body = bodyOverride || defaultBody;
    const title = titleOverride || t.title;
    const n = new Notification(title, {
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
    // Parse YYYY-MM-DD as a LOCAL date to avoid UTC off-by-one errors
    const [y, m, d] = String(dateStr).split('-').map(Number);
    const dt = new Date(Number.isFinite(y)?y:1970, (Number.isFinite(m)?m:1)-1, Number.isFinite(d)?d:1, 0, 0, 0, 0);
    dt.setDate(dt.getDate() + n);
    return dateToYMD(dt);
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
  function parseLocalYMD(ymd){
    const [y, m, d] = String(ymd).split('-').map(Number);
    return new Date(Number.isFinite(y)?y:1970, (Number.isFinite(m)?m:1)-1, Number.isFinite(d)?d:1, 0, 0, 0, 0);
  }
  function isDueTodayRawDateStr(target, today){
    // Interpret YYYY-MM-DD strings as LOCAL dates to avoid UTC off-by-one issues
    try {
      const ymd = dateToYMD(parseLocalYMD(target));
      return ymd === String(today).trim();
    } catch {
      return String(target).trim() === String(today).trim();
    }
  }
  function formatDate(dateStr){
    try {
      const [y, m, d] = String(dateStr).split('-').map(Number);
      if (Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(d)) {
        // Interpret YYYY-MM-DD as a LOCAL date to avoid UTC off-by-one when displaying
        const local = new Date(y, (m || 1) - 1, d || 1, 0, 0, 0, 0);
        return local.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
      }
    } catch {}
    // Fallback: try native Date parsing, or return raw string
    try {
      const dt = new Date(dateStr);
      return dt.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch { return String(dateStr); }
  }
  function formatTime(timeStr){
    const [h,m] = timeStr.split(':').map(Number);
    const d = new Date(); d.setHours(h||0, m||0, 0, 0);
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  function toggleHidden(el, hidden){ el.classList.toggle('hidden', hidden); }

  // Push helpers
  async function maybeTestPush(reason){
    try {
      if (!BACKEND_URL || !isAuthed) return;
      if (!isMobile()) return; // Do not send test push for desktop
      // Throttle tests to avoid spamming: max once per 6 hours unless explicitly from permission grant
      const now = Date.now();
      const last = parseInt(localStorage.getItem(LAST_PUSH_TEST_KEY) || '0', 10) || 0;
      if (reason !== 'permission-granted' && now - last < 6 * 60 * 60 * 1000) return;
      const resp = await API.testPush();
      localStorage.setItem(LAST_PUSH_TEST_KEY, String(now));
      // Give user clear feedback
      alert('A test notification has been sent to your device. If you do not see it within a minute, ensure notifications are allowed for your app and, on iPhone/iPad, that the app is installed from the Home Screen.');
      return resp;
    } catch (e) {
      // If push not configured (503) or other error, inform user gently
      const msg = (e && e.message) ? String(e.message) : 'Push test failed';
      alert('Could not send a test notification: ' + msg + '\nIf this persists, try re-enabling notifications, reinstalling the app (on iOS), or logging out and back in.');
    }
  }

  async function ensurePushSubscribed(){
    // Ensure environment supports required APIs
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    // Wait for the service worker to be active; fixes Android race conditions
    const reg = await (navigator.serviceWorker.ready.catch(() => navigator.serviceWorker.getRegistration()));
    if (!reg) return;
    // If notifications are not granted, do not attempt to subscribe
    if (typeof Notification !== 'undefined' && Notification.permission !== 'granted') return;

    // Always fetch current VAPID key first to detect rotations
    let keyResp = null;
    try { keyResp = await API.getVapidKey(); } catch { keyResp = { key: '' }; }
    const currentKey = (keyResp && keyResp.key) ? keyResp.key : '';
    if (!currentKey) return; // push disabled or backend unavailable
    const storedKey = localStorage.getItem('tt_vapid_pub') || '';

    let existing = null;
    try { existing = await reg.pushManager.getSubscription(); } catch {}

    // If we have an existing subscription but the server key changed, unsubscribe and recreate
    if (existing && storedKey && storedKey !== currentKey) {
      try { await API.unsubscribePush(existing); } catch {}
      try { await existing.unsubscribe(); } catch {}
      existing = null;
    }

    if (existing) {
      // Ensure backend has current subscription (idempotent upsert) and stored key matches
      try { await API.subscribePush(existing); } catch {}
      if (storedKey !== currentKey) { localStorage.setItem('tt_vapid_pub', currentKey); }
      return existing;
    }

    // Subscribe with current server key
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(currentKey)
    });
    try { await API.subscribePush(sub); } catch {}
    localStorage.setItem('tt_vapid_pub', currentKey);
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
    const common = { credentials: 'include' };
    const buildHeaders = () => {
      const h = { 'Content-Type': 'application/json' };
      if (authToken) h['Authorization'] = 'Bearer ' + authToken;
      return h;
    };
    async function handle(res){
      const ct = res.headers.get('content-type') || '';
      const data = ct.includes('application/json') ? await res.json().catch(()=>null) : await res.text();
      if (!res.ok) throw new Error((data && data.error) || (typeof data === 'string' ? data : 'Request failed'));
      return data;
    }
    return {
      async register(email, password){
        const data = await handle(await fetch(baseUrl + '/api/auth/register', { method: 'POST', ...common, headers: buildHeaders(), body: JSON.stringify({ email, password }) }));
        if (data && data.token) { authToken = data.token; localStorage.setItem('tt_auth_token', authToken); }
        return data;
      },
      async login(email, password){
        const data = await handle(await fetch(baseUrl + '/api/auth/login', { method: 'POST', ...common, headers: buildHeaders(), body: JSON.stringify({ email, password }) }));
        if (data && data.token) { authToken = data.token; localStorage.setItem('tt_auth_token', authToken); }
        return data;
      },
      async logout(){
        try { await handle(await fetch(baseUrl + '/api/auth/logout', { method: 'POST', ...common, headers: buildHeaders() })); } finally {
          authToken = ''; localStorage.removeItem('tt_auth_token');
        }
        return { ok: true };
      },
      async me(){ try { const r = await fetch(baseUrl + '/api/auth/me', { ...common, headers: buildHeaders() }); if (!r.ok) return null; const j = await r.json(); return j.user; } catch { return null; } },
      async getTasks(){ const j = await handle(await fetch(baseUrl + '/api/tasks', { ...common, headers: buildHeaders() })); return j.tasks; },
      async createTask(t){
        try {
          return await handle(await fetch(baseUrl + '/api/tasks', { method: 'POST', ...common, headers: buildHeaders(), body: JSON.stringify(t) }));
        } catch (e) {
          const msg = (e && e.message) ? String(e.message) : '';
          if (/category/i.test(msg) || /is not allowed/i.test(msg)) {
            // 1st fallback: remove category and retry (legacy backend without category support)
            const t2 = { ...t }; delete t2.category;
            try {
              return await handle(await fetch(baseUrl + '/api/tasks', { method: 'POST', ...common, headers: buildHeaders(), body: JSON.stringify(t2) }));
            } catch (e2) {
              const msg2 = (e2 && e2.message) ? String(e2.message) : '';
              if (/is not allowed/i.test(msg2) || /category/i.test(msg2)) {
                // 2nd fallback: send a minimal legacy-compatible payload
                const t3 = {
                  id: t.id,
                  title: t.title,
                  notes: t.notes || '',
                  everyDays: t.everyDays,
                  scheduleDays: Array.isArray(t.scheduleDays) ? t.scheduleDays : undefined,
                  nextDue: t.nextDue,
                  remindAt: t.remindAt,
                  priority: !!t.priority,
                  lastCompleted: t.lastCompleted || undefined,
                };
                Object.keys(t3).forEach(k => t3[k] === undefined && delete t3[k]);
                return await handle(await fetch(baseUrl + '/api/tasks', { method: 'POST', ...common, headers: buildHeaders(), body: JSON.stringify(t3) }));
              }
              throw e2;
            }
          }
          throw e;
        }
      },
      async updateTask(t){
        try {
          return await handle(await fetch(baseUrl + '/api/tasks/' + encodeURIComponent(t.id), { method: 'PUT', ...common, headers: buildHeaders(), body: JSON.stringify(t) }));
        } catch (e) {
          const msg = (e && e.message) ? String(e.message) : '';
          if (/category/i.test(msg) || /is not allowed/i.test(msg)) {
            // 1st fallback: remove category and retry
            const t2 = { ...t }; delete t2.category;
            try {
              return await handle(await fetch(baseUrl + '/api/tasks/' + encodeURIComponent(t.id), { method: 'PUT', ...common, headers: buildHeaders(), body: JSON.stringify(t2) }));
            } catch (e2) {
              const msg2 = (e2 && e2.message) ? String(e2.message) : '';
              if (/is not allowed/i.test(msg2) || /category/i.test(msg2)) {
                // 2nd fallback: minimal payload
                const t3 = {
                  title: t.title,
                  notes: t.notes || '',
                  everyDays: t.everyDays,
                  scheduleDays: Array.isArray(t.scheduleDays) ? t.scheduleDays : undefined,
                  nextDue: t.nextDue,
                  remindAt: t.remindAt,
                  priority: !!t.priority,
                  lastCompleted: t.lastCompleted || undefined,
                };
                Object.keys(t3).forEach(k => t3[k] === undefined && delete t3[k]);
                return await handle(await fetch(baseUrl + '/api/tasks/' + encodeURIComponent(t.id), { method: 'PUT', ...common, headers: buildHeaders(), body: JSON.stringify(t3) }));
              }
              throw e2;
            }
          }
          throw e;
        }
      },
      async deleteTask(id){ return handle(await fetch(baseUrl + '/api/tasks/' + encodeURIComponent(id), { method: 'DELETE', ...common, headers: buildHeaders() })); },
      async getVapidKey(){
        const res = await fetch(baseUrl + '/api/push/vapid-public-key', { ...common, headers: buildHeaders() });
        if (res.status === 503) return { key: '' }; // push not configured on backend
        if (!res.ok) {
          // Treat any error as push disabled to avoid noisy console errors
          return { key: '' };
        }
        try { return await res.json(); } catch { return { key: '' }; }
      },
      async subscribePush(sub){
        const tzOffsetMinutes = -new Date().getTimezoneOffset();
        const payload = Object.assign({}, sub, { tzOffsetMinutes });
        return handle(await fetch(baseUrl + '/api/push/subscribe', { method: 'POST', ...common, headers: buildHeaders(), body: JSON.stringify(payload) }));
      },
      async unsubscribePush(sub){ return handle(await fetch(baseUrl + '/api/push/subscribe', { method: 'DELETE', ...common, headers: buildHeaders(), body: JSON.stringify({ endpoint: sub.endpoint }) })); },
      async testPush(){ return handle(await fetch(baseUrl + '/api/push/test', { method: 'POST', ...common, headers: buildHeaders() })); },
    };
  }

  // Delegation for clicks on list (ensure keyboard friendliness out of the box)
  elements.list.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      const btn = e.target.closest('button, input[type="checkbox"]');
      if (btn) { e.preventDefault(); btn.click(); }
    }
  });

  // Version visible pill and update workflow
  function setupVersionUiAndUpdater(){
    const current = (window.APP_VERSION || 'dev').toString();
    const pillTxt = document.getElementById('app-version-text');
    if (pillTxt) pillTxt.textContent = current;

    const btnUpdate = document.getElementById('btn-update');
    if (btnUpdate) {
      btnUpdate.addEventListener('click', async () => {
        // Stop flashing once the user acknowledges the update
        btnUpdate.classList.remove('flash');
        try {
          // Ask SW to update then reload
          if ('serviceWorker' in navigator) {
            const reg = await navigator.serviceWorker.getRegistration();
            if (reg) { try { await reg.update(); } catch {} }
          }
        } catch {}
        // Hard reload bypassing cache if possible
        location.reload(true);
      });
    }

    async function checkLatest(){
      try {
        const res = await fetch(`version.json?ts=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json().catch(()=>null);
        const latest = (data && data.version) ? String(data.version) : null;
        if (!latest) return;
        if (latest !== current) {
          // Mobile → show update button; Desktop → auto reload
          // Always let the user choose when to update to avoid unexpected reload loops
          if (btnUpdate) { btnUpdate.style.display = 'inline-block'; btnUpdate.classList.add('flash'); }
        }
      } catch {}
    }
    // Poll every 30s and also on tab focus
    checkLatest();
    const iv = setInterval(checkLatest, 30000);
    window.addEventListener('visibilitychange', () => { if (!document.hidden) checkLatest(); });
  }

  async function updateBackendConnectivityStatus(err){
    const el = elements.backendStatus;
    if (!el) return;
    if (!BACKEND_URL) { el.textContent = 'Local-only mode (no backend set)'; return; }
    el.textContent = `Checking connectivity to ${BACKEND_URL}…`;
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 6000);
    try {
      const res = await fetch(BACKEND_URL.replace(/\/$/, '') + '/api/ping', { credentials: 'include', signal: ctrl.signal });
      clearTimeout(to);
      if (res.ok) {
        const j = await res.json().catch(()=>null);
        el.textContent = `Backend reachable: ${(j && j.service) ? j.service : 'ok'}`;
        el.style.color = '#0a0';
      } else {
        el.textContent = `Backend responded with HTTP ${res.status}`;
        el.style.color = '#b00';
      }
    } catch (e) {
      clearTimeout(to);
      el.textContent = `Cannot reach backend at ${BACKEND_URL}. ${(err?.message || e?.message || '').toString()}`;
      el.style.color = '#b00';
    }
  }

})();
