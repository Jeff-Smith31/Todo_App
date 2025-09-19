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

  // Capture PWA install prompt
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (btnInstall) btnInstall.disabled = false;
    setStatus('Ready to install.');
  });

  // Installed event
  window.addEventListener('appinstalled', () => {
    setStatus('TTT Family installed!');
    deferredPrompt = null;
  });

  function isIOS(){ return /iphone|ipad|ipod/i.test(navigator.userAgent || ''); }
  function isInStandaloneMode(){ return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true; }

  if (btnInstall) {
    btnInstall.addEventListener('click', async () => {
      // iOS hint
      if (isIOS() && !isInStandaloneMode()) {
        setStatus('On iOS: Tap the Share icon, then "Add to Home Screen" to install TTT Family.');
        return;
      }
      if (deferredPrompt) {
        try {
          deferredPrompt.prompt();
          const { outcome } = await deferredPrompt.userChoice;
          setStatus(outcome === 'accepted' ? 'Installing…' : 'Install dismissed.');
        } catch {}
        deferredPrompt = null;
      } else {
        setStatus('If already installed, you can check for updates.');
        tryUpdate();
      }
    });
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
  if (btnInstall) btnInstall.disabled = true;
})();
