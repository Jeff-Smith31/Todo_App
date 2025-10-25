// Overwritten during CI deploy. Used to display the current app version in the UI.
// Keeps a safe default for local/dev so service worker doesn't fail if the file is missing in S3.
(function(){
  if (typeof window !== 'undefined') {
    window.APP_VERSION = window.APP_VERSION || 'dev';
  }
})();
