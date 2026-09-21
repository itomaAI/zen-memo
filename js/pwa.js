/* ========================================================
   Zen Memo - PWA 登録と表示色の追随
   ========================================================
   app.js には触らない。ここが落ちてもアプリ本体は動く。

   1. Service Worker の登録（単体ホスト・https のときだけ）
   2. <meta name="theme-color"> を現在のテーマの --bg-color に合わせる
   ======================================================== */

(function () {
  'use strict';

  /* このスクリプト自身の場所から、アプリの根（index.html のある階層）を求める。
     /zen-memo/js/pwa.js → /zen-memo/ 。ページの URL 形に依存しないのでサブパス配置でも狂わない。 */
  var SELF_SRC = (document.currentScript && document.currentScript.src) || '';
  var ROOT = SELF_SRC ? new URL('../', SELF_SRC) : new URL('./', location.href);

  /* ---------- 1. theme-color ---------- */
  function themeMeta() {
    var m = document.querySelector('meta[name="theme-color"]');
    if (!m) {
      m = document.createElement('meta');
      m.setAttribute('name', 'theme-color');
      document.head.appendChild(m);
    }
    return m;
  }

  function syncThemeColor() {
    try {
      var bg = getComputedStyle(document.documentElement).getPropertyValue('--bg-color').trim();
      if (bg) themeMeta().setAttribute('content', bg);
    } catch (e) { /* 表示色が合わないだけなので黙って諦める */ }
  }

  syncThemeColor();
  document.addEventListener('DOMContentLoaded', syncThemeColor);
  try {
    new MutationObserver(syncThemeColor).observe(document.documentElement, {
      attributes: true, attributeFilter: ['data-theme']
    });
  } catch (e) {}

  /* ---------- 2. Service Worker ---------- */
  var secure = (location.protocol === 'https:') ||
               location.hostname === 'localhost' ||
               location.hostname === '127.0.0.1';
  var inItera = (typeof window.MetaOS !== 'undefined');

  if (!('serviceWorker' in navigator) || !secure || inItera) {
    /* Itera OS の中（blob:）と file:// はここで終わり。アプリは今まで通り動く。 */
    return;
  }

  /* 本体の toast をそのまま借りる（window.app.ui.toast）。
     まだ居ない・壊れている場合だけ、同じ要素・同じクラス名（.show）で自前に出す。 */
  function toast(msg) {
    try {
      if (window.app && window.app.ui && typeof window.app.ui.toast === 'function') {
        window.app.ui.toast(msg, 4000);
        return;
      }
    } catch (e) {}
    var el = document.getElementById('zen-toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(function () { el.classList.remove('show'); }, 4000);
  }

  window.addEventListener('load', function () {
    navigator.serviceWorker.register(new URL('sw.js', ROOT).href, { scope: ROOT.href })
      .then(function (reg) {
        window.__zenSW = reg;

        /* 新しい版が入ったとき。初回導入（controller なし）では黙っている。 */
        reg.addEventListener('updatefound', function () {
          var sw = reg.installing;
          if (!sw) return;
          sw.addEventListener('statechange', function () {
            if (sw.state === 'installed' && navigator.serviceWorker.controller) {
              toast('新しい版を取り込みました。次に開いたときから反映されます。');
            }
          });
        });

        /* 起動のたびに更新を確認する（起動さえすれば勝手に新しくなる） */
        reg.update().catch(function () {});
      })
      .catch(function (err) {
        console.warn('[zen-memo] Service Worker の登録に失敗しました:', err);
      });
  });

  /* 困ったときの手動リセット。コンソールから zenClearCaches() で呼べる。 */
  window.zenClearCaches = function () {
    if (!navigator.serviceWorker.controller) return Promise.resolve(false);
    navigator.serviceWorker.controller.postMessage({ type: 'zen-clear-caches' });
    return new Promise(function (resolve) {
      navigator.serviceWorker.addEventListener('message', function handler(e) {
        if (e.data && e.data.type === 'zen-caches-cleared') {
          navigator.serviceWorker.removeEventListener('message', handler);
          resolve(true);
        }
      });
    });
  };
})();