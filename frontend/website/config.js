// Runtime configuration for the frontend. This file can be overwritten at deploy time.
// BACKEND_URL: leave empty string to use same-origin (CloudFront routes /api/* to backend) or set to a full URL.
// Production safety: if running on ticktocktasks.com and BACKEND_URL is empty, default to https://api.ticktocktasks.com
// You can override locally by setting localStorage.setItem('tt_backend_url', 'https://your-backend.example.com')
(function(){
  var defaultBackend = '';
  try {
    var host = (typeof location !== 'undefined' && location && location.hostname) ? location.hostname : '';
    if (host === 'ticktocktasks.com' || host === 'www.ticktocktasks.com' || host === 'app.ticktocktasks.com') {
      defaultBackend = 'https://api.ticktocktasks.com';
    }
  } catch (e) {}
  var cfg = window.RUNTIME_CONFIG || {};
  var existing = (cfg && typeof cfg.BACKEND_URL === 'string') ? cfg.BACKEND_URL : '';
  window.RUNTIME_CONFIG = Object.assign({}, cfg, { BACKEND_URL: existing || defaultBackend });
})();
