// Runtime configuration for the frontend. This file can be overwritten at deploy time.
// BACKEND_URL: leave empty string to use same-origin (CloudFront routes /api/* to backend).
// You can override locally by setting localStorage.setItem('tt_backend_url', 'https://your-backend.example.com')
window.RUNTIME_CONFIG = Object.assign({}, window.RUNTIME_CONFIG || {}, {
  BACKEND_URL: ''
});
