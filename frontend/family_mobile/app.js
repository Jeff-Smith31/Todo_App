(function(){
  'use strict';

  const API_BASE = (window.RUNTIME_CONFIG && window.RUNTIME_CONFIG.BACKEND_URL) ? window.RUNTIME_CONFIG.BACKEND_URL.replace(/\/$/,'') : '';
  let authToken = localStorage.getItem('ttf_auth') || '';
  let user = null;
  let tasks = [];

  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));

  document.addEventListener('DOMContentLoaded', init);

  async function init(){
    bindTabs();
    $('#btn-add-task').addEventListener('click', onAddTask);
    $('#btn-login').addEventListener('click', loginPrompt);
    if ('serviceWorker' in navigator) { try { await navigator.serviceWorker.register('/sw.js'); } catch {} }
    render();
    if (authToken) { await fetchMe(); await loadTasks(); }
    $('#btn-refresh').addEventListener('click', () => refreshAnalytics());

    // Setup Update button behavior and version polling (match main app functionality)
    setupVersionUiAndUpdater();
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
      if (data && data.token) { authToken = data.token; localStorage.setItem('ttf_auth', authToken); user = data.user; $('#btn-login').textContent = 'Logout'; $('#btn-login').onclick = doLogout; await loadTasks(); }
    } catch(e){ alert(e.message || 'Login failed'); }
  }
  async function doLogout(){ authToken=''; localStorage.removeItem('ttf_auth'); user=null; $('#btn-login').textContent='Login'; $('#btn-login').onclick = loginPrompt; tasks=[]; render(); }

  async function fetchMe(){ try { const me = await call('/api/auth/me'); user = me?.user || null; if (user) { $('#btn-login').textContent = 'Logout'; $('#btn-login').onclick = doLogout; } } catch { user = null; } }

  async function loadTasks(){ try { const res = await call('/api/family/tasks'); tasks = res.tasks || []; render(); } catch (e) { console.warn(e); } }
  async function onAddTask(){ const title = ($('#new-task-title').value || '').trim(); if (!title) return; try { await call('/api/family/tasks', { method:'POST', body: JSON.stringify({ title }) }); $('#new-task-title').value=''; await loadTasks(); } catch(e){ alert(e.message||'Failed'); } }

  async function completeTask(id){ try { await call('/api/family/tasks/'+encodeURIComponent(id)+'/complete', { method:'POST' }); await loadTasks(); } catch(e){ alert(e.message||'Failed'); } }

  function render(){ const cont = $('#tasks'); cont.innerHTML=''; if (!tasks.length){ $('#empty').style.display='block'; return; } $('#empty').style.display='none'; for (const t of tasks){ const div = document.createElement('div'); div.className='task'; div.innerHTML = `<div class="plus" title="Log a completion">+</div><div style="flex:1"><div style="font-weight:600">${escapeHtml(t.title)}</div><div style="color:#64748b;font-size:12px">${t.count||0} completions</div></div>`; div.querySelector('.plus').addEventListener('click', () => completeTask(t.id)); cont.appendChild(div); } }

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
