/**
 * Zen Memo - Unified Application Core (Tiptap + KaTeX Powered)
 * Standalone, zero-build, static-hosted WYSIWYG note-taking web app.
 *
 * このファイルがアプリの唯一の実体。index.html はこれだけを読む。
 * （2026-09-20 点検で見つかった 26 件を反映した版。詳細は README の「点検と修正の履歴」）
 */

/* ========================================================
   0. Constants
   ======================================================== */
const DB_NAME = 'zen_memo_db';
const DB_VERSION = 1;
const DEFAULT_TITLE = '無題のメモ';
const TOMBSTONE_KEY = 'tombstones';
const TOMBSTONE_TTL = 90 * 24 * 60 * 60 * 1000;   // 削除の記録を保つ期間
const AUTOSAVE_DELAY = 400;
const MIRROR_DELAY = 5000;                        // VFS への写し出しは緩める
const MAX_GIST_FILE_BYTES = 900 * 1000;           // Gist は 1MB を超えると壊れる
const VFS_MIRROR_DIR = 'user/appdata/zen-memo';

/* ========================================================
   1. IndexedDB Client (Local-First Persistence)
   ======================================================== */
class ZenDB {
  constructor() {
    this.db = null;
  }

  async open() {
    if (this.db) return this.db;

    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (e) => {
        const db = e.target.result;

        if (!db.objectStoreNames.contains('notes')) {
          const notesStore = db.createObjectStore('notes', { keyPath: 'id' });
          notesStore.createIndex('updatedAt', 'updatedAt', { unique: false });
        }

        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      };

      req.onsuccess = (e) => {
        this.db = e.target.result;
        resolve(this.db);
      };

      req.onerror = (e) => reject(e.target.error);
    });
  }

  async getAllNotes() {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('notes', 'readonly');
      const req = tx.objectStore('notes').getAll();
      req.onsuccess = () => {
        const notes = req.result || [];
        notes.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        resolve(notes);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async getNote(id) {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('notes', 'readonly');
      const req = tx.objectStore('notes').get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * @param {object} note
   * @param {{touch?: boolean}} opts
   *   touch=false のとき updatedAt を今の時刻で塗り潰さない。
   *   同期でリモートから取り込むときに使う（ここを塗ると競合検出が壊れる）。
   */
  async saveNote(note, { touch = true } = {}) {
    await this.open();
    if (touch || !note.updatedAt) note.updatedAt = Date.now();
    if (!note.createdAt) note.createdAt = note.updatedAt;

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('notes', 'readwrite');
      const req = tx.objectStore('notes').put(note);
      req.onsuccess = () => resolve(note);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * 「まだ在るときだけ」1 トランザクションで更新する。
   * 保存待ちの間にメモが消えた場合に、書き戻しで復活させないため。
   */
  async putIfExists(id, patch, { touch = true } = {}) {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('notes', 'readwrite');
      const store = tx.objectStore('notes');
      const getReq = store.get(id);

      getReq.onsuccess = () => {
        const note = getReq.result;
        if (!note) { resolve(null); return; }

        Object.assign(note, patch);
        if (touch || !note.updatedAt) note.updatedAt = Date.now();
        if (!note.createdAt) note.createdAt = note.updatedAt;

        const putReq = store.put(note);
        putReq.onsuccess = () => resolve(note);
        putReq.onerror = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  async deleteNote(id) {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('notes', 'readwrite');
      const req = tx.objectStore('notes').delete(id);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  async getSetting(key, defaultValue = null) {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('settings', 'readonly');
      const req = tx.objectStore('settings').get(key);
      req.onsuccess = () => {
        if (req.result && req.result.value !== undefined) resolve(req.result.value);
        else resolve(defaultValue);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async setSetting(key, value) {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('settings', 'readwrite');
      const req = tx.objectStore('settings').put({ key, value });
      req.onsuccess = () => resolve(value);
      req.onerror = () => reject(req.error);
    });
  }

  /* --- 削除の記録（tombstone）: 削除を同期先へ伝えるために要る --- */

  async getTombstones() {
    const t = await this.getSetting(TOMBSTONE_KEY, {});
    return (t && typeof t === 'object') ? t : {};
  }

  async setTombstones(tombstones) {
    return this.setSetting(TOMBSTONE_KEY, tombstones || {});
  }

  async addTombstone(id, ts = Date.now()) {
    const t = await this.getTombstones();
    t[id] = ts;
    await this.setTombstones(t);
    return t;
  }

  async pruneTombstones(now = Date.now()) {
    const t = await this.getTombstones();
    let changed = false;
    for (const [id, ts] of Object.entries(t)) {
      if (!ts || now - Number(ts) > TOMBSTONE_TTL) { delete t[id]; changed = true; }
    }
    if (changed) await this.setTombstones(t);
    return t;
  }
}

/* ========================================================
   2. GitHub Gist API Client (1 Gist, Multi-file Notebook)
   ======================================================== */
class GistClient {
  constructor(db) {
    this.db = db;
  }

  async getCredentials() {
    const pat = await this.db.getSetting('github_pat', '');
    const gistId = await this.db.getSetting('gist_id', '');
    return { pat, gistId };
  }

  /** manifest.json を安全に読む。欠けていても壊れていても同期を殺さない／黙って壊さない。 */
  readManifest(remoteGist) {
    const file = remoteGist && remoteGist.files && remoteGist.files['manifest.json'];
    let parsed = {};

    if (file) {
      if (file.truncated) {
        throw new Error('manifest.json が大きすぎて取得できませんでした。同期を中止します。');
      }
      try {
        parsed = JSON.parse(file.content || '{}') || {};
      } catch (e) {
        throw new Error('manifest.json を解釈できませんでした（壊れている可能性があります）。上書きを避けるため同期を中止しました。');
      }
    }

    const notes = (parsed.notes && typeof parsed.notes === 'object') ? parsed.notes : {};
    const deleted = (parsed.deleted && typeof parsed.deleted === 'object') ? parsed.deleted : {};
    return { ...parsed, notes, deleted };
  }

  /** 1MB を超えたファイルは API が content を切り詰めるので raw から取り直す。 */
  async fetchRaw(fileObj) {
    if (!fileObj || !fileObj.raw_url) return null;
    try {
      const r = await fetch(fileObj.raw_url);
      if (!r.ok) return null;
      return await r.text();
    } catch (e) {
      return null;
    }
  }

  byteLength(str) {
    try { return new TextEncoder().encode(str).length; } catch (e) { return str.length; }
  }

  async sync(onProgress = () => {}) {
    const { pat, gistId } = await this.getCredentials();
    if (!pat) {
      throw new Error('GitHub PAT (Personal Access Token) が未設定です。設定画面で登録してください。');
    }

    const headers = {
      'Authorization': `token ${pat}`,
      'Accept': 'application/vnd.github+json'
    };
    const warnings = [];
    let pulled = 0, pushed = 0, removedLocal = 0, removedRemote = 0, conflicts = 0;

    let remoteGist = null;
    let targetGistId = gistId;

    if (targetGistId) {
      onProgress('Gist の最新状態を取得中...');
      const res = await fetch(`https://api.github.com/gists/${targetGistId}`, { headers });
      if (res.status === 404) throw new Error(`指定された Gist ID (${targetGistId}) が見つかりません。`);
      if (res.status === 401 || res.status === 403) {
        throw new Error(`GitHub の認証に失敗しました (HTTP ${res.status})。PAT の有効期限と gist 権限を確認してください。`);
      }
      if (!res.ok) throw new Error(`Gist 取得エラー: HTTP ${res.status}`);
      remoteGist = await res.json();
    }

    const manifest = this.readManifest(remoteGist);
    const tombstones = await this.db.pruneTombstones();
    const lastSync = Number(await this.db.getSetting('last_sync_at', 0)) || 0;

    /* ---------- Remote → Local ---------- */
    onProgress('リモートの変更を取り込み中...');
    const localNotes = await this.db.getAllNotes();
    const localById = new Map(localNotes.map((n) => [n.id, n]));

    for (const [filename, fileObj] of Object.entries((remoteGist && remoteGist.files) || {})) {
      if (!filename.endsWith('.md')) continue;

      const noteId = filename.slice(0, -3);
      const meta = manifest.notes[noteId] || {};
      const remoteUpdated = Number(meta.updatedAt) || 0;
      const local = localById.get(noteId);
      const tomb = Number(tombstones[noteId]) || 0;

      // こちらで消したあとに向こうが変わっていないなら、取り込まない（復活させない）
      if (tomb && tomb >= remoteUpdated) continue;
      // ローカルの方が新しい（か同着）なら触らない
      if (local && remoteUpdated <= (local.updatedAt || 0)) continue;

      let content = fileObj.content || '';
      if (fileObj.truncated) {
        const raw = await this.fetchRaw(fileObj);
        if (raw === null) {
          warnings.push(`「${meta.title || noteId}」は本文が大きく取得しきれなかったため、取り込みを見送りました。`);
          continue;
        }
        content = raw;
      }

      // 双方に手が入っていた場合は、ローカル版を別のメモとして退避してから上書きする
      if (local && (local.updatedAt || 0) > lastSync) {
        const stamp = new Date(local.updatedAt || Date.now());
        const pad = (n) => String(n).padStart(2, '0');
        await this.db.saveNote({
          id: `${local.id}-conflict-${local.updatedAt || Date.now()}`,
          title: `${local.title || DEFAULT_TITLE}（競合 ${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())} ${pad(stamp.getHours())}:${pad(stamp.getMinutes())}）`,
          content: local.content || '',
          createdAt: local.createdAt || local.updatedAt || Date.now(),
          updatedAt: local.updatedAt || Date.now()
        }, { touch: false });
        conflicts++;
      }

      if (tomb) delete tombstones[noteId];   // 向こうで編集されていた＝復活を受け入れる

      await this.db.saveNote({
        id: noteId,
        title: meta.title || DEFAULT_TITLE,
        content,
        createdAt: Number(meta.createdAt) || Date.now(),
        updatedAt: remoteUpdated || Date.now()
      }, { touch: false });
      pulled++;
    }

    /* ---------- リモートの削除をこちらへ ---------- */
    for (const [noteId, ts] of Object.entries(manifest.deleted)) {
      const local = localById.get(noteId);
      if (local && (local.updatedAt || 0) <= (Number(ts) || 0)) {
        await this.db.deleteNote(noteId);
        tombstones[noteId] = Number(ts);
        removedLocal++;
      }
    }

    /* ---------- Local → Remote ---------- */
    onProgress('ローカルの変更を送信中...');
    const refreshedLocal = await this.db.getAllNotes();
    const files = {};

    for (const note of refreshedLocal) {
      const meta = manifest.notes[note.id];
      if (meta && (Number(meta.updatedAt) || 0) >= (note.updatedAt || 0)) continue;

      const body = (note.content && note.content.trim()) ? note.content : `# ${note.title || DEFAULT_TITLE}\n`;
      const bytes = this.byteLength(body);
      if (bytes > MAX_GIST_FILE_BYTES) {
        warnings.push(`「${note.title || note.id}」は ${(bytes / 1048576).toFixed(1)}MB あり Gist に載らないため送信を見送りました（画像を減らしてください）。`);
        continue;
      }

      files[`${note.id}.md`] = { content: body };
      manifest.notes[note.id] = {
        title: note.title || DEFAULT_TITLE,
        updatedAt: note.updatedAt,
        createdAt: note.createdAt || note.updatedAt
      };
      pushed++;
    }

    /* ---------- こちらの削除を向こうへ ---------- */
    const now = Date.now();
    for (const [noteId, ts] of Object.entries(tombstones)) {
      if (manifest.notes[noteId]) delete manifest.notes[noteId];
      manifest.deleted[noteId] = Number(ts);
      if (remoteGist && remoteGist.files && remoteGist.files[`${noteId}.md`]) {
        files[`${noteId}.md`] = null;   // GitHub はこれで削除
        removedRemote++;
      }
    }
    for (const [noteId, ts] of Object.entries(manifest.deleted)) {
      if (tombstones[noteId]) continue;   // この回で記録したものは消さない
      if (now - (Number(ts) || 0) > TOMBSTONE_TTL) delete manifest.deleted[noteId];
    }

    /* ---------- 書き込み ---------- */
    const hasChanges = Object.keys(files).length > 0;
    if (hasChanges || !remoteGist) {
      files['manifest.json'] = { content: JSON.stringify(manifest, null, 2) };
    }

    if (!targetGistId) {
      onProgress('新規 Gist の作成中...');
      const createRes = await fetch('https://api.github.com/gists', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: 'Zen Memo Notebook', public: false, files })
      });
      if (!createRes.ok) throw new Error(`Gist 作成エラー: HTTP ${createRes.status}`);
      const createdGist = await createRes.json();
      targetGistId = createdGist.id;
      await this.db.setSetting('gist_id', targetGistId);
    } else if (hasChanges) {
      onProgress('Gist へ差分を書き込み中...');
      const patchRes = await fetch(`https://api.github.com/gists/${targetGistId}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: 'Zen Memo Notebook', files })
      });
      if (!patchRes.ok) throw new Error(`Gist 更新エラー: HTTP ${patchRes.status}`);
    }

    await this.db.setTombstones(tombstones);
    await this.db.setSetting('last_sync_at', Date.now());

    const finalNotes = await this.db.getAllNotes();
    return {
      gistId: targetGistId,
      count: finalNotes.length,
      pulled, pushed, removedLocal, removedRemote, conflicts,
      warnings
    };
  }
}

/* ========================================================
   3. Theme & Custom CSS Manager
   ======================================================== */
class ThemeManager {
  constructor(db) {
    this.db = db;
    this.styleTag = null;
  }

  async init() {
    this.styleTag = document.getElementById('zen-custom-style');
    if (!this.styleTag) {
      this.styleTag = document.createElement('style');
      this.styleTag.id = 'zen-custom-style';
      document.head.appendChild(this.styleTag);
    }

    const theme = await this.db.getSetting('active_theme', 'paper');
    const customCss = await this.db.getSetting('custom_css', '');

    this.setTheme(theme);
    this.setCustomCss(customCss);
  }

  setTheme(themeName) {
    document.documentElement.setAttribute('data-theme', themeName);
    this.db.setSetting('active_theme', themeName);
  }

  setCustomCss(cssText) {
    if (this.styleTag) this.styleTag.textContent = cssText;
    this.db.setSetting('custom_css', cssText);
  }
}

/* ========================================================
   4. UI Manager (3 Variant Switcher & Mobile Viewport Fix)
   ======================================================== */
class UIManager {
  constructor(app) {
    this.app = app;
    this.variantPref = 'auto';      // ユーザーの設定値（'auto' を含む）
    this.currentVariant = 'capsule'; // 実際に表示している variant
    this.initViewportObserver();
    this.initVariantAutoSwitch();
  }

  /* 'auto' のとき、この幅以上ならカプセル・ピル、未満ならコーナードック */
  static get AUTO_BREAKPOINT() { return 720; }

  resolveVariant(pref) {
    if (pref !== 'auto') return pref;
    return window.innerWidth >= UIManager.AUTO_BREAKPOINT ? 'capsule' : 'sheet';
  }

  /** 設定値（'auto' | 'capsule' | 'sheet' | 'bar'）を受け取る入口 */
  setVariant(pref) {
    this.variantPref = pref || 'auto';
    this.applyVariant(this.resolveVariant(this.variantPref));
  }

  /** 実際の DOM 反映。'auto' は渡さないこと */
  applyVariant(variant) {
    this.currentVariant = variant;

    const capsuleEl = document.getElementById('variant-capsule');
    const cornerEl = document.getElementById('variant-corner');
    const barEl = document.getElementById('variant-bar');

    if (capsuleEl) capsuleEl.style.display = variant === 'capsule' ? 'flex' : 'none';
    if (cornerEl) cornerEl.style.display = variant === 'sheet' ? 'flex' : 'none';
    if (barEl) barEl.style.display = variant === 'bar' ? 'flex' : 'none';

    if (variant !== 'sheet') this.closeSheet();
    if (variant !== 'capsule') document.getElementById('capsule-pill')?.classList.remove('expanded');
  }

  /** 画面幅がしきい値をまたいだら、'auto' のときだけ差し替える */
  initVariantAutoSwitch() {
    const mql = window.matchMedia(`(min-width: ${UIManager.AUTO_BREAKPOINT}px)`);
    const onChange = () => {
      if (this.variantPref !== 'auto') return;
      const next = this.resolveVariant('auto');
      if (next !== this.currentVariant) this.applyVariant(next);
    };
    if (mql.addEventListener) mql.addEventListener('change', onChange);
    else mql.addListener(onChange); // 旧 Safari
    this._variantMql = mql;
  }

  initViewportObserver() {
    const appContainer = document.getElementById('app-container');

    const pinToTop = () => {
      if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0);
    };

    const updateLayout = () => {
      pinToTop();
      if (!window.visualViewport || !appContainer) return;

      const vv = window.visualViewport;
      if (Math.abs(window.innerHeight - vv.height) > 10) {
        appContainer.style.height = `${vv.height}px`;   // ソフトキーボードの分だけ縮める
      } else {
        appContainer.style.height = '';
      }
    };

    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', updateLayout);
      window.visualViewport.addEventListener('scroll', updateLayout);
    } else {
      window.addEventListener('resize', updateLayout);
    }
    window.addEventListener('scroll', pinToTop);

    updateLayout();
  }

  openDrawer() {
    document.getElementById('drawer-overlay')?.classList.add('open');
    document.getElementById('drawer')?.classList.add('open');
    this.app.renderNotesList();
    this.app.declareRoute('?view=list');
  }

  closeDrawer() {
    const wasOpen = this.isDrawerOpen();
    document.getElementById('drawer-overlay')?.classList.remove('open');
    document.getElementById('drawer')?.classList.remove('open');
    // 一覧から本文に戻った、も 1 つの場所として積む（戻るで一覧に帰れるように）
    if (wasOpen && this.app.currentNote) this.app.declareRoute(`?note=${this.app.currentNote.id}`);
  }

  isDrawerOpen() {
    return !!document.getElementById('drawer')?.classList.contains('open');
  }

  openSheet() {
    document.getElementById('variant-sheet')?.classList.add('open');
    document.getElementById('sheet-overlay')?.classList.add('open');
    document.body.classList.add('sheet-open');
  }

  closeSheet() {
    document.getElementById('variant-sheet')?.classList.remove('open');
    document.getElementById('sheet-overlay')?.classList.remove('open');
    document.body.classList.remove('sheet-open');
  }

  toggleSheet() {
    const sheet = document.getElementById('variant-sheet');
    if (sheet?.classList.contains('open')) this.closeSheet();
    else this.openSheet();
  }

  toggleCapsule() {
    document.getElementById('capsule-pill')?.classList.toggle('expanded');
  }

  openSettings() {
    this.closeSheet();
    document.getElementById('modal-settings')?.classList.add('open');
  }

  closeSettings() {
    document.getElementById('modal-settings')?.classList.remove('open');
  }

  toast(message, ms = 2400) {
    const el = document.getElementById('zen-toast');
    if (!el) return;
    clearTimeout(this._toastTimer);

    if (!message) { el.classList.remove('show'); return; }

    el.textContent = message;
    el.classList.add('show');
    if (ms > 0) this._toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }
}

/* ========================================================
   5. Image Handler (Paste & Compression to Base64)
   ======================================================== */
class ImageHandler {
  constructor(editor) {
    this.editor = editor;
    this.initPasteListener();
  }

  initPasteListener() {
    this.editor.el.addEventListener('paste', async (e) => {
      const items = (e.clipboardData || e.originalEvent?.clipboardData)?.items;
      if (!items) return;

      for (const item of items) {
        if (item.type.indexOf('image') !== -1) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) await this.processAndInsertImage(file);
          break;
        }
      }
    });
  }

  pickImage() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.style.display = 'none';

      input.onchange = async (e) => {
        const file = e.target.files?.[0];
        if (file) {
          await this.processAndInsertImage(file);
          resolve(true);
        } else {
          resolve(false);
        }
        input.remove();
      };

      document.body.appendChild(input);
      input.click();
    });
  }

  async processAndInsertImage(file) {
    try {
      const base64DataUrl = await this.compressImage(file, 1200, 0.82);
      this.editor.insertImage(base64DataUrl, file.name || 'image');
    } catch (err) {
      console.error('Image compression failed:', err);
      alert(`画像の読み込みに失敗しました: ${err?.message || err}`);
    }
  }

  compressImage(file, maxDimension = 1200, quality = 0.82) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = (e) => {
        const img = new Image();

        img.onload = () => {
          let width = img.width;
          let height = img.height;

          if (width > maxDimension || height > maxDimension) {
            if (width > height) {
              height = Math.round((height * maxDimension) / width);
              width = maxDimension;
            } else {
              width = Math.round((width * maxDimension) / height);
              height = maxDimension;
            }
          }

          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          canvas.getContext('2d').drawImage(img, 0, 0, width, height);

          try {
            const dataUrl = canvas.toDataURL('image/webp', quality);
            if (dataUrl.startsWith('data:image/webp')) return resolve(dataUrl);
          } catch (e) { /* WebP 非対応 → JPEG へ */ }

          resolve(canvas.toDataURL('image/jpeg', quality));
        };

        img.onerror = () => reject(new Error('画像を読み込めませんでした'));
        img.src = e.target.result;
      };

      reader.onerror = () => reject(new Error('ファイルを読み込めませんでした'));
      reader.readAsDataURL(file);
    });
  }
}

/* ========================================================
   6. Tiptap & KaTeX Editor Core (Rock-solid AST Markdown)
   ======================================================== */
class ZenEditor {
  constructor(element, options = {}) {
    this.el = element;
    this.options = options;
    this.onChange = options.onChange || (() => {});
    this.onTitleChange = options.onTitleChange || (() => {});
    this.tiptap = null;
  }

  async init() {
    const [
      { Editor, Node: TiptapNode, mergeAttributes },
      { default: StarterKit },
      { default: TaskList },
      { default: TaskItem },
      { default: ImageExt },
      { Markdown }
    ] = await Promise.all([
      /* 写し（vendor/）から読む。無い時だけ CDN に落ちる。js/vendor.js を参照。 */
      ZenVendor.load('vendor/esm.sh/@tiptap/core@2.2.4.mjs',               'https://esm.sh/@tiptap/core@2.2.4'),
      ZenVendor.load('vendor/esm.sh/@tiptap/starter-kit@2.2.4.mjs',        'https://esm.sh/@tiptap/starter-kit@2.2.4'),
      ZenVendor.load('vendor/esm.sh/@tiptap/extension-task-list@2.2.4.mjs','https://esm.sh/@tiptap/extension-task-list@2.2.4'),
      ZenVendor.load('vendor/esm.sh/@tiptap/extension-task-item@2.2.4.mjs','https://esm.sh/@tiptap/extension-task-item@2.2.4'),
      ZenVendor.load('vendor/esm.sh/@tiptap/extension-image@2.2.4.mjs',    'https://esm.sh/@tiptap/extension-image@2.2.4'),
      ZenVendor.load('vendor/esm.sh/tiptap-markdown@0.8.10.mjs',           'https://esm.sh/tiptap-markdown@0.8.10')
    ]);

    const renderTex = (target, tex, displayMode) => {
      target.innerHTML = '';
      if (window.katex) {
        try {
          window.katex.render(tex, target, { displayMode, throwOnError: false });
          return;
        } catch (e) { /* 下のテキスト表示へ落ちる */ }
      }
      target.textContent = displayMode ? tex : `$${tex}$`;
    };

    const editTex = (editorInstance, node, getPos, label) => {
      const newTex = window.prompt(label, node.attrs.tex);
      if (newTex === null) return;

      const pos = getPos();
      if (typeof pos !== 'number') return;

      if (!newTex.trim()) {
        editorInstance.commands.deleteRange({ from: pos, to: pos + node.nodeSize });
        return;
      }
      editorInstance.chain().setNodeSelection(pos).command(({ tr }) => {
        tr.setNodeMarkup(pos, undefined, { tex: newTex.trim() });
        return true;
      }).run();
    };

    // Inline Math Node
    const InlineMath = TiptapNode.create({
      name: 'inlineMath',
      group: 'inline',
      inline: true,
      atom: true,

      addAttributes() {
        return { tex: { default: '' } };
      },

      parseHTML() {
        return [{ tag: 'span[data-katex-inline]', getAttrs: (el) => ({ tex: el.getAttribute('data-tex') || '' }) }];
      },

      renderHTML({ HTMLAttributes }) {
        return ['span', mergeAttributes(HTMLAttributes, {
          'data-katex-inline': '',
          'data-tex': HTMLAttributes.tex,
          class: 'math-inline-wrapper'
        }), `$${HTMLAttributes.tex}$`];
      },

      addNodeView() {
        return ({ editor, node, getPos }) => {
          const dom = document.createElement('span');
          dom.className = 'math-inline-wrapper';
          dom.setAttribute('data-tex', node.attrs.tex);
          dom.setAttribute('contenteditable', 'false');
          dom.title = 'タップで編集';
          renderTex(dom, node.attrs.tex, false);

          dom.addEventListener('click', (e) => {
            e.preventDefault();
            editTex(editor, node, getPos, 'インライン数式を編集 (LaTeX / 空で削除):');
          });

          return { dom };
        };
      },

      addStorage() {
        return {
          markdown: {
            serialize(state, node) {
              state.write(`$${node.attrs.tex}$`);
            }
          }
        };
      }
    });

    // Block Math Node
    const BlockMath = TiptapNode.create({
      name: 'blockMath',
      group: 'block',
      atom: true,

      addAttributes() {
        return { tex: { default: '' } };
      },

      parseHTML() {
        return [{ tag: 'div[data-katex-block]', getAttrs: (el) => ({ tex: el.getAttribute('data-tex') || '' }) }];
      },

      renderHTML({ HTMLAttributes }) {
        return ['div', mergeAttributes(HTMLAttributes, {
          'data-katex-block': '',
          'data-tex': HTMLAttributes.tex,
          class: 'math-block-wrapper'
        })];
      },

      addNodeView() {
        return ({ editor, node, getPos }) => {
          const dom = document.createElement('div');
          dom.className = 'math-block-wrapper';
          dom.setAttribute('data-tex', node.attrs.tex);
          dom.setAttribute('contenteditable', 'false');
          dom.title = 'タップで編集';

          const display = document.createElement('div');
          display.className = 'katex-display';
          renderTex(display, node.attrs.tex, true);
          dom.appendChild(display);

          dom.addEventListener('click', (e) => {
            e.preventDefault();
            editTex(editor, node, getPos, 'ブロック数式を編集 (LaTeX / 空で削除):');
          });

          return { dom };
        };
      },

      addStorage() {
        return {
          markdown: {
            serialize(state, node) {
              state.write(`$$\n${node.attrs.tex}\n$$`);
              state.closeBlock(node);
            }
          }
        };
      }
    });

    this.tiptap = new Editor({
      element: this.el,
      extensions: [
        StarterKit.configure({ heading: { levels: [1, 2, 3, 4] } }),
        TaskList,
        TaskItem.configure({ nested: true }),
        ImageExt.configure({ allowBase64: true }),
        InlineMath,
        BlockMath,
        Markdown.configure({ html: true, tightLists: true, bulletListMarker: '-' })
      ],
      content: '',
      onUpdate: () => {
        this.extractAndNotifyTitle();
        this.onChange(this.getMarkdown());
      },
      onSelectionUpdate: () => {
        this.extractAndNotifyTitle();
      }
    });

    // $式$ / $$ + スペース の入力補助
    this.el.addEventListener('keyup', (e) => {
      if (e.key === '$') this.checkInlineMathInput();
      else if (e.key === ' ' || e.key === 'Spacebar') this.checkBlockMathInput();
    });
  }

  /** コード中では数式変換をしない */
  inCode() {
    return this.tiptap.isActive('code') || this.tiptap.isActive('codeBlock');
  }

  checkInlineMathInput() {
    if (!this.tiptap || this.inCode()) return false;

    const sel = this.tiptap.state.selection;
    if (!sel.empty) return false;

    const from = Math.max(0, sel.from - 220);
    const textBefore = this.tiptap.state.doc.textBetween(from, sel.from, '\n', '\0');

    // $ の直後・直前に空白を許さない（"$12 で、夕食は $" のような誤爆を防ぐ）
    const match = textBefore.match(/(^|[^\\$])\$([^\s$](?:[^$\n]{0,200}[^\s$])?)\$$/);
    if (!match) return false;

    const formula = match[2];
    const matchStart = sel.from - formula.length - 2;
    if (matchStart < 0) return false;

    this.tiptap.chain()
      .deleteRange({ from: matchStart, to: sel.from })
      .insertContent({ type: 'inlineMath', attrs: { tex: formula } })
      .run();
    return true;
  }

  checkBlockMathInput() {
    if (!this.tiptap || this.inCode()) return false;

    const sel = this.tiptap.state.selection;
    if (!sel.empty) return false;

    const $from = sel.$from;
    if ($from.parent.type.name !== 'paragraph') return false;
    if ($from.parent.textContent.trim() !== '$$') return false;

    const from = $from.before();
    const to = $from.after();
    const tex = window.prompt('ブロック数式を入力 (LaTeX):', '');

    if (tex === null || !tex.trim()) {
      // やめたときは "$$ " だけ消して空の段落に戻す
      this.tiptap.chain().deleteRange({ from: $from.start(), to: $from.start() + $from.parent.content.size }).run();
      return false;
    }

    this.tiptap.chain()
      .insertContentAt({ from, to }, { type: 'blockMath', attrs: { tex: tex.trim() } })
      .run();
    return true;
  }

  /** 先頭の H1 をタイトルとして拾う（見つけたら以降は見ない） */
  extractAndNotifyTitle() {
    if (!this.tiptap) return DEFAULT_TITLE;

    let title = null;
    this.tiptap.state.doc.descendants((node) => {
      if (title) return false;
      if (node.type.name === 'heading' && node.attrs.level === 1) {
        const text = node.textContent.trim();
        if (text) title = text;
        return false;
      }
      return true;
    });

    const resolved = title || DEFAULT_TITLE;
    this.onTitleChange(resolved);
    return resolved;
  }

  getTitle() {
    return this.extractAndNotifyTitle();
  }

  getMarkdown() {
    return this.tiptap.storage.markdown.getMarkdown();
  }

  getHTML() {
    return this.tiptap.getHTML();
  }

  isInEmptyParagraph() {
    if (!this.tiptap) return false;
    const $from = this.tiptap.state.selection.$from;
    return $from.parent.type.name === 'paragraph' && $from.parent.content.size === 0;
  }

  /**
   * Markdown → 本文。
   * コードブロック・コードスパン・"\$" は変換から守る。
   * 生成した KaTeX の HTML も退避してから次の置換をかけるので、二重適用で壊れない。
   */
  preprocess(markdown) {
    const slots = [];
    const keep = (s) => `\u0000${slots.push(s) - 1}\u0000`;

    let t = String(markdown).replace(/\u0000/g, '');

    // 1. 触ってはいけないものを退避
    t = t.replace(/(^|\n)([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\3[^\n]*(?=\n|$)|$)/g, (m) => keep(m));
    t = t.replace(/(`+)[\s\S]*?\1/g, (m) => keep(m));
    t = t.replace(/\\\$/g, (m) => keep(m));

    // 2. ブロック数式（行を占有しているものだけ）
    t = t.replace(/(^|\n)[ \t]*\$\$[ \t]*\n([\s\S]*?)\n[ \t]*\$\$[ \t]*(?=\n|$)/g,
      (m, pre, tex) => pre + keep(`<div data-katex-block="" data-tex="${this.escapeAttr(tex.trim())}"></div>`));
    t = t.replace(/(^|\n)[ \t]*\$\$[ \t]*([^\n]+?)[ \t]*\$\$[ \t]*(?=\n|$)/g,
      (m, pre, tex) => pre + keep(`<div data-katex-block="" data-tex="${this.escapeAttr(tex.trim())}"></div>`));

    // 3. インライン数式（$ の内側が空白で始まらない・終わらないものだけ）
    t = t.replace(/(^|[^\\$])\$([^\s$](?:[^$\n]{0,200}[^\s$])?)\$(?!\d)/g,
      (m, pre, tex) => pre + keep(`<span data-katex-inline="" data-tex="${this.escapeAttr(tex.trim())}"></span>`));

    // 4. 退避したものを戻す
    return t.replace(/\u0000(\d+)\u0000/g, (m, i) => (slots[Number(i)] !== undefined ? slots[Number(i)] : m));
  }

  setContent(markdown) {
    const md = typeof markdown === 'string' ? markdown : '';

    if (!md.trim()) {
      // 新規メモ: 空の H1 と段落だけ置いて、見出しにカーソルを置く
      this.tiptap.commands.setContent({
        type: 'doc',
        content: [{ type: 'heading', attrs: { level: 1 } }, { type: 'paragraph' }]
      });
    } else {
      this.tiptap.commands.setContent(this.preprocess(md));
    }

    this.tiptap.commands.setTextSelection(1);
    this.extractAndNotifyTitle();
  }

  escapeAttr(str) {
    return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  focus() {
    this.tiptap?.commands.focus();
  }

  toggleHeading(level) {
    this.tiptap.chain().focus().toggleHeading({ level }).run();
  }

  toggleList(type) {
    if (type === 'ul') this.tiptap.chain().focus().toggleBulletList().run();
    else this.tiptap.chain().focus().toggleOrderedList().run();
  }

  toggleTask() {
    this.tiptap.chain().focus().toggleTaskList().run();
  }

  toggleQuote() {
    this.tiptap.chain().focus().toggleBlockquote().run();
  }

  format(cmd) {
    if (cmd === 'bold') this.tiptap.chain().focus().toggleBold().run();
    else if (cmd === 'italic') this.tiptap.chain().focus().toggleItalic().run();
    else if (cmd === 'strikeThrough') this.tiptap.chain().focus().toggleStrike().run();
  }

  formatCode() {
    this.tiptap.chain().focus().toggleCode().run();
  }

  insertImage(src, alt = 'image') {
    const safeAlt = String(alt).replace(/[\[\]\n]/g, ' ').trim();
    this.tiptap.chain().focus().setImage({ src, alt: safeAlt }).run();
  }

  insertMath(tex = 'x = 1', isBlock = false) {
    const type = isBlock ? 'blockMath' : 'inlineMath';
    this.tiptap.chain().focus().insertContent({ type, attrs: { tex } }).run();
  }

  destroy() {
    if (this.tiptap) this.tiptap.destroy();
  }
}

/* ========================================================
   7. Application Orchestrator
   ======================================================== */
class ZenApp {
  constructor() {
    this.db = new ZenDB();
    this.editor = null;
    this.imageHandler = null;
    this.gistClient = null;
    this.ui = null;
    this.theme = null;

    this.currentNote = null;
    this.ready = false;
    this.syncing = false;

    this.autoSaveTimer = null;
    this.pendingSave = null;      // { noteId, markdown, title } — 保存先を「予約した時点」で固定する
    this.mirrorTimer = null;
    this.pendingMirror = null;
  }

  /* ---------- boot ---------- */

  async start() {
    this.bindEvents();          // 先に配線する（読み込み中に押されても落ちないように）
    this.bindLifecycle();

    try {
      await this.db.open();
    } catch (e) {
      this.showBootError('保存領域（IndexedDB）を開けませんでした。プライベートモードでは動作しません。', e);
      return;
    }

    this.theme = new ThemeManager(this.db);
    await this.theme.init();

    this.ui = new UIManager(this);
    this.ui.setVariant(await this.db.getSetting('ui_variant', 'auto'));

    this.gistClient = new GistClient(this.db);

    const editorEl = document.getElementById('editor-viewport');
    this.editor = new ZenEditor(editorEl, {
      onChange: (markdown) => this.queueAutoSave(markdown),
      onTitleChange: (title) => this.handleTitleUpdate(title)
    });

    try {
      await this.editor.init();
    } catch (e) {
      this.showBootError('エディタ本体（Tiptap）を読み込めませんでした。オフラインか、CDN に届いていない可能性があります。', e);
      return;
    }

    this.imageHandler = new ImageHandler(this.editor);
    this.initNavRouter();       // ブラウザの戻る／進むに乗せる
    await this.loadInitialNote();
    this.backfillMirror();      // 写しが無いメモを後から埋める（待たない）

    this.ready = true;
    document.body.classList.add('zen-ready');
    document.getElementById('boot-overlay')?.remove();
    this.editor.focus();
  }

  /* ---------- ナビゲーション（ブラウザの「戻る」＝一覧） ----------
     「一覧を開いた」「このメモを開いた」を 1 つずつ履歴に積むと、
     ブラウザの戻る／進むがそのまま画面の行き来になる。積み先は 2 通り。
     - Itera OS の中: ホストの履歴（MetaOS.nav.declare / nav_changed）に委ねる。
     - 単体ホスト（PWA）: History API（pushState / popstate）に自分で積む。
       URL は変えず state だけを積む（sw.js の照合と、オフラインでの再読込を揺らさないため）。
       最初のメモの下に「一覧」を 1 枚敷くので、開いた直後に戻ると一覧、もう一度戻るとサイトの外。 */

  hasNav() {
    return !!(window.MetaOS?.nav && typeof window.MetaOS.nav.declare === 'function');
  }

  /** 今いる場所を履歴に積む。履歴が 1 つ増える */
  declareRoute(route) {
    if (this._navApplying) return;      // 戻る／進むを反映している最中は積まない（無限ループ防止）
    if (this._lastRoute === route) return;  // 同じ場所を二重に積まない
    this._lastRoute = route;

    if (this.hasNav()) {
      try { window.MetaOS.nav.declare(route); } catch (e) { console.warn('[Zen Memo] nav.declare 失敗', e); }
      return;
    }

    try {
      if (!this._historySeeded) {
        this._historySeeded = true;
        const LIST = '?view=list';
        // 再読込のときは既に自分の履歴の上にいる。敷き直すと再読込のたびに履歴が伸びるので置き換えだけ
        const reloaded = typeof history.state?.zen === 'string';
        if (reloaded || route === LIST) {
          history.replaceState({ zen: route }, '');
        } else {
          history.replaceState({ zen: LIST }, '');
          history.pushState({ zen: route }, '');
        }
        return;
      }
      history.pushState({ zen: route }, '');
    } catch (e) { console.warn('[Zen Memo] history への記録に失敗', e); }
  }

  initNavRouter() {
    this._navApplying = false;
    this._lastRoute = null;
    this._historySeeded = false;

    if (this.hasNav()) {
      try {
        window.MetaOS.system.on('nav_changed', (state) => {
          this.applyRoute(state?.current?.uri || '');
        });
      } catch (e) { console.warn('[Zen Memo] nav_changed を購読できませんでした', e); }
      return;
    }

    window.addEventListener('popstate', (e) => {
      const route = e.state?.zen;
      if (typeof route === 'string') this.applyRoute(route);
    });
  }

  /** 履歴側から呼ばれる。ここでの画面変更は declare し返さない */
  async applyRoute(uri) {
    if (!this.ready && !this.editor?.tiptap) return;

    const params = new URLSearchParams(String(uri).split('?')[1] || '');
    const view = params.get('view');
    const noteId = params.get('note');

    this._navApplying = true;
    try {
      if (view === 'list') {
        this._lastRoute = '?view=list';
        this.ui.openDrawer();
        return;
      }
      if (noteId) {
        this._lastRoute = `?note=${noteId}`;
        this.ui.closeDrawer();
        if (this.currentNote?.id !== noteId && await this.db.getNote(noteId)) {
          await this.openNote(noteId);
        }
      }
    } catch (e) {
      console.warn('[Zen Memo] 経路の反映に失敗', e);
    } finally {
      this._navApplying = false;
    }
  }

  showBootError(message, error) {
    console.error('[Zen Memo]', message, error);
    const el = document.getElementById('boot-overlay');
    if (!el) { alert(message); return; }
    el.classList.add('error');
    el.innerHTML = `
      <div class="boot-box">
        <p class="boot-msg"></p>
        <p class="boot-detail"></p>
        <button class="btn-primary" id="boot-retry">再試行</button>
      </div>`;
    el.querySelector('.boot-msg').textContent = message;
    el.querySelector('.boot-detail').textContent = String(error?.message || error || '');
    el.querySelector('#boot-retry').onclick = () => location.reload();
  }

  bindLifecycle() {
    const flushNow = () => {
      this.flushSave();
      this.flushMirror();
    };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushNow();
    });
    window.addEventListener('pagehide', flushNow);
    window.addEventListener('beforeunload', flushNow);
  }

  /* ---------- notes ---------- */

  async loadInitialNote(opts = {}) {
    const notes = await this.db.getAllNotes();
    if (notes.length > 0) await this.openNote(notes[0].id, opts);
    else await this.createNewNote(opts);
  }

  async openNote(id, { closeDrawer = true } = {}) {
    await this.flushSave();                 // 切り替える前に必ず書き切る

    const note = await this.db.getNote(id);
    if (!note) return;

    this.currentNote = note;
    this.editor.setContent(note.content || '');
    this.handleTitleUpdate(note.title || DEFAULT_TITLE);
    if (closeDrawer) this.ui.closeDrawer();
    this.declareRoute(`?note=${note.id}`);
  }

  async createNewNote({ closeDrawer = true } = {}) {
    await this.flushSave();

    const now = Date.now();
    const newNote = {
      id: 'memo-' + now.toString(36) + Math.random().toString(36).slice(2, 6),
      title: DEFAULT_TITLE,
      content: '',
      createdAt: now,
      updatedAt: now
    };

    await this.db.saveNote(newNote);
    this.currentNote = newNote;
    this.editor.setContent('');
    this.handleTitleUpdate(DEFAULT_TITLE);
    if (closeDrawer) this.ui.closeDrawer();
    this.declareRoute(`?note=${newNote.id}`);
    this.editor.focus();
  }

  async deleteNote(id) {
    const note = await this.db.getNote(id);
    if (!note) return;
    if (!confirm(`「${note.title || DEFAULT_TITLE}」を削除します。よろしいですか？`)) return;

    if (this.pendingSave?.noteId === id) {
      clearTimeout(this.autoSaveTimer);
      this.pendingSave = null;
    }
    if (this.pendingMirror?.id === id) {
      clearTimeout(this.mirrorTimer);
      this.pendingMirror = null;
    }

    await this.db.deleteNote(id);
    await this.db.addTombstone(id);         // 次の同期で Gist からも消すため
    await this.unmirrorFromVfs(id);

    const wasCurrent = this.currentNote?.id === id;
    const drawerOpen = this.ui.isDrawerOpen();

    if (wasCurrent) {
      this.currentNote = null;
      await this.loadInitialNote({ closeDrawer: !drawerOpen });
    }
    await this.renderNotesList();
    this.ui.toast('削除しました');
  }

  async deleteCurrentNote() {
    if (!this.currentNote) return;
    await this.deleteNote(this.currentNote.id);
  }

  handleTitleUpdate(title) {
    if (this.currentNote) this.currentNote.title = title;
    document.title = `${title} — Zen Memo`;
  }

  /* ---------- save ---------- */

  queueAutoSave(markdown) {
    if (!this.currentNote) return;

    // 保存先の id をここで固定する（発火時に currentNote を見ると、切替直後に別のメモへ書き込む）
    this.pendingSave = {
      noteId: this.currentNote.id,
      markdown,
      title: this.currentNote.title || DEFAULT_TITLE
    };

    clearTimeout(this.autoSaveTimer);
    this.autoSaveTimer = setTimeout(() => this.flushSave(), AUTOSAVE_DELAY);
  }

  async flushSave() {
    clearTimeout(this.autoSaveTimer);
    this.autoSaveTimer = null;

    const pending = this.pendingSave;
    this.pendingSave = null;
    if (!pending) return null;

    // 在るときだけ書く（保存待ちの間に消えていたら、復活させずに捨てる）
    const note = await this.db.putIfExists(pending.noteId, {
      content: pending.markdown,
      title: pending.title
    });
    if (!note) return null;

    if (this.currentNote && this.currentNote.id === note.id) this.currentNote = note;
    this.queueMirror(note);
    return note;
  }

  /* ---------- Itera OS へのミラー（単体ホスト時は何もしない） ---------- */

  hasMetaOS() {
    return !!(window.MetaOS && window.MetaOS.fs);
  }

  queueMirror(note) {
    if (!this.hasMetaOS()) return;
    this.pendingMirror = { id: note.id, title: note.title, content: note.content, updatedAt: note.updatedAt };
    clearTimeout(this.mirrorTimer);
    this.mirrorTimer = setTimeout(() => this.flushMirror(), MIRROR_DELAY);
  }

  async flushMirror() {
    clearTimeout(this.mirrorTimer);
    this.mirrorTimer = null;

    const pending = this.pendingMirror;
    this.pendingMirror = null;
    if (!pending || !this.hasMetaOS()) return;

    try {
      await window.MetaOS.fs.mkdir(VFS_MIRROR_DIR).catch(() => {});
      const front = [
        '---',
        `id: ${pending.id}`,
        `title: ${JSON.stringify(pending.title || DEFAULT_TITLE)}`,
        `updated: ${new Date(pending.updatedAt || Date.now()).toISOString()}`,
        '---',
        ''
      ].join('\n');
      await window.MetaOS.fs.write(`${VFS_MIRROR_DIR}/${pending.id}.md`, front + '\n' + (pending.content || ''), { overwrite: true, silent: true });
    } catch (e) {
      console.warn('[Zen Memo] VFS mirror failed:', e);
    }
  }

  /** 写しがまだ無いメモを埋める（OS 上でのみ・起動時に一度だけ） */
  async backfillMirror() {
    if (!this.hasMetaOS()) return;
    try {
      await window.MetaOS.fs.mkdir(VFS_MIRROR_DIR).catch(() => {});
      for (const note of await this.db.getAllNotes()) {
        const path = `${VFS_MIRROR_DIR}/${note.id}.md`;
        if (await window.MetaOS.fs.exists(path)) continue;
        this.pendingMirror = { id: note.id, title: note.title, content: note.content, updatedAt: note.updatedAt };
        await this.flushMirror();
      }
    } catch (e) {
      console.warn('[Zen Memo] VFS backfill failed:', e);
    }
  }

  async unmirrorFromVfs(id) {
    if (!this.hasMetaOS()) return;
    try {
      const path = `${VFS_MIRROR_DIR}/${id}.md`;
      if (await window.MetaOS.fs.exists(path)) await window.MetaOS.fs.delete(path);
    } catch (e) {
      console.warn('[Zen Memo] VFS unmirror failed:', e);
    }
  }

  /* ---------- 書き出し ----------
     Itera OS 上では保存ダイアログで VFS に置く。単体ブラウザでは普通のダウンロードに落とす。 */

  safeFileName(name, fallback = 'memo') {
    const cleaned = String(name || '')
      .replace(/[\\/:*?"<>|]/g, '')       // ファイル名に使えない文字
      .replace(/[\u0000-\u001f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);
    return cleaned || fallback;
  }

  fileStamp(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  }

  /** 1 ファイルを保存する。戻り値は保存先（取り消したら null） */
  async saveAsFile(filename, text, { mime = 'text/markdown', filters = ['.md'] } = {}) {
    if (this.hasMetaOS() && window.MetaOS.host?.showSaveDialog) {
      try {
        const path = await window.MetaOS.host.showSaveDialog({
          title: '書き出し先を選んでください',
          defaultName: filename,
          filters
        });
        if (!path) return null;              // 取り消しは失敗ではない
        await window.MetaOS.fs.write(path, text, { overwrite: true });
        return path;
      } catch (e) {
        console.warn('[Zen Memo] VFS への保存に失敗。ダウンロードに切り替えます', e);
      }
    }

    const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return filename;
  }

  /** 開いているメモを Markdown ファイルとして書き出す */
  async exportCurrentNote() {
    if (!this.ready || !this.currentNote) { this.ui?.toast('書き出せるメモがありません'); return; }
    await this.flushSave();                 // 画面の最新を確実に本文へ

    const body = this.editor?.getMarkdown?.() || this.currentNote.content || '';
    if (!body.trim()) { this.ui?.toast('中身が空です'); return; }

    const base = this.safeFileName(this.currentNote.title, 'memo');
    const saved = await this.saveAsFile(`${base}.md`, body);
    if (saved) this.ui?.toast(`${base}.md を書き出しました`);
  }

  /** データベース全体（全メモ＋見た目の設定）を 1 つの JSON に書き出す */
  async exportDatabase() {
    if (!this.ready) { this.ui?.toast('まだ準備中です'); return; }
    await this.flushSave();

    try {
      const notes = await this.db.getAllNotes();
      const [activeTheme, uiVariant, customCss, gistId] = await Promise.all([
        this.db.getSetting('active_theme', 'paper'),
        this.db.getSetting('ui_variant', 'auto'),
        this.db.getSetting('custom_css', ''),
        this.db.getSetting('gist_id', '')
      ]);

      const payload = {
        format: 'zen-memo-backup',
        version: 1,
        exportedAt: new Date().toISOString(),
        count: notes.length,
        // GitHub PAT は意図的に含めない（バックアップを渡した相手に鍵まで渡さないため）
        settings: { active_theme: activeTheme, ui_variant: uiVariant, custom_css: customCss, gist_id: gistId },
        notes: notes.map((n) => ({
          id: n.id,
          title: n.title,
          content: n.content,
          createdAt: n.createdAt,
          updatedAt: n.updatedAt
        }))
      };

      const saved = await this.saveAsFile(
        `zen-memo-backup-${this.fileStamp()}.json`,
        JSON.stringify(payload, null, 2),
        { mime: 'application/json', filters: ['.json'] }
      );
      if (saved) this.ui?.toast(`${notes.length} 件を書き出しました`);
    } catch (e) {
      console.error('[Zen Memo] エクスポートに失敗', e);
      this.ui?.toast('書き出しに失敗しました');
    }
  }

  /* ---------- sync ---------- */

  async runSync() {
    if (this.syncing) return;
    if (!this.ready) { this.ui?.toast('まだ準備中です'); return; }

    this.syncing = true;
    const openId = this.currentNote?.id || null;

    try {
      await this.flushSave();               // 画面の内容を書き切ってから同期する
      const result = await this.gistClient.sync((msg) => this.ui.toast(msg, 0));

      // 取り込みで開いているメモが変わったら、画面を開き直す（次の打鍵で上書きされるのを防ぐ）
      if (openId) {
        const fresh = await this.db.getNote(openId);
        if (!fresh) {
          await this.loadInitialNote();
          this.ui.toast('開いていたメモは同期で削除されました', 4000);
        } else if ((fresh.content || '') !== (this.currentNote?.content || '')) {
          await this.openNote(openId, { closeDrawer: false });
          this.ui.toast('同期した内容で開き直しました', 4000);
        } else {
          this.currentNote = fresh;
        }
      }

      await this.renderNotesList();

      const parts = [];
      if (result.pulled) parts.push(`取り込み ${result.pulled}`);
      if (result.pushed) parts.push(`送信 ${result.pushed}`);
      if (result.removedLocal) parts.push(`こちらで削除 ${result.removedLocal}`);
      if (result.removedRemote) parts.push(`Gist から削除 ${result.removedRemote}`);
      if (result.conflicts) parts.push(`競合を退避 ${result.conflicts}`);
      this.ui.toast(parts.length ? `同期完了（${parts.join(' / ')}）` : '同期完了（変更なし）', 4000);

      if (result.warnings.length) {
        alert('同期は完了しましたが、注意があります:\n\n・' + result.warnings.join('\n・'));
      }
    } catch (err) {
      this.ui.toast('');
      console.error('[Zen Memo] sync failed:', err);
      alert(`❌ 同期に失敗しました:\n${err.message}`);
    } finally {
      this.syncing = false;
    }
  }

  /* ---------- list ---------- */

  async renderNotesList() {
    const listEl = document.getElementById('memo-list');
    if (!listEl) return;

    const notes = await this.db.getAllNotes();
    listEl.innerHTML = '';

    if (notes.length === 0) {
      const li = document.createElement('li');
      li.className = 'memo-empty';
      li.textContent = 'メモはまだありません';
      listEl.appendChild(li);
      return;
    }

    notes.forEach((note) => {
      const li = document.createElement('li');
      li.className = 'memo-item' + (this.currentNote?.id === note.id ? ' active' : '');

      const dateStr = new Date(note.updatedAt || Date.now()).toLocaleString('ja-JP', {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
      });

      const main = document.createElement('button');
      main.className = 'memo-item-main';
      main.innerHTML = `
        <span class="memo-item-title"></span>
        <span class="memo-item-meta"></span>`;
      main.querySelector('.memo-item-title').textContent = note.title || DEFAULT_TITLE;
      main.querySelector('.memo-item-meta').textContent = dateStr;
      main.onclick = () => this.openNote(note.id);

      const del = document.createElement('button');
      del.className = 'memo-item-del';
      del.title = 'このメモを削除';
      del.setAttribute('aria-label', `「${note.title || DEFAULT_TITLE}」を削除`);
      del.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>';
      del.onclick = (e) => { e.stopPropagation(); this.deleteNote(note.id); };

      li.appendChild(main);
      li.appendChild(del);
      listEl.appendChild(li);
    });
  }

  /* ---------- settings ---------- */

  async openSettings() {
    const [pat, gistId, activeTheme, activeUI, customCss, lastSync] = await Promise.all([
      this.db.getSetting('github_pat', ''),
      this.db.getSetting('gist_id', ''),
      this.db.getSetting('active_theme', 'paper'),
      this.db.getSetting('ui_variant', 'auto'),
      this.db.getSetting('custom_css', ''),
      this.db.getSetting('last_sync_at', 0)
    ]);

    document.getElementById('input-pat').value = pat;
    document.getElementById('input-gist-id').value = gistId;
    document.getElementById('select-theme').value = activeTheme;
    document.getElementById('select-ui-variant').value = activeUI;
    document.getElementById('textarea-custom-css').value = customCss;

    const info = document.getElementById('sync-info');
    if (info) {
      info.textContent = lastSync
        ? `最後の同期: ${new Date(Number(lastSync)).toLocaleString('ja-JP')}`
        : 'まだ同期していません';
    }

    this.ui.openSettings();
  }

  async saveSettings() {
    const pat = document.getElementById('input-pat').value.trim();
    const gistId = document.getElementById('input-gist-id').value.trim();
    const activeTheme = document.getElementById('select-theme').value;
    const activeUI = document.getElementById('select-ui-variant').value;
    const customCss = document.getElementById('textarea-custom-css').value;

    await this.db.setSetting('github_pat', pat);
    await this.db.setSetting('gist_id', gistId);
    await this.db.setSetting('ui_variant', activeUI);

    this.theme.setTheme(activeTheme);
    this.theme.setCustomCss(customCss);
    this.ui.setVariant(activeUI);

    this.ui.closeSettings();
    this.ui.toast('設定を保存しました');
  }

  /* ---------- wiring ---------- */

  bindEvents() {
    const withEditor = (fn) => () => {
      if (!this.ready || !this.editor?.tiptap) { this.ui?.toast('まだ準備中です'); return; }
      fn();
    };

    window.openDrawer = () => this.ui?.openDrawer();
    window.closeDrawer = () => this.ui?.closeDrawer();
    window.createNewNote = withEditor(() => this.createNewNote());
    window.deleteCurrentNote = withEditor(() => this.deleteCurrentNote());

    window.toggleCapsule = () => this.ui?.toggleCapsule();
    window.toggleSheet = () => this.ui?.toggleSheet();
    window.closeSheet = () => this.ui?.closeSheet();
    window.openSettings = () => this.openSettings();
    window.closeSettings = () => this.ui?.closeSettings();
    window.saveSettings = () => this.saveSettings();
    window.exportCurrentNote = () => this.exportCurrentNote();
    window.exportDatabase = () => this.exportDatabase();

    window.cmdBold = withEditor(() => this.editor.format('bold'));
    window.cmdItalic = withEditor(() => this.editor.format('italic'));
    window.cmdStrike = withEditor(() => this.editor.format('strikeThrough'));
    window.cmdCode = withEditor(() => this.editor.formatCode());
    window.cmdH2 = withEditor(() => this.editor.toggleHeading(2));
    window.cmdH3 = withEditor(() => this.editor.toggleHeading(3));
    window.cmdListUl = withEditor(() => this.editor.toggleList('ul'));
    window.cmdListOl = withEditor(() => this.editor.toggleList('ol'));
    window.cmdTask = withEditor(() => this.editor.toggleTask());
    window.cmdQuote = withEditor(() => this.editor.toggleQuote());
    window.cmdImage = withEditor(() => this.imageHandler.pickImage());

    // 空の段落ならブロック数式、そうでなければインライン数式
    window.cmdMath = withEditor(() => {
      const isBlock = this.editor.isInEmptyParagraph();
      const tex = window.prompt(isBlock ? 'ブロック数式を入力 (LaTeX):' : 'インライン数式を入力 (LaTeX):', 'x = 1');
      if (tex && tex.trim()) this.editor.insertMath(tex.trim(), isBlock);
    });

    window.triggerSync = () => this.runSync();
  }
}

/* ========================================================
   8. Bootstrap
   ======================================================== */
window.Zen = { ZenDB, GistClient, ThemeManager, UIManager, ImageHandler, ZenEditor, ZenApp };

window.addEventListener('DOMContentLoaded', () => {
  window.app = new ZenApp();
  window.app.start();
});