(function(){
  const statusEl = document.getElementById('status');
  const btnInstall = document.getElementById('btn-install');
  const btnUpdate = document.getElementById('btn-update');
  let deferredPrompt = null;

  function setStatus(msg) { if (statusEl) statusEl.textContent = msg || ''; }

  // Register the root service worker so scope is "/" even from /app/
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then(() => {
      setStatus('Service worker ready.');
    }).catch(() => {});
  }

  // Capture PWA install prompt
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    btnInstall.disabled = false;
    setStatus('Ready to install.');
  });

  // Installed event
  window.addEventListener('appinstalled', () => {
    setStatus('App installed!');
    deferredPrompt = null;
  });

  // iOS: no beforeinstallprompt
  function isIOS() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent);
  }
  function isInStandaloneMode() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }

  btnInstall.addEventListener('click', async () => {
    // For iOS, show hint
    if (isIOS() && !isInStandaloneMode()) {
      setStatus('On iOS: Tap the Share icon, then "Add to Home Screen" to install.');
      return;
    }

    if (deferredPrompt) {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      setStatus(outcome === 'accepted' ? 'Installing…' : 'Install dismissed.');
      deferredPrompt = null;
    } else {
      // If already installed, offer update
      setStatus('App may already be installed. Checking for updates…');
      tryUpdate();
    }
  });

  btnUpdate.addEventListener('click', () => {
    setStatus('Checking for updates…');
    tryUpdate();
  });

  async function tryUpdate() {
    try {
      if (!('serviceWorker' in navigator)) { setStatus('Service worker not supported.'); return; }
      const reg = await navigator.serviceWorker.getRegistration('/');
      if (reg) {
        await reg.update();
        // If there's an updated worker waiting, trigger skipWaiting via message
        if (reg.waiting) {
          reg.waiting.postMessage({ type: 'SKIP_WAITING' });
        }
        setStatus('Update check complete.');
      } else {
        setStatus('No registration found; refreshing…');
        location.reload();
      }
    } catch (e) {
      setStatus('Update failed.');
    }
  }

  // Listen in SW for skip waiting
  navigator.serviceWorker && navigator.serviceWorker.addEventListener('controllerchange', () => {
    setStatus('Updated to latest version.');
  });

  // Small UX: disable install until prompt captured
  btnInstall.disabled = true;
})();
