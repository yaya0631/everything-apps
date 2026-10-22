// Must come first: connects the app to your own CAD server instead of Puter.
import './local-cloud.js';
import { guest } from './local-cloud.js';
import './styles/tokens.css';
import './styles/base.css';
import './styles/chrome.css';
import './styles/panels.css';
import './styles/dialogs.css';
import { App } from './app.js';
import { showAlphaNotice } from './ui/alpha.js';

const root = document.getElementById('app');
const app = new App(root);
if (import.meta.env.DEV) window.cad = app;
app
  .start()
  .catch((err) => {
    console.error(err);
    if (app.shell) app.fatal('Something went wrong while starting. Reload the page to try again.', err);
  })
  .finally(() => showAlphaNotice());

// A share link runs on a URL that keeps changing (the token); guests never install it.
if ('serviceWorker' in navigator && import.meta.env.PROD && !guest) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./sw.js')
      .then(() => navigator.serviceWorker.ready)
      .then((reg) => {
        // Hand the worker this build's files so they work offline.
        const urls = performance
          .getEntriesByType('resource')
          .map((e) => e.name)
          .filter((u) => u.startsWith(location.origin) && u.includes('/assets/'));
        reg.active?.postMessage({ type: 'precache', urls });
      })
      .catch(() => {});
  });
}
