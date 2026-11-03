/* Aurora Calculator - AdMax isolated loader with a visible loading state.
 * A single official AdMax request is made. No refresh loop or retry is used.
 */
(() => {
  "use strict";

  const slot = document.querySelector('.admax-ads[data-admax-id]');
  const frame = document.getElementById('admaxAdFrame');
  const status = document.getElementById('admaxStatus');
  if (!slot || !frame || !status) return;

  const admaxId = (slot.dataset.admaxId || "").trim();
  if (!/^[a-f0-9]{32}$/i.test(admaxId)) {
    frame.dataset.admaxState = 'unavailable';
    status.textContent = '広告IDを確認できません。';
    console.warn('Aurora AdMax: invalid ad slot ID.');
    return;
  }

  if (window.__auroraAdMaxInitStarted) return;
  window.__auroraAdMaxInitStarted = true;

  const markFilled = () => {
    // AdMax normally inserts a visible iframe or creative element into .admax-ads.
    // Ignore loader scripts and tiny tracking pixels when deciding whether the ad is visible.
    const candidates = slot.querySelectorAll('iframe[src], img[src], video[src], object[data], embed[src], a[href]');
    for (const el of candidates) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
      if (rect.width < 40 || rect.height < 40) continue;
      if (el.tagName === 'IMG' && el.complete && el.naturalWidth < 20) continue;
      frame.dataset.admaxState = 'filled';
      return true;
    }

    // Some creatives are wrapped in a non-semantic element. Accept a sufficiently
    // large visible child other than SCRIPT/STYLE/TEMPLATE when it has content.
    for (const el of slot.children) {
      if (/^(SCRIPT|STYLE|TEMPLATE)$/.test(el.tagName)) continue;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      if (style.display !== 'none' && style.visibility !== 'hidden' && rect.width >= 80 && rect.height >= 80 && (el.childElementCount > 0 || el.textContent.trim())) {
        frame.dataset.admaxState = 'filled';
        return true;
      }
    }
    return false;
  };

  const observer = new MutationObserver(() => {
    if (markFilled()) observer.disconnect();
  });
  observer.observe(slot, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'href', 'style', 'class'] });
  slot.addEventListener('load', () => { if (markFilled()) observer.disconnect(); }, true);

  // Keep the observer alive after this timeout: if AdMax supplies a late creative,
  // the loading message will still disappear. Do not issue another ad request.
  const timeoutMs = 30000;
  window.setTimeout(() => {
    if (markFilled()) {
      observer.disconnect();
      return;
    }
    frame.dataset.admaxState = 'unavailable';
    status.textContent = '広告を取得できませんでした。時間をおいて再度ご確認ください。';
  }, timeoutMs);

  // Match the official AdMax asynchronous snippet: queue first, then t.js once.
  window.admaxads = window.admaxads || [];
  window.admaxads.push({ admax_id: admaxId, type: 'banner' });

  const loader = document.createElement('script');
  loader.type = 'text/javascript';
  loader.charset = 'utf-8';
  loader.src = 'https://adm.shinobi.jp/st/t.js';
  loader.async = true;
  loader.dataset.auroraAdMaxLoader = 'true';
  loader.onerror = () => {
    frame.dataset.admaxState = 'unavailable';
    status.textContent = '広告スクリプトを読み込めませんでした。';
    console.warn('Aurora AdMax: t.js could not be loaded.');
  };
  document.head.appendChild(loader);
})();
