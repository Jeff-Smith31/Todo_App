// Runtime configuration for the web app when served by Nginx on the same host as the backend
// Empty BACKEND_URL indicates same-origin; API calls go to relative paths like /api/*
(function(){
  window.RUNTIME_CONFIG = Object.assign({}, window.RUNTIME_CONFIG || {}, {
    BACKEND_URL: ''
  });
})();
