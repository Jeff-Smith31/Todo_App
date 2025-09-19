(function(){
  const statusEl = document.getElementById('status');
  const btnInstall = document.getElementById('btn-install');
  const btnUpdate = document.getElementById('btn-update');
  let deferredPrompt = null;

  function setStatus(msg){ if (statusEl) statusEl.textContent = msg || ''; }

  // Register the root service worker so scope is "/" even from /family/
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then(() => {
      setStatus('Service worker ready.');
    }).catch(()=>{});
  }

  // Support early-captured event from install.html <head>
  deferredPrompt = window.__famInstallBip || null;

  // Capture PWA install prompt (in case early capture missed it)
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    window.__famInstallBip = e;
    if (btnInstall) btnInstall.disabled = false;
    setStatus('Ready to install.');
  });

  // Installed event
  window.addEventListener('appinstalled', () => {
    setStatus('TTT Family installed!');
    deferredPrompt = null; window.__famInstallBip = null;
  });

  function isIOS(){ return /iphone|ipad|ipod/i.test(navigator.userAgent || ''); }
  function isInStandaloneMode(){ return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true; }

  // Auto-install intent via query param (?install=1)
  const params = new URLSearchParams(location.search);
  let wantInstall = params.get('install') === '1';
  let hadGesture = false;
  function onGesture(){
    hadGesture = true;
    if (wantInstall && deferredPrompt) { tryInstall(); }
    document.removeEventListener('pointerdown', onGesture);
    document.removeEventListener('click', onGesture, true);
  }
  document.addEventListener('pointerdown', onGesture, { once: true });
  document.addEventListener('click', onGesture, true);

  async function tryInstall(){
    if (isIOS() && !isInStandaloneMode()) {
      setStatus('On iOS: Tap the Share icon, then "Add to Home Screen" to install TTT Family.');
      return;
    }
    if (!deferredPrompt && window.__famInstallBip) { deferredPrompt = window.__famInstallBip; }
    if (deferredPrompt) {
      try { deferredPrompt.prompt(); const { outcome } = await deferredPrompt.userChoice; setStatus(outcome === 'accepted' ? 'Installing…' : 'Install dismissed.'); } catch {}
      deferredPrompt = null; window.__famInstallBip = null; wantInstall = false;
    } else {
      setStatus('If your browser did not offer Install, open the menu and choose "Install app" or "Add to Home screen".');
    }
  }

  if (btnInstall) {
    btnInstall.addEventListener('click', async () => {
      // iOS hint
      if (isIOS() && !isInStandaloneMode()) {
        setStatus('On iOS: Tap the Share icon, then "Add to Home Screen" to install TTT Family.');
        return;
      }
      wantInstall = true;
      await tryInstall();
    });
  }

  if (wantInstall) {
    // best-effort attempt shortly after load
    setTimeout(() => { try { tryInstall(); } catch {} }, 300);
  }

  if (btnUpdate) {
    btnUpdate.addEventListener('click', () => { setStatus('Checking for updates…'); tryUpdate(); });
  }

  async function tryUpdate(){
    try {
      if (!('serviceWorker' in navigator)) { setStatus('Service worker not supported.'); return; }
      const reg = await navigator.serviceWorker.getRegistration('/');
      if (reg) {
        await reg.update();
        if (reg.waiting) { try { reg.waiting.postMessage({ type: 'SKIP_WAITING' }); } catch {} }
        setStatus('Update check complete.');
      } else {
        setStatus('No registration found; refreshing…');
        location.reload();
      }
    } catch { setStatus('Update failed.'); }
  }

  // Reflect controller changes (after SKIP_WAITING)
  if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener('controllerchange', () => setStatus('Updated to latest version.'));
  }

  // Small UX: disable install until prompt captured
  if (btnInstall) btnInstall.disabled = !deferredPrompt;
})();
