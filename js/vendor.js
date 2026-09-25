/**
 * Zen Memo - Vendor Loader
 *
 * 写した ES モジュール（vendor/）を読む。classic script。app.js より先に読ませる。
 *
 * なぜ要るか
 *   Itera OS の中でアプリは blob: URL の上で動く。blob: URL には「居場所」が無いので、
 *   resolveUrl() が返す URL をそのまま import しても、モジュール自身が持つ
 *   './prosemirror-model@1.25.11/...' のような相対指定が解けない（検証済み）。
 *   そこで graph を自前で解く。VFS から本文を読み、相対指定を再帰的に
 *   blob: URL へ書き換えてから import する。
 *
 *   経路ごとに記憶するので、写し 1 つにつき実体は 1 つに保たれる。
 *   ここが崩れると prosemirror-model が二重になり、instanceof が静かに壊れる。
 *
 * 単体ホスト（GitHub Pages など）では話は単純で、相対指定がそのまま効くので
 * ブラウザに任せる。vendor/ が無い時だけ CDN へ落ちる。
 */
(function () {
  'use strict';

  const APP_ROOT = 'user/apps/zen-memo';   /* OS の中での居場所 */

  /* ---- 経路の正規化（.. と . を畳む） ---- */
  function normalize(path) {
    const out = [];
    for (const seg of path.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') out.pop();
      else out.push(seg);
    }
    return out.join('/');
  }

  function dirname(path) {
    const a = path.split('/');
    a.pop();
    return a.join('/');
  }

  const SPEC_RE = /(?:\bfrom|\bimport)\s*\(?\s*("|')([^"']+)\1/g;

  function findSpecifiers(code) {
    const found = [];
    let m;
    SPEC_RE.lastIndex = 0;
    while ((m = SPEC_RE.exec(code)) !== null) found.push(m[2]);
    return Array.from(new Set(found));
  }

  const blobCache = new Map();   /* vfsPath -> Promise<blobUrl> */

  /**
   * @param {string}   vfsPath
   * @param {string[]} chain  この枝の祖先（循環を見張る）。
   *   共有の stack にすると、入口を Promise.all で同時に読んだとき
   *   他の枝の途中経過を「循環」と見誤り、指定を書き換え損ねる。
   *   blob: URL には居場所が無いので、書き換え損ねはそのまま解決不能になる。
   *   だから枝ごとに配列を渡す。
   */
  function toBlobUrl(vfsPath, chain) {
    if (blobCache.has(vfsPath)) return blobCache.get(vfsPath);
    const ancestors = chain || [];

    const p = (async () => {
      let code = await window.MetaOS.fs.read(vfsPath);
      const dir = dirname(vfsPath);
      const here = ancestors.concat(vfsPath);

      const pairs = [];
      for (const spec of findSpecifiers(code)) {
        if (!/^\.\.?\//.test(spec)) continue;            /* 相対指定だけが対象 */
        const dep = normalize(dir + '/' + spec);
        if (here.indexOf(dep) !== -1) {
          /* 本物の循環。書き換えられないので、黙って壊さず声を上げる。 */
          console.warn('[ZenVendor] 循環参照: ' + dep + ' ← ' + vfsPath);
          continue;
        }
        pairs.push([spec, await toBlobUrl(dep, here)]);
      }

      /* 長い指定から順に置く（短いものが部分一致で食い込むのを防ぐ） */
      pairs.sort((x, y) => y[0].length - x[0].length);
      for (const [spec, url] of pairs) {
        code = code.split('"' + spec + '"').join('"' + url + '"');
        code = code.split("'" + spec + "'").join("'" + url + "'");
      }

      return URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    })();

    blobCache.set(vfsPath, p);
    return p;
  }

  /**
   * 写しを 1 つ読む。
   * @param {string} rel  アプリからの相対経路（例 'vendor/esm.sh/@tiptap/core@2.2.4.mjs'）
   * @param {string} cdn  写しが無い時に頼る URL
   */
  const trace = [];
  window.__zenVendorTrace = trace;

  async function load(rel, cdn) {
    const t = { rel, at: Math.round(performance.now()), metaos: typeof window.MetaOS };

    if (window.MetaOS && window.MetaOS.fs) {
      const vfsPath = APP_ROOT + '/' + rel;
      try {
        if (await window.MetaOS.fs.exists(vfsPath)) {
          const mod = await import(await toBlobUrl(vfsPath));
          t.branch = 'vfs';
          trace.push(t);
          return mod;
        }
        t.branch = 'cdn:写しが無い';
        console.warn('[ZenVendor] 写しが見当たらない: ' + vfsPath + ' → CDN に頼る');
      } catch (e) {
        t.branch = 'cdn:例外';
        t.error = String((e && e.message) || e);
        console.warn('[ZenVendor] 写しを読めなかった: ' + rel + ' → CDN に頼る', e);
      }
      trace.push(t);
      return import(cdn);
    }

    t.branch = 'standalone';

    /* 単体ホスト: 相対指定がそのまま効く。基準は index.html。 */
    try {
      const mod = await import(new URL(rel, document.baseURI).href);
      trace.push(t);
      return mod;
    } catch (e) {
      t.branch = 'standalone→cdn';
      t.error = String((e && e.message) || e);
      t.base = document.baseURI;
      trace.push(t);
      console.warn('[ZenVendor] 写しを読めなかった: ' + rel + ' → CDN に頼る', e);
      return import(cdn);
    }
  }

  window.ZenVendor = { load, APP_ROOT };
})();