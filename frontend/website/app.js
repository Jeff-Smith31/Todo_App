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
  const lsBE = (typeof localStorage !== 'undefined') ? (localStorage.getItem('tt_backend_url') || '') : '';
  // Resolve backend URL in priority order:
  // 1) Explicit runtime config if provided; 2) localStorage override (tt_backend_url);
  // 3) window.BACKEND_URL; otherwise empty (local-only mode)
  const BACKEND_URL = (hasRuntimeBE ? (runtimeBE || '') : (lsBE || window.BACKEND_URL || ''));
  let authToken = localStorage.getItem('tt_auth_token') || '';
  let currentUserEmail = '';
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
    tabs: $('#tabs'),
    tabIndividual: $('#tab-individual'),
    tabIrene: $('#tab-irene'),
    tabAnalytics: $('#tab-analytics'),
    // Irene elements
    ireneList: $('#irene-list'),
    ireneEmpty: $('#irene-empty'),
    ireneForm: $('#irene-form'),
    ireneId: $('#irene-id'),
    ireneTitle: $('#irene-title'),
    ireneNotes: $('#irene-notes'),
    ireneCategory: $('#irene-category'),
    ireneSearch: $('#irene-search'),
    ireneCreateBtn: $('#btn-irene-create'),
    ireneJoinBtn: $('#btn-irene-join'),
    ireneGroupCode: $('#irene-group-code'),
    // Analytics
    analyticsRange: $('#analytics-range'),
    analyticsCanvas: $('#analytics-canvas'),
  };

  let tasks = loadTasks();
  let ireneTasks = [];
  let ireneTodayCounts = {};
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


    // Tabs click handlers
    if (elements.tabIndividual) elements.tabIndividual.addEventListener('click', () => { location.hash = '#/tasks'; route(); });
    if (elements.tabIrene) elements.tabIrene.addEventListener('click', () => { location.hash = '#/irene'; route(); });
    if (elements.tabAnalytics) elements.tabAnalytics.addEventListener('click', () => { location.hash = '#/analytics'; route(); });

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
          const emailVal = (emailEl.value || '').trim();
          await API.login(emailVal, passEl.value);
          currentUserEmail = emailVal;
          // Persist timezone for backend scheduler (benefits users without push subscription)
          try { await API.setTimezone(-new Date().getTimezoneOffset()); } catch {}
          await syncFromBackend();
          updateAuthUi(true);
          await loadIrene();
          if (Notification.permission === 'granted') { try { await ensurePushSubscribed(); await maybeTestPush('login'); } catch {} }
          location.hash = '#/tasks';
          route();
        } catch (e) { alert(e.message || 'Login failed'); }
      });
      btnRegister.addEventListener('click', async () => {
        try {
          const stay = !!(stayEl && stayEl.checked);
          localStorage.setItem(STAY_KEY, stay ? 'true' : 'false');
          const emailVal = (emailEl.value || '').trim();
          await API.register(emailVal, passEl.value);
          currentUserEmail = emailVal;
          // Persist timezone for backend scheduler (benefits users without push subscription)
          try { await API.setTimezone(-new Date().getTimezoneOffset()); } catch {}
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
        currentUserEmail = '';
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

    // Analytics range change
    if (elements.analyticsRange) elements.analyticsRange.addEventListener('change', renderAnalytics);

    // Irene: Join group button
    if (elements.ireneJoinBtn) elements.ireneJoinBtn.addEventListener('click', async () => {
      if (!(BACKEND_URL && isAuthed)) { alert('Please log in to use groups.'); return; }
      const code = prompt('Enter Irene group code to join (e.g., ABC123):');
      if (!code) return;
      try {
        await API.joinIreneGroup(String(code).trim());
        await loadIrene();
        try { await renderAnalytics(); } catch {}
        alert('Joined group successfully.');
      } catch (e) {
        alert('Failed to join group: ' + (e?.message || e));
      }
    });

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
      // If the app is not installed (not in standalone), proactively remove any existing push
      // subscription so notifications don't appear under Chrome. Users will be prompted to install.
      try {
        if (!isStandalone()) { await unsubscribePush(); }
      } catch {}
    }


    // Backend mode: check session and sync; otherwise local-only
    // Connectivity diagnostics UI removed.

    if (BACKEND_URL) {
      if (authToken) {
        try {
          const me = await API.me();
          isAuthed = !!me;
          currentUserEmail = me && me.email ? String(me.email) : currentUserEmail;
          updateAuthUi(isAuthed);
          if (isAuthed) {
            // Persist timezone for backend scheduler
            try { await API.setTimezone(-new Date().getTimezoneOffset()); } catch {}
            await syncFromBackend();
            await loadIrene();
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

    // Diagnostics UI removed for normal users; overlay via ?diag retained internally.

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
  async function route(){
    const pageLogin = document.getElementById('page-login');
    const pageTasks = document.getElementById('page-tasks');
    const pageForm = document.getElementById('page-task-form');
    const pageIrene = document.getElementById('page-irene');
    const pageAnalytics = document.getElementById('page-analytics');
    const show = (pg) => {
      if (pageLogin) pageLogin.classList.add('hidden');
      if (pageTasks) pageTasks.classList.add('hidden');
      if (pageForm) pageForm.classList.add('hidden');
      if (pageIrene) pageIrene.classList.add('hidden');
      if (pageAnalytics) pageAnalytics.classList.add('hidden');
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
        setActiveTab('individual');
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
          setActiveTab('individual');
          return;
        }
        // if task not found, go back to list
        location.hash = '#/tasks';
        show(pageTasks);
        render();
        setActiveTab('individual');
        return;
      }
      // default tasks list
      show(pageTasks);
      render();
      setActiveTab('individual');
      return;
    }

    if (root === 'irene') {
      show(pageIrene);
      setActiveTab('irene');
      try { await ensureIreneGroup(); } catch {}
      renderIrene();
      return;
    }

    if (root === 'analytics') {
      show(pageAnalytics);
      setActiveTab('analytics');
      try { await ensureIreneGroup(); } catch {}
      renderAnalytics();
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

        // badges: hide all status badges when task is completed today
        const hideBadges = !!(t.lastCompleted && dateToYMD(new Date(t.lastCompleted)) === dateToYMD(new Date()));
        toggleHidden(bPriority, hideBadges || !t.priority);
        toggleHidden(bOverdue, hideBadges || !isOverdue(t));
        toggleHidden(bToday, hideBadges || !(isDueToday(t) && !isOverdue(t)));

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
    // Toggle tabs visibility
    if (elements.tabs) elements.tabs.classList.toggle('hidden', !authed);
  }

  // Missed tasks handling: if due time has passed without completion, move to next day and mark priority
  function handleMissedTasks(){
    // Local-only behavior: Do NOT roll within the same day. Keep task due today (white) and just show Overdue badge.
    // Only when we are on a later day than the stored nextDue, carry the task forward to TODAY and mark priority.
    if (BACKEND_URL && isAuthed) return; // backend handles missed in server mode
    const now = new Date();
    const today = dateToYMD(now);
    let changed = false;
    for (const t of tasks){
      const dueYmd = t.nextDue;
      // If due date is before today (local), carry it forward to today and mark priority
      if (isDueTodayRawDateStr(dueYmd, today)) {
        // Still the same day → do nothing (stay white, may show Overdue if time passed)
        continue;
      }
      // Compare local YMD values safely
      const dueLocal = parseLocalYMD(dueYmd);
      const todayLocal = parseLocalYMD(today);
      if (dueLocal.getTime() < todayLocal.getTime()){
        t.nextDue = today;
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
    const toSync = [];
    for (const t of tasks){
      if (!t.lastCompleted) continue;
      const lcYmd = dateToYMD(new Date(t.lastCompleted));
      if (lcYmd < today) {
        // Only roll once per completion day and only if nextDue has not advanced beyond the completed day
        if (t.rolledFromCompletion !== lcYmd && (!t.nextDue || String(t.nextDue) <= lcYmd)) {
          const newDue = nextScheduledAfterLocal(lcYmd, t.everyDays, t.scheduleDays);
          if (newDue && newDue !== t.nextDue) {
            t.nextDue = newDue;
            t.priority = false;
            t.rolledFromCompletion = lcYmd;
            changed = true;
            if (BACKEND_URL && isAuthed) toSync.push({ ...t });
          } else {
            t.rolledFromCompletion = lcYmd;
          }
        }
      }
    }
    if (changed) {
      saveTasks();
      render();
    }
    if (toSync.length) {
      // Persist updates server-side (best-effort)
      Promise.allSettled(toSync.map(tt => API.updateTask(tt))).then(() => { try { syncFromBackend(); } catch {} });
    }
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
    // Only mobile devices and only the installed app may enable notifications.
    if (!isMobile()) {
      alert('Notifications are only available on the mobile app. Please use your phone to receive reminders.');
      return;
    }
    if (!('Notification' in window)){
      alert('Notifications are not supported in this browser');
      return;
    }
    const inStandalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || (window.navigator && window.navigator.standalone === true);
    if (!inStandalone) {
      alert('Install the app first to enable notifications. Tap “Install App” at the top, then open the app from your Home Screen and enable notifications.');
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
  // Compute the next scheduled date AFTER a given base local YMD, honoring custom weekdays if provided
  function nextScheduledAfterLocal(baseYmd, everyDays, scheduleDays){
    try {
      if (Array.isArray(scheduleDays) && scheduleDays.length > 0){
        for (let i = 1; i <= 7; i++){
          const cand = addDays(baseYmd, i);
          const wd = parseLocalYMD(cand).getDay(); // 0=Sun..6=Sat in local time
          if (scheduleDays.includes(wd)) return cand;
        }
      }
    } catch {}
    // Fallback: simple every N days
    const n = Number.isFinite(everyDays) ? everyDays : parseInt(String(everyDays||'1'),10) || 1;
    return addDays(baseYmd, n);
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
  function isStandalone(){
    try {
      return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || (window.navigator && window.navigator.standalone === true);
    } catch { return false; }
  }

  // Push helpers
  async function maybeTestPush(reason){
    try {
      if (!BACKEND_URL || !isAuthed) return;
      if (!isMobile()) return; // Do not send test push for desktop
      // Require installed PWA to ensure OS-level app notifications (not generic Chrome)
      if (!isStandalone()) {
        const msg = 'Install the app first to receive notifications from the app, not Chrome.\nTap “Install App” at the top, then open the app from your Home Screen and retry.';
        try { const out = document.getElementById('diag-output'); if (out) { const ts = new Date().toLocaleTimeString(); out.textContent = `[${ts}] ${msg}\n` + out.textContent; } } catch {}
        alert(msg);
        return;
      }
      // Throttle tests to avoid spamming: max once per 6 hours unless explicitly from permission grant
      const now = Date.now();
      const last = parseInt(localStorage.getItem(LAST_PUSH_TEST_KEY) || '0', 10) || 0;
      // For manual tests from Diagnostics, do not throttle; throttle only automatic/background tests.
      if (reason !== 'permission-granted' && reason !== 'manual' && now - last < 6 * 60 * 60 * 1000) return;
      const resp = await API.testPush(currentUserEmail || undefined);
      localStorage.setItem(LAST_PUSH_TEST_KEY, String(now));
      // Give user clear feedback
      alert('A test notification has been sent to your device. If you do not see it within a minute, ensure notifications are allowed for your installed app.');
      return resp;
    } catch (e) {
      // If push not configured (503) or other error, inform user gently
      const msg = (e && e.message) ? String(e.message) : 'Push test failed';
      alert('Could not send a test notification: ' + msg);
    }
  }

  async function ensurePushSubscribed(){
    // Ensure environment supports required APIs
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    // Only allow subscriptions from the installed PWA so notifications originate from the app, not Chrome
    try { if (!isStandalone()) return; } catch { return; }
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
      async setTimezone(tzOffsetMinutes){
        if (!baseUrl) return { ok: false };
        const payload = { tzOffsetMinutes };
        const res = await fetch(baseUrl + '/api/user/timezone', { method: 'POST', ...common, headers: buildHeaders(), body: JSON.stringify(payload) });
        // ignore errors silently
        try { await handle(res); } catch {}
        return { ok: res.ok };
      },
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
        // Ensure we send a plain serializable object. Some browsers require toJSON() to expose keys.
        const plain = (sub && typeof sub.toJSON === 'function') ? sub.toJSON() : sub;
        const payload = Object.assign({}, plain, { tzOffsetMinutes });
        return handle(await fetch(baseUrl + '/api/push/subscribe', { method: 'POST', ...common, headers: buildHeaders(), body: JSON.stringify(payload) }));
      },
      async unsubscribePush(sub){ return handle(await fetch(baseUrl + '/api/push/subscribe', { method: 'DELETE', ...common, headers: buildHeaders(), body: JSON.stringify({ endpoint: sub.endpoint }) })); },
      async testPush(email){
        const hasBody = !!(email && String(email).includes('@'));
        const init = { method: 'POST', ...common, headers: buildHeaders() };
        if (hasBody) { init.body = JSON.stringify({ email: String(email) }); }
        return handle(await fetch(baseUrl + '/api/push/test', init));
      },
      // Irene endpoints
      async getIreneTasks(){ const j = await handle(await fetch(baseUrl + '/api/irene/tasks', { ...common, headers: buildHeaders() })); return j.tasks || []; },
      async createIreneTask(t){ return handle(await fetch(baseUrl + '/api/irene/tasks', { method: 'POST', ...common, headers: buildHeaders(), body: JSON.stringify(t) })); },
      async updateIreneTask(t){ return handle(await fetch(baseUrl + '/api/irene/tasks/' + encodeURIComponent(t.id), { method: 'PUT', ...common, headers: buildHeaders(), body: JSON.stringify(t) })); },
      async deleteIreneTask(id){ return handle(await fetch(baseUrl + '/api/irene/tasks/' + encodeURIComponent(id), { method: 'DELETE', ...common, headers: buildHeaders() })); },
      async logIrene(taskId){ return handle(await fetch(baseUrl + '/api/irene/log', { method: 'POST', ...common, headers: buildHeaders(), body: JSON.stringify({ taskId }) })); },
      async getIreneAnalytics(days){ const j = await handle(await fetch(baseUrl + '/api/irene/analytics?range=day&days=' + encodeURIComponent(days), { ...common, headers: buildHeaders() })); return j; },
      // Irene groups
      async getIreneGroup(){ return handle(await fetch(baseUrl + '/api/irene/group', { ...common, headers: buildHeaders() })); },
      async joinIreneGroup(code){ return handle(await fetch(baseUrl + '/api/irene/group/join', { method: 'POST', ...common, headers: buildHeaders(), body: JSON.stringify({ code }) })); },
    };
  }

  function setActiveTab(name){
    if (!elements.tabs) return;
    const map = { individual: elements.tabIndividual, irene: elements.tabIrene, analytics: elements.tabAnalytics, diagnostics: elements.tabDiagnostics };
    for (const key of Object.keys(map)){
      const btn = map[key]; if (!btn) continue;
      if (key === name) btn.classList.add('active'); else btn.classList.remove('active');
    }
  }

  // Irene group helpers
  async function ensureIreneGroup(){
    if (!(BACKEND_URL && isAuthed)) return null;
    try {
      const g = await API.getIreneGroup();
      const code = (g && (g.code || g.group_id)) ? String(g.code || g.group_id).toUpperCase() : '';
      if (elements.ireneGroupCode) {
        elements.ireneGroupCode.textContent = code ? `Group: ${code}` : '';
      }
      return g;
    } catch (e) {
      if (elements.ireneGroupCode) elements.ireneGroupCode.textContent = '';
      return null;
    }
  }

  // Irene: load tasks from backend
  async function loadIrene(){
    if (!(BACKEND_URL && isAuthed)) { ireneTasks = []; ireneTodayCounts = {}; if (elements.ireneGroupCode) elements.ireneGroupCode.textContent=''; renderIrene(); return; }
    try {
      await ensureIreneGroup();
      const list = await API.getIreneTasks();
      ireneTasks = Array.isArray(list) ? list : [];
      // fetch today's counts for display next to tasks
      try {
        const a = await API.getIreneAnalytics(1);
        ireneTodayCounts = (a && a.todayCountsByTask) ? a.todayCountsByTask : {};
      } catch { ireneTodayCounts = {}; }
      renderIrene();
    } catch (e) { console.warn('Irene load failed', e); }
  }

  // Irene: show create form
  function showIreneForm(edit){
    if (!elements.ireneForm) return;
    elements.ireneForm.classList.remove('hidden');
    ensureCategoryState();
    populateIreneCategorySelect();
    if (!edit){
      elements.ireneId.value = '';
      elements.ireneTitle.value = '';
      elements.ireneNotes.value = '';
      elements.ireneCategory.value = settings.categories[0] || 'Default';
    }
  }
  function hideIreneForm(){ if (elements.ireneForm) elements.ireneForm.classList.add('hidden'); }
  function populateIreneCategorySelect(){
    if (!elements.ireneCategory) return;
    elements.ireneCategory.innerHTML='';
    const cats = Array.from(new Set([...(settings.categories||['Default']), ...ireneTasks.map(t => t.category||'Default')]));
    for (const name of cats){ const opt = document.createElement('option'); opt.value = name; opt.textContent = name; elements.ireneCategory.appendChild(opt); }
  }

  function renderIrene(){
    if (!elements.ireneList) return;
    const q = (elements.ireneSearch?.value || '').trim().toLowerCase();
    const list = ireneTasks.filter(t => !q || t.title.toLowerCase().includes(q) || (t.notes||'').toLowerCase().includes(q));
    elements.ireneList.innerHTML='';
    elements.ireneEmpty.style.display = list.length ? 'none' : 'block';

    // Build category list similar to Individual tab
    const uniqueCats = Array.from(new Set(list.map(t => t.category || 'Default')));
    const catOrder = Array.from(new Set([...(settings.categories||['Default']), ...uniqueCats]));

    for (const cat of catOrder){
      const tasksInCat = list.filter(t => (t.category || 'Default') === cat);
      if (tasksInCat.length === 0) continue;
      const det = document.createElement('details'); det.className='category-section';
      det.open = !!(settings.categoryOpen && settings.categoryOpen[cat]);
      const sum = document.createElement('summary');
      const left = document.createElement('div'); left.style.display='inline-flex'; left.style.alignItems='center'; left.style.gap='8px';
      const title = document.createElement('span'); title.className='chip'; title.textContent = cat;
      left.appendChild(title);
      const right = document.createElement('div'); right.className='cat-actions';
      // Rename icon
      const btnEdit = document.createElement('button'); btnEdit.className='btn icon edit'; btnEdit.title='Rename Category'; btnEdit.textContent='✏️';
      btnEdit.addEventListener('click', async (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        const to = prompt(`Rename category "${cat}" to:`, cat);
        if (!to || to === cat) return;
        // Update local categories list (shared with Individual)
        if (Array.isArray(settings.categories)){
          const idx = settings.categories.indexOf(cat);
          if (idx >= 0) settings.categories[idx] = to; else settings.categories.push(to);
        }
        // Update all Irene tasks in this category on backend
        try {
          await Promise.all(tasksInCat.map(t => API.updateIreneTask({ id: t.id, title: t.title, notes: t.notes || '', category: to })));
          saveSettings();
          await loadIrene();
        } catch (e) { alert('Failed to rename category'); }
      });
      // Delete icon
      const btnDelCat = document.createElement('button'); btnDelCat.className='btn icon delete'; btnDelCat.title='Delete Category'; btnDelCat.textContent='🗑️';
      btnDelCat.addEventListener('click', (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        if (cat === 'Default') { alert('Default category cannot be deleted'); return; }
        if (tasksInCat.length > 0) { alert('Category has tasks. Move or edit tasks before deleting.'); return; }
        // Remove from local categories
        settings.categories = (settings.categories||[]).filter(n => n !== cat);
        saveSettings();
        renderIrene();
      });
      right.appendChild(btnEdit); right.appendChild(btnDelCat);
      sum.appendChild(left); sum.appendChild(right);
      sum.addEventListener('click', () => { setCategoryOpen(cat, !det.open); });
      det.appendChild(sum);

      // List tasks within this category
      const ul = document.createElement('ul'); ul.className='task-list';
      for (const t of tasksInCat){
        const li = document.createElement('li'); li.className='task-item';
        const plus = document.createElement('button'); plus.className='btn icon plus'; plus.title='Log completion'; plus.setAttribute('aria-label','Log completion'); plus.textContent = '+';
        plus.addEventListener('click', async () => {
          try { await API.logIrene(t.id); plus.classList.add('pulse'); setTimeout(()=>plus.classList.remove('pulse'), 400); try { await loadIrene(); } catch {} } catch (e) { alert('Failed to log'); }
        });
        const main = document.createElement('div'); main.className='task-main';
        const row1 = document.createElement('div'); row1.className='row1';
        const title = document.createElement('span'); title.className='title'; title.textContent=t.title;
        // Count chip for today
        const cnt = Number(ireneTodayCounts[t.id] || 0);
        if (cnt > 0) {
          const chip = document.createElement('span'); chip.className='chip'; chip.textContent = `x${cnt} today`;
          chip.style.marginLeft = '8px';
          row1.appendChild(chip);
        }
        row1.appendChild(title);
        const row2 = document.createElement('div'); row2.className='row2';
        const notes = document.createElement('span'); notes.className='notes'; notes.textContent=t.notes||'';
        row2.appendChild(notes);
        const row3 = document.createElement('div'); row3.className='row3 meta'; row3.textContent = t.category ? `Category: ${t.category}` : '';
        main.appendChild(row1); main.appendChild(row2); main.appendChild(row3);
        const actions = document.createElement('div'); actions.className='item-actions';
        const btnDel = document.createElement('button'); btnDel.className='btn icon delete'; btnDel.title='Delete'; btnDel.textContent='🗑️';
        btnDel.addEventListener('click', async ()=>{ if (!confirm('Delete this task?')) return; try { await API.deleteIreneTask(t.id); await loadIrene(); } catch (e) { alert('Delete failed'); } });
        actions.appendChild(btnDel);
        li.appendChild(plus); li.appendChild(main); li.appendChild(actions);
        ul.appendChild(li);
      }
      det.appendChild(ul);
      elements.ireneList.appendChild(det);
    }
  }

  async function renderAnalytics(){
    try {
      const days = parseInt(elements.analyticsRange?.value || '7', 10);
      const data = (BACKEND_URL && isAuthed) ? await API.getIreneAnalytics(days) : { buckets: [], series: [], users: [], byUser: {}, perUserPerTask: {}, taskTitles: {} };
      const buckets = data.buckets || [];
      const series = data.series || [];
      const users = Array.isArray(data.users) ? data.users : [];
      const byUser = data.byUser || {};
      const perUserPerTask = data.perUserPerTask || {};
      const taskTitles = data.taskTitles || {};
      const emptyEl = document.getElementById('analytics-empty');
      if (!buckets.length || !series.length){ if (emptyEl) emptyEl.style.display='block'; } else { if (emptyEl) emptyEl.style.display='none'; }

      // Populate email selector
      const emailSel = document.getElementById('analytics-email');
      if (emailSel){
        const prev = emailSel.value;
        emailSel.innerHTML='';
        const optAll = document.createElement('option'); optAll.value = ''; optAll.textContent = 'All'; emailSel.appendChild(optAll);
        for (const u of users){ const o = document.createElement('option'); o.value = u; o.textContent = u; emailSel.appendChild(o); }
        if (prev) emailSel.value = prev;
        emailSel.onchange = () => renderAnalytics();
      }

      // Stacked bar chart (existing)
      const canvas = elements.analyticsCanvas; if (canvas){
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0,0,canvas.width,canvas.height);
        if (buckets.length && series.length){
          const W = canvas.width, H = canvas.height; const padding = 40; const chartW = W - padding*2; const chartH = H - padding*2;
          const totals = buckets.map((_,i)=> series.reduce((s,ser)=> s + (ser.data[i]||0), 0));
          const maxV = Math.max(1, ...totals);
          const barW = chartW / buckets.length * 0.7; const gap = chartW / buckets.length * 0.3;
          const colors = series.map((_,i)=> `hsl(${(i*67)%360} 70% 60%)`);
          ctx.font='12px sans-serif'; ctx.textAlign='center';
          for (let i=0;i<buckets.length;i++){
            let x = padding + i*(barW+gap) + gap*0.5;
            let y = padding + chartH;
            let acc = 0;
            for (let s=0;s<series.length;s++){
              const val = series[s].data[i]||0;
              const h = Math.round((val/maxV)*chartH);
              ctx.fillStyle = colors[s];
              ctx.fillRect(x, y - acc - h, barW, h);
              acc += h;
            }
            ctx.fillStyle='#aab'; ctx.fillText(String(buckets[i]).slice(5), x+barW/2, H-10);
          }
          ctx.strokeStyle='#556'; ctx.beginPath(); ctx.moveTo(padding, padding); ctx.lineTo(padding, H-padding); ctx.stroke();
        }
      }

      // Pie: selected email task breakdown
      const selEmail = (document.getElementById('analytics-email')||{}).value || '';
      const pieEmail = document.getElementById('analytics-pie-email');
      if (pieEmail){
        const ctx = pieEmail.getContext('2d'); ctx.clearRect(0,0,pieEmail.width,pieEmail.height);
        const map = selEmail ? (perUserPerTask[selEmail] || {}) : Object.entries(perUserPerTask).reduce((acc,[email,obj])=>{ for (const [tid,c] of Object.entries(obj)){ acc[tid]=(acc[tid]||0)+c; } return acc; }, {});
        const entries = Object.entries(map);
        const total = entries.reduce((s, [,c])=>s+(c||0), 0);
        let start = -Math.PI/2; let i=0;
        for (const [tid, c] of entries){
          const frac = total>0 ? (c/total) : 0;
          const end = start + frac * Math.PI*2;
          ctx.beginPath(); ctx.moveTo(pieEmail.width/2, pieEmail.height/2);
          ctx.arc(pieEmail.width/2, pieEmail.height/2, Math.min(pieEmail.width,pieEmail.height)/2 - 10, start, end);
          ctx.closePath(); ctx.fillStyle = `hsl(${(i*67)%360} 70% 60%)`; ctx.fill();
          // label
          ctx.fillStyle = '#ddd'; ctx.font='12px sans-serif';
          const mid = (start+end)/2; const rx = pieEmail.width/2 + Math.cos(mid)* (Math.min(pieEmail.width,pieEmail.height)/3);
          const ry = pieEmail.height/2 + Math.sin(mid)* (Math.min(pieEmail.width,pieEmail.height)/3);
          ctx.fillText((taskTitles[tid]||tid)+` (${c})`, rx, ry);
          start = end; i++;
        }
      }

      // Pie: totals by user
      const pieUsers = document.getElementById('analytics-pie-users');
      if (pieUsers){
        const ctx = pieUsers.getContext('2d'); ctx.clearRect(0,0,pieUsers.width,pieUsers.height);
        const entries = Object.entries(byUser);
        const total = entries.reduce((s, [,c])=>s+(c||0), 0);
        let start = -Math.PI/2; let i=0;
        for (const [email, c] of entries){
          const frac = total>0 ? (c/total) : 0;
          const end = start + frac * Math.PI*2;
          ctx.beginPath(); ctx.moveTo(pieUsers.width/2, pieUsers.height/2);
          ctx.arc(pieUsers.width/2, pieUsers.height/2, Math.min(pieUsers.width,pieUsers.height)/2 - 10, start, end);
          ctx.closePath(); ctx.fillStyle = `hsl(${(i*67)%360} 70% 60%)`; ctx.fill();
          ctx.fillStyle = '#ddd'; ctx.font='12px sans-serif';
          const mid = (start+end)/2; const rx = pieUsers.width/2 + Math.cos(mid)* (Math.min(pieUsers.width,pieUsers.height)/3);
          const ry = pieUsers.height/2 + Math.sin(mid)* (Math.min(pieUsers.width,pieUsers.height)/3);
          ctx.fillText(`${email} (${c})`, rx, ry);
          start = end; i++;
        }
      }
    } catch (e) {
      console.warn('analytics render failed', e);
    }
  }

  // Irene form events
  if (elements.ireneCreateBtn) elements.ireneCreateBtn.addEventListener('click', () => showIreneForm(false));
  if (elements.ireneForm) elements.ireneForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const t = { id: elements.ireneId.value || undefined, title: elements.ireneTitle.value.trim(), notes: elements.ireneNotes.value.trim(), category: elements.ireneCategory.value };
      if (!t.title) return;
      await API.createIreneTask(t);
      hideIreneForm();
      await loadIrene();
    } catch (e) { alert('Save failed'); }
  });
  if (elements.ireneSearch) elements.ireneSearch.addEventListener('input', renderIrene);
  const btnIreneCancel = document.getElementById('btn-irene-cancel');
  if (btnIreneCancel) btnIreneCancel.addEventListener('click', hideIreneForm);
  const btnIreneAddCat = document.getElementById('btn-irene-add-category');
  if (btnIreneAddCat) btnIreneAddCat.addEventListener('click', () => {
    const name = prompt('New category name:');
    if (!name) return;
    if (!Array.isArray(settings.categories)) settings.categories = ['Default'];
    if (!settings.categories.includes(name)) settings.categories.push(name);
    saveSettings();
    populateIreneCategorySelect();
    renderIrene();
  });

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

  // Expose minimal internals for diagnostics (read-only access)
  try {
    window.__TTT = Object.assign({}, window.__TTT || {}, {
      BACKEND_URL,
      getAuth: () => ({ isAuthed, authToken, currentUserEmail }),
      maybeTestPush,
      ensurePushSubscribed,
      unsubscribePush,
      isStandalone,
      isMobile,
    });
  } catch {}

})();


  // Hidden diagnostics UI for push troubleshooting
  function setupDiagnosticsUi(){
    try {
      const T = (window.__TTT || {});
      const BACKEND_URL = (T.BACKEND_URL || (window.RUNTIME_CONFIG && window.RUNTIME_CONFIG.BACKEND_URL) || window.BACKEND_URL || '');
      const auth = T.getAuth ? T.getAuth() : {};
      const isAuthed = !!auth.isAuthed;
      const authToken = auth.authToken || '';
      const currentUserEmail = auth.currentUserEmail || '';
      const isStandalone = T.isStandalone ? T.isStandalone : function(){ try { return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || (window.navigator && window.navigator.standalone===true); } catch { return false; } };
      const isMobile = T.isMobile ? T.isMobile : function(){ return (typeof window.orientation !== 'undefined') || (navigator.userAgent||'').includes('Mobi') || window.innerWidth < 640; };
      const maybeTestPush = T.maybeTestPush || (async ()=>{ throw new Error('Push test not available'); });
      const ensurePushSubscribed = T.ensurePushSubscribed || (async ()=>{});
      const unsubscribePush = T.unsubscribePush || (async ()=>{});
      const diagPage = document.getElementById('page-diagnostics');
      const out = document.getElementById('diag-output');
      function logDiag(msg){ if (out) { const ts = new Date().toLocaleTimeString(); out.textContent = `[${ts}] ${msg}\n` + out.textContent; } }
      if (diagPage) {
        // Populate basic fields
        const vapid = localStorage.getItem('tt_vapid_pub') || '';
        const vapidSuffix = vapid ? vapid.slice(-12) : '(none)';
        const perm = (typeof Notification !== 'undefined') ? Notification.permission : 'unsupported';
        const permEl = document.getElementById('diag-perm'); if (permEl) permEl.textContent = perm;
        const vapEl = document.getElementById('diag-vapid'); if (vapEl) vapEl.textContent = vapidSuffix;
        const beEl = document.getElementById('diag-backend'); if (beEl) beEl.textContent = (BACKEND_URL ? BACKEND_URL : '(unset)');
        (async () => {
          try {
            const brave = (navigator.brave && typeof navigator.brave.isBrave === 'function') ? await navigator.brave.isBrave() : false;
            const brEl = document.getElementById('diag-brave'); if (brEl) brEl.textContent = brave ? 'on' : 'off';
          } catch { const brEl = document.getElementById('diag-brave'); if (brEl) brEl.textContent = 'unknown'; }
        })();
        (async () => {
          try {
            if ('serviceWorker' in navigator) {
              const reg = await navigator.serviceWorker.getRegistration();
              const st = reg ? (reg.active ? 'active' : (reg.installing ? 'installing' : 'registered')) : 'none';
              const swEl = document.getElementById('diag-sw'); if (swEl) swEl.textContent = st;
            } else {
              const swEl = document.getElementById('diag-sw'); if (swEl) swEl.textContent = 'unsupported';
            }
          } catch { const swEl = document.getElementById('diag-sw'); if (swEl) swEl.textContent = 'error'; }
        })();
        // Hint if app is not installed
        try { if (!isStandalone()) { logDiag('App is not installed (standalone=false). Install the app to receive OS-level notifications from the app instead of Chrome.'); } } catch {}
        // Wire buttons (idempotent: remove existing listeners by cloning)
        const ids = ['btn-diag-test','btn-diag-test-detailed','btn-diag-local-notif','btn-diag-resub','btn-diag-purge','btn-diag-subs','btn-diag-diagnose','btn-diag-ping','btn-diag-swupdate'];
        for (const id of ids){ const old = document.getElementById(id); if (old){ const newBtn = old.cloneNode(true); old.parentNode.replaceChild(newBtn, old); } }
        const btnTest = document.getElementById('btn-diag-test');
        const btnDet = document.getElementById('btn-diag-test-detailed');
        const btnResub = document.getElementById('btn-diag-resub');
        const btnPurge = document.getElementById('btn-diag-purge');
        const btnSubs = document.getElementById('btn-diag-subs');
        const btnDiag = document.getElementById('btn-diag-diagnose');
        const btnPing = document.getElementById('btn-diag-ping');
        const btnSwUpd = document.getElementById('btn-diag-swupdate');
        const btnLocal = document.getElementById('btn-diag-local-notif');
        if (btnTest) btnTest.addEventListener('click', async () => {
          try {
            await ensurePushSubscribed();
            await maybeTestPush('manual');
            logDiag('Test push requested. If you do not receive it within 60s, verify permission and subscription.');
          }
          catch (e) { logDiag('Test push failed to start: ' + (e?.message||e)); alert('Test failed'); }
        });
        if (btnDet) btnDet.addEventListener('click', async () => {
          try {
            if (!BACKEND_URL || !isAuthed) { alert('Login first'); logDiag('Cannot run Detailed Test: not logged in or backend unset.'); return; }
            const res = await fetch((BACKEND_URL||'').replace(/\/$/,'') + '/api/push/test-detailed', { method: 'POST', credentials: 'include', headers: { 'Authorization': authToken ? ('Bearer ' + authToken) : '', 'Content-Type':'application/json', ...(currentUserEmail? { 'X-User-Email': currentUserEmail } : {}) }, body: JSON.stringify(currentUserEmail? { email: currentUserEmail } : {}) });
            const txt = await res.text();
            logDiag('Detailed Test HTTP ' + res.status + ': ' + txt);
            try { const j = JSON.parse(txt); alert('Detailed test results: ' + JSON.stringify(j, null, 2)); } catch { /* non-json response */ }
          } catch (e) { logDiag('Detailed test failed: ' + (e?.message||e)); alert('Detailed test failed'); }
        });
        if (btnLocal) btnLocal.addEventListener('click', async () => {
          try {
            if (!('serviceWorker' in navigator)) { logDiag('Local notification: service worker unsupported.'); alert('Service worker not supported'); return; }
            const inStandalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || (window.navigator && window.navigator.standalone === true);
            if (!inStandalone) { logDiag('Local notification: app is not installed (standalone=false). Install the app first.'); alert('Install the app first, then open it from your Home Screen.'); return; }
            if (typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
              try {
                const p = await Notification.requestPermission();
                if (p !== 'granted') { logDiag('Local notification: permission not granted.'); alert('Please allow notifications in the app settings.'); return; }
              } catch {}
            }
            const reg = await navigator.serviceWorker.ready;
            const opts = { body: 'This is a local app notification (no backend).', icon: '/icons/logo.svg', badge: '/icons/logo.svg', requireInteraction: true, data: { type: 'local-test' } };
            await reg.showNotification('TickTock Tasks: Local Test', opts);
            logDiag('Local notification displayed via ServiceWorkerRegistration.showNotification.');
          } catch (e) {
            logDiag('Local notification failed: ' + (e?.message||e));
            alert('Local notification failed');
          }
        });
        if (btnResub) btnResub.addEventListener('click', async () => {
          try {
            await unsubscribePush();
            await ensurePushSubscribed();
            logDiag('Re-subscribed (if supported). Triggering a test…');
            try { await maybeTestPush('manual'); } catch {}
          } catch (e) { logDiag('Re-subscribe failed: ' + (e?.message||e)); alert('Re-subscribe failed'); }
        });
        if (btnPurge) btnPurge.addEventListener('click', async () => {
          try {
            if (!BACKEND_URL || !isAuthed) { alert('Login first'); logDiag('Cannot purge: not logged in or backend unset.'); return; }
            const res = await fetch((BACKEND_URL||'').replace(/\/$/,'') + '/api/push/subscriptions/all', { method: 'DELETE', credentials: 'include', headers: { 'Authorization': authToken ? ('Bearer ' + authToken) : '', ...(currentUserEmail? { 'X-User-Email': currentUserEmail } : {}) } });
            logDiag('Purged server subs: HTTP ' + res.status);
            await unsubscribePush();
            await ensurePushSubscribed();
            logDiag('Re-subscribed after purge. Sending test…');
            try { await maybeTestPush('manual'); } catch {}
          } catch (e) { logDiag('Purge/resubscribe failed: ' + (e?.message||e)); alert('Purge/resubscribe failed'); }
        });
        if (btnSubs) btnSubs.addEventListener('click', async () => {
          try {
            if (!BACKEND_URL || !isAuthed) { alert('Login first'); logDiag('Cannot list subs: not logged in or backend unset.'); return; }
            const res = await fetch((BACKEND_URL||'').replace(/\/$/,'') + '/api/push/subscriptions', { credentials: 'include', headers: { 'Authorization': authToken ? ('Bearer ' + authToken) : '', ...(currentUserEmail? { 'X-User-Email': currentUserEmail } : {}) } });
            const txt = await res.text();
            logDiag('Subscriptions HTTP ' + res.status + ': ' + txt);
            try { const j = JSON.parse(txt); alert('Subscriptions: ' + JSON.stringify(j, null, 2)); } catch {}
          } catch (e) { logDiag('Failed to load subscriptions: ' + (e?.message||e)); alert('Failed to load subscriptions'); }
        });
        if (btnDiag) btnDiag.addEventListener('click', async () => {
          try {
            if (!BACKEND_URL || !isAuthed) { alert('Login first'); logDiag('Cannot diagnose: not logged in or backend unset.'); return; }
            const res = await fetch((BACKEND_URL||'').replace(/\/$/,'') + '/api/push/diagnose', { credentials: 'include', headers: { 'Authorization': authToken ? ('Bearer ' + authToken) : '', ...(currentUserEmail? { 'X-User-Email': currentUserEmail } : {}) } });
            const txt = await res.text();
            logDiag('Diagnose HTTP ' + res.status + ': ' + txt);
            try { const j = JSON.parse(txt); alert('Diagnose: ' + JSON.stringify(j, null, 2)); } catch {}
          } catch (e) { logDiag('Failed to diagnose: ' + (e?.message||e)); alert('Failed to diagnose'); }
        });
        if (btnPing) btnPing.addEventListener('click', async () => {
          try {
            if (!BACKEND_URL) { logDiag('Backend URL is unset. Set it via config.js or localStorage key tt_backend_url then reload.'); alert('Backend URL is unset'); return; }
            const url = (BACKEND_URL||'').replace(/\/$/,'') + '/api/ping';
            const res = await fetch(url, { credentials: 'include' });
            const txt = await res.text();
            logDiag('Ping ' + url + ' → HTTP ' + res.status + ': ' + txt);
          } catch (e) { logDiag('Ping failed: ' + (e?.message||e)); }
        });
        if (btnSwUpd) btnSwUpd.addEventListener('click', async () => {
          try {
            if ('serviceWorker' in navigator) {
              const reg = await navigator.serviceWorker.getRegistration();
              if (reg) { try { await reg.update(); } catch {}
                if (reg.waiting) { reg.waiting.postMessage({ type: 'SKIP_WAITING' }); }
              }
              logDiag('Requested service worker update. Reloading…');
              location.reload(true);
            }
          } catch (e) { logDiag('SW update failed: ' + (e?.message||e)); }
        });
        // Guidance if backend unset
        if (!BACKEND_URL) {
          logDiag('Backend URL is currently unset. In production this is written by config.js. For local dev, set it with: localStorage.setItem(\'tt_backend_url\',\'https://localhost:8443\'); then reload.');
        }
        return;
      }

      // Legacy overlay: only when explicitly requested and on mobile
      const url = new URL(location.href);
      if (url.searchParams.get('diag') !== '1') return;
      if (!isMobile()) return;
      const container = document.querySelector('.container');
      if (!container) return;
      const panel = document.createElement('div');
      panel.className = 'panel';
      panel.id = 'ttt-diag-panel';
      const vapid = localStorage.getItem('tt_vapid_pub') || '';
      const vapidSuffix = vapid ? vapid.slice(-12) : '(none)';
      const perm = (typeof Notification !== 'undefined') ? Notification.permission : 'unsupported';
      panel.innerHTML = `
        <h2>Diagnostics</h2>
        <p style="color:#aab">Mobile only • ?diag=1 enabled</p>
        <div class="grid">
          <div><span>Notif permission</span><div id="diag-perm">${perm}</div></div>
          <div><span>Stored VAPID (suffix)</span><div id="diag-vapid">${vapidSuffix}</div></div>
          <div><span>Service Worker</span><div id="diag-sw">checking…</div></div>
        </div>
        <div class="form-actions" style="margin-top:10px">
          <button class="btn" id="btn-diag-test">Send Test Push</button>
          <button class="btn" id="btn-diag-test-detailed">Detailed Test</button>
          <button class="btn" id="btn-diag-resub">Re-subscribe Push</button>
          <button class="btn" id="btn-diag-purge">Purge Subs + Re-subscribe</button>
          <button class="btn" id="btn-diag-subs">Show Subscriptions</button>
          <button class="btn" id="btn-diag-diagnose">Diagnose Today</button>
        </div>
      `;
      container.prepend(panel);

      (async () => {
        try {
          if ('serviceWorker' in navigator) {
            const reg = await navigator.serviceWorker.getRegistration();
            const st = reg ? (reg.active ? 'active' : (reg.installing ? 'installing' : 'registered')) : 'none';
            document.getElementById('diag-sw').textContent = st;
          } else {
            document.getElementById('diag-sw').textContent = 'unsupported';
          }
        } catch { document.getElementById('diag-sw').textContent = 'error'; }
      })();

      const btnTest = document.getElementById('btn-diag-test');
      const btnDet = document.getElementById('btn-diag-test-detailed');
      const btnResub = document.getElementById('btn-diag-resub');
      const btnPurge = document.getElementById('btn-diag-purge');
      const btnSubs = document.getElementById('btn-diag-subs');
      const btnDiag = document.getElementById('btn-diag-diagnose');

      if (btnTest) btnTest.addEventListener('click', async () => { try { await maybeTestPush('manual'); } catch (e) { alert('Test failed'); } });
      if (btnDet) btnDet.addEventListener('click', async () => {
        try {
          if (!BACKEND_URL || !isAuthed) { alert('Login first'); return; }
          const res = await fetch((BACKEND_URL||'').replace(/\/$/,'') + '/api/push/test-detailed', { method: 'POST', credentials: 'include', headers: { 'Authorization': authToken ? ('Bearer ' + authToken) : '', 'Content-Type':'application/json' } });
          const j = await res.json().catch(()=>null);
          alert('Detailed test results: ' + JSON.stringify(j, null, 2));
        } catch { alert('Detailed test failed'); }
      });
      if (btnResub) btnResub.addEventListener('click', async () => {
        try {
          await unsubscribePush();
          await ensurePushSubscribed();
          alert('Re-subscribed (if supported). You should receive a test next.');
          try { await maybeTestPush('manual'); } catch {}
        } catch { alert('Re-subscribe failed'); }
      });
      if (btnPurge) btnPurge.addEventListener('click', async () => {
        try {
          if (!BACKEND_URL || !isAuthed) { alert('Login first'); return; }
          await fetch((BACKEND_URL||'').replace(/\/$/,'') + '/api/push/subscriptions/all', { method: 'DELETE', credentials: 'include', headers: { 'Authorization': authToken ? ('Bearer ' + authToken) : '' } });
          await unsubscribePush();
          await ensurePushSubscribed();
          alert('Purged old subscriptions and re-subscribed. Sending a test…');
          try { await maybeTestPush('manual'); } catch {}
        } catch { alert('Purge/resubscribe failed'); }
      });
      if (btnSubs) btnSubs.addEventListener('click', async () => {
        try {
          if (!BACKEND_URL || !isAuthed) { alert('Login first'); return; }
          const res = await fetch((BACKEND_URL||'').replace(/\/$/,'') + '/api/push/subscriptions', { credentials: 'include', headers: { 'Authorization': authToken ? ('Bearer ' + authToken) : '' } });
          const j = await res.json().catch(()=>null);
          alert('Subscriptions: ' + JSON.stringify(j, null, 2));
        } catch { alert('Failed to load subscriptions'); }
      });
      if (btnDiag) btnDiag.addEventListener('click', async () => {
        try {
          if (!BACKEND_URL || !isAuthed) { alert('Login first'); return; }
          const res = await fetch((BACKEND_URL||'').replace(/\/$/,'') + '/api/push/diagnose', { credentials: 'include', headers: { 'Authorization': authToken ? ('Bearer ' + authToken) : '' } });
          const j = await res.json().catch(()=>null);
          alert('Diagnose: ' + JSON.stringify(j, null, 2));
        } catch { alert('Failed to diagnose'); }
      });
    } catch {}
  }
