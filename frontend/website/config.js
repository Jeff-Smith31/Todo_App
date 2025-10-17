// Runtime configuration for the frontend. This file can be overwritten at deploy time.
// BACKEND_URL: leave empty string to use same-origin (CloudFront routes /api/* to backend) or set to a full URL.
// Note: Avoid hardcoded domain defaults to ensure same-origin works reliably via CloudFront /api. CI/CD may set this at deploy time.
// You can override locally by setting localStorage.setItem('tt_backend_url', 'https://your-backend.example.com')
(function(){
  var cfg = window.RUNTIME_CONFIG || {};
  var existing = (cfg && typeof cfg.BACKEND_URL === 'string') ? cfg.BACKEND_URL : '';
  // Keep empty by default so same-origin (/api) is used when proxied through CloudFront
  window.RUNTIME_CONFIG = Object.assign({}, cfg, { BACKEND_URL: existing || '' });
})();
