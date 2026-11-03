/* Aurora Calculator - AdMax isolated loader
 * Runs independently of the calculator app so app/history errors cannot
 * prevent the ad request from being queued. It intentionally loads once
 * and does not auto-retry, avoiding duplicate ad requests.
 */
(() => {
  "use strict";

  const slot = document.querySelector('.admax-ads[data-admax-id]');
  if (!slot) return;

  const admaxId = (slot.dataset.admaxId || "").trim();
  if (!/^[a-f0-9]{32}$/i.test(admaxId)) {
    console.warn("Aurora AdMax: invalid ad slot ID.");
    return;
  }

  if (window.__auroraAdMaxInitStarted) return;
  window.__auroraAdMaxInitStarted = true;

  // Use the official AdMax queue format, then load the official async loader.
  window.admaxads = window.admaxads || [];
  window.admaxads.push({ admax_id: admaxId, type: "banner" });

  const loader = document.createElement("script");
  loader.type = "text/javascript";
  loader.charset = "utf-8";
  loader.src = "https://adm.shinobi.jp/st/t.js";
  loader.async = true;
  loader.dataset.auroraAdMaxLoader = "true";
  loader.onerror = () => {
    console.warn("Aurora AdMax: t.js could not be loaded. Check browser/network blocking and AdMax delivery.");
  };
  document.head.appendChild(loader);
})();
