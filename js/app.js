/**
 * Zen Memo - Unified Application Core
 * Standalone, zero-build, static-hosted WYSIWYG note-taking web app.
 * Modules: DB (IndexedDB), GistClient, ThemeManager, UIManager, ImageHandler, ZenEditor, ZenApp.
 */

/* ========================================================
   1. IndexedDB Client (Local-First Persistence)
   ======================================================== */
const DB_NAME = 'zen_memo_db';
const DB_VERSION = 1;

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
      const store = tx.objectStore('notes');
      const req = store.getAll();
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
      const store = tx.objectStore('notes');
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async saveNote(note) {
    await this.open();
    note.updatedAt = Date.now();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('notes', 'readwrite');
      const store = tx.objectStore('notes');
      const req = store.put(note);
      req.onsuccess = () => resolve(note);
      req.onerror = () => reject(req.error);
    });
  }

  async deleteNote(id) {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('notes', 'readwrite');
      const store = tx.objectStore('notes');
      const req = store.delete(id);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  async getSetting(key, defaultValue = null) {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('settings', 'readonly');
      const store = tx.objectStore('settings');
      const req = store.get(key);
      req.onsuccess = () => {
        if (req.result && req.result.value !== undefined) {
          resolve(req.result.value);
        } else {
          resolve(defaultValue);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  async setSetting(key, value) {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('settings', 'readwrite');
      const store = tx.objectStore('settings');
      const req = store.put({ key, value });
      req.onsuccess = () => resolve(value);
      req.onerror = () => reject(req.error);
    });
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

  async sync(onProgress = () => {}) {
    const { pat, gistId } = await this.getCredentials();
    if (!pat) {
      throw new Error("GitHub PAT (Personal Access Token) が未設定です。設定画面で登録してください。");
    }

    onProgress("ローカルノートの取得中...");
    const localNotes = await this.db.getAllNotes();

    let remoteGist = null;
    let targetGistId = gistId;

    if (targetGistId) {
      onProgress("Gistの最新状態を取得中...");
      const res = await fetch(`https://api.github.com/gists/${targetGistId}`, {
        headers: {
          'Authorization': `token ${pat}`,
          'Accept': 'application/vnd.github.v3+json'
        }
      });

      if (res.status === 404) {
        throw new Error(`指定された Gist ID (${targetGistId}) が見つかりません。`);
      } else if (!res.ok) {
        throw new Error(`Gist 取得エラー: HTTP ${res.status}`);
      }

      remoteGist = await res.json();
    }

    const remoteManifest = remoteGist?.files?.['manifest.json'] 
      ? JSON.parse(remoteGist.files['manifest.json'].content || '{}')
      : { notes: {} };

    onProgress("差分の統合中...");
    const filesToUpload = {};

    // Remote -> Local
    if (remoteGist && remoteGist.files) {
      for (const [filename, fileObj] of Object.entries(remoteGist.files)) {
        if (!filename.endsWith('.md')) continue;
        const noteId = filename.replace(/\.md$/, '');
        const remoteMeta = remoteManifest.notes?.[noteId] || {};
        const local = localNotes.find(n => n.id === noteId);

        if (!local || (remoteMeta.updatedAt && remoteMeta.updatedAt > (local.updatedAt || 0))) {
          const newLocalNote = {
            id: noteId,
            title: remoteMeta.title || fileObj.filename,
            content: fileObj.content || '',
            updatedAt: remoteMeta.updatedAt || Date.now(),
            createdAt: remoteMeta.createdAt || Date.now()
          };
          await this.db.saveNote(newLocalNote);
        }
      }
    }

    // Local -> Remote
    const refreshedLocal = await this.db.getAllNotes();
    for (const note of refreshedLocal) {
      const filename = `${note.id}.md`;
      const remoteMeta = remoteManifest.notes?.[note.id];
      const needsPush = !remoteMeta || (note.updatedAt > (remoteMeta.updatedAt || 0));

      if (needsPush) {
        filesToUpload[filename] = {
          content: note.content || '# ' + note.title
        };
        remoteManifest.notes[note.id] = {
          title: note.title,
          updatedAt: note.updatedAt,
          createdAt: note.createdAt || note.updatedAt
        };
      }
    }

    if (Object.keys(filesToUpload).length > 0 || !remoteGist) {
      filesToUpload['manifest.json'] = {
        content: JSON.stringify(remoteManifest, null, 2)
      };
    }

    if (!targetGistId) {
      onProgress("新規 Gist の作成中...");
      const createRes = await fetch('https://api.github.com/gists', {
        method: 'POST',
        headers: {
          'Authorization': `token ${pat}`,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          description: "Zen Memo Notebook",
          public: false,
          files: filesToUpload
        })
      });

      if (!createRes.ok) throw new Error(`Gist 作成エラー: HTTP ${createRes.status}`);

      const createdGist = await createRes.json();
      targetGistId = createdGist.id;
      await this.db.setSetting('gist_id', targetGistId);
    } else if (Object.keys(filesToUpload).length > 0) {
      onProgress("Gist へ差分アップロード中...");
      const patchRes = await fetch(`https://api.github.com/gists/${targetGistId}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `token ${pat}`,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          description: "Zen Memo Notebook",
          files: filesToUpload
        })
      });

      if (!patchRes.ok) throw new Error(`Gist 更新エラー: HTTP ${patchRes.status}`);
    }

    onProgress("同期完了");
    return { gistId: targetGistId, count: refreshedLocal.length };
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
    if (this.styleTag) {
      this.styleTag.textContent = cssText;
    }
    this.db.setSetting('custom_css', cssText);
  }
}

/* ========================================================
   4. UI Manager (3 Variant Switcher & Mobile Viewport Fix)
   ======================================================== */
class UIManager {
  constructor(app) {
    this.app = app;
    this.currentVariant = 'capsule';
    this.initViewportObserver();
  }

  setVariant(variant) {
    this.currentVariant = variant;
    
    const capsuleEl = document.getElementById('variant-capsule');
    const cornerEl = document.getElementById('variant-corner');
    const sheetEl = document.getElementById('variant-sheet');
    const barEl = document.getElementById('variant-bar');

    if (capsuleEl) capsuleEl.style.display = variant === 'capsule' ? 'flex' : 'none';
    if (cornerEl) cornerEl.style.display = variant === 'sheet' ? 'flex' : 'none';
    if (sheetEl && variant !== 'sheet') sheetEl.classList.remove('open');
    if (barEl) barEl.style.display = variant === 'bar' ? 'flex' : 'none';
  }

  initViewportObserver() {
    if (!window.visualViewport) return;

    const handleResize = () => {
      const keyboardHeight = window.innerHeight - window.visualViewport.height;
      const offset = Math.max(0, keyboardHeight);

      const capsuleEl = document.getElementById('variant-capsule');
      const cornerEl = document.getElementById('variant-corner');
      const barEl = document.getElementById('variant-bar');

      if (capsuleEl) {
        capsuleEl.style.bottom = offset > 0 ? `${offset + 12}px` : 'calc(24px + env(safe-area-inset-bottom))';
      }
      if (cornerEl) {
        cornerEl.style.bottom = offset > 0 ? `${offset + 12}px` : 'calc(24px + env(safe-area-inset-bottom))';
      }
      if (barEl) {
        barEl.style.bottom = offset > 0 ? `${offset}px` : '0px';
      }
    };

    window.visualViewport.addEventListener('resize', handleResize);
    window.visualViewport.addEventListener('scroll', handleResize);
  }

  openDrawer() {
    document.getElementById('drawer-overlay')?.classList.add('open');
    document.getElementById('drawer')?.classList.add('open');
    this.app.renderNotesList();
  }

  closeDrawer() {
    document.getElementById('drawer-overlay')?.classList.remove('open');
    document.getElementById('drawer')?.classList.remove('open');
  }

  toggleSheet() {
    const sheet = document.getElementById('variant-sheet');
    sheet?.classList.toggle('open');
  }

  closeSheet() {
    document.getElementById('variant-sheet')?.classList.remove('open');
  }

  toggleCapsule() {
    const pill = document.getElementById('capsule-pill');
    pill?.classList.toggle('expanded');
  }

  openSettings() {
    this.closeSheet();
    document.getElementById('modal-settings')?.classList.add('open');
  }

  closeSettings() {
    document.getElementById('modal-settings')?.classList.remove('open');
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
      const items = (e.clipboardData || e.originalEvent.clipboardData)?.items;
      if (!items) return;

      for (const item of items) {
        if (item.type.indexOf('image') !== -1) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) {
            await this.processAndInsertImage(file);
          }
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
      alert('画像の読み込みに失敗しました: ' + err.message);
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

          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);

          try {
            const dataUrl = canvas.toDataURL('image/webp', quality);
            if (dataUrl.startsWith('data:image/webp')) {
              return resolve(dataUrl);
            }
          } catch (e) {}

          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = reject;
        img.src = e.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }
}

/* ========================================================
   6. Editor Core (Full Markdown/WYSIWYG Engine)
   ======================================================== */
class ZenEditor {
  constructor(element, options = {}) {
    this.el = element;
    this.options = options;
    this.onChange = options.onChange || (() => {});
    this.onTitleChange = options.onTitleChange || (() => {});
    
    this.init();
  }

  init() {
    this.el.setAttribute('contenteditable', 'true');
    this.el.setAttribute('spellcheck', 'false');

    this.el.addEventListener('input', () => this.handleInput());
    this.el.addEventListener('keydown', (e) => this.handleKeyDown(e));
    this.el.addEventListener('click', (e) => this.handleClick(e));
  }

  handleInput() {
    this.extractAndNotifyTitle();
    this.checkInlineRules();
    this.onChange(this.getMarkdown(), this.getHTML());
  }

  handleKeyDown(e) {
    // 1. Enter Key handling (List continuation/exit, Blockquote exit)
    if (e.key === 'Enter' && !e.shiftKey) {
      const sel = window.getSelection();
      if (sel && sel.anchorNode) {
        const li = sel.anchorNode.nodeType === Node.ELEMENT_NODE && sel.anchorNode.tagName === 'LI'
          ? sel.anchorNode
          : sel.anchorNode.parentElement?.closest('li');

        if (li) {
          // If empty list item, exit list!
          const text = li.textContent.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
          if (text === '') {
            e.preventDefault();
            const parentList = li.closest('ul, ol');
            li.remove();

            const p = document.createElement('p');
            p.innerHTML = '<br>';
            if (parentList) {
              parentList.after(p);
              if (!parentList.querySelector('li')) {
                parentList.remove();
              }
            } else {
              this.el.appendChild(p);
            }
            this.setCursorToEnd(p);
            this.handleInput();
            return;
          }
        }

        // Inside Blockquote
        const bq = sel.anchorNode.parentElement?.closest('blockquote');
        if (bq) {
          const text = bq.textContent.trim();
          if (text === '') {
            e.preventDefault();
            const p = document.createElement('p');
            p.innerHTML = '<br>';
            bq.replaceWith(p);
            this.setCursorToEnd(p);
            this.handleInput();
            return;
          }
        }

        // Inside H1 Title
        const block = this.getClosestBlock(sel.anchorNode);
        if (block && block.tagName === 'H1') {
          setTimeout(() => {
            const currentSel = window.getSelection();
            const currentBlock = this.getClosestBlock(currentSel.anchorNode);
            if (currentBlock && currentBlock.tagName === 'H1' && currentBlock !== this.el.querySelector('h1')) {
              const p = document.createElement('p');
              p.innerHTML = currentBlock.innerHTML || '<br>';
              currentBlock.replaceWith(p);
              this.setCursorToEnd(p);
            }
          }, 0);
        }
      }
    }

    // 2. Backspace Key handling (Exit empty list item or heading to paragraph)
    if (e.key === 'Backspace') {
      const sel = window.getSelection();
      if (sel && sel.isCollapsed && sel.anchorNode) {
        const li = sel.anchorNode.nodeType === Node.ELEMENT_NODE && sel.anchorNode.tagName === 'LI'
          ? sel.anchorNode
          : sel.anchorNode.parentElement?.closest('li');

        if (li && li.textContent.trim() === '') {
          e.preventDefault();
          const parentList = li.closest('ul, ol');
          const p = document.createElement('p');
          p.innerHTML = '<br>';
          li.remove();
          if (parentList) {
            parentList.after(p);
            if (!parentList.querySelector('li')) parentList.remove();
          } else {
            this.el.appendChild(p);
          }
          this.setCursorToEnd(p);
          this.handleInput();
          return;
        }

        const block = this.getClosestBlock(sel.anchorNode);
        if (block && ['H2', 'H3', 'H4', 'BLOCKQUOTE'].includes(block.tagName)) {
          if (block.textContent.trim() === '') {
            e.preventDefault();
            const p = document.createElement('p');
            p.innerHTML = '<br>';
            block.replaceWith(p);
            this.setCursorToEnd(p);
            this.handleInput();
            return;
          }
        }
      }
    }

    // 3. Space Key handling for Block Markdown Shortcuts
    if (e.key === ' ' || e.key === 'Spacebar') {
      if (this.checkBlockInputRule()) {
        e.preventDefault();
        this.extractAndNotifyTitle();
        this.onChange(this.getMarkdown(), this.getHTML());
        return;
      }
    }
  }

  checkBlockInputRule() {
    const sel = window.getSelection();
    if (!sel || !sel.isCollapsed || !sel.anchorNode) return false;

    const node = sel.anchorNode;
    if (node.nodeType !== Node.TEXT_NODE) return false;

    const block = this.getClosestBlock(node);
    if (!block || block === this.el) return false;

    const textBefore = node.textContent.slice(0, sel.anchorOffset);

    // Headings
    if (textBefore === '#') return this.transformBlock(block, 'h1', 1);
    if (textBefore === '##') return this.transformBlock(block, 'h2', 2);
    if (textBefore === '###') return this.transformBlock(block, 'h3', 3);
    if (textBefore === '####') return this.transformBlock(block, 'h4', 4);

    // Lists
    if (textBefore === '-' || textBefore === '*') return this.transformToList(block, 'ul');
    if (textBefore === '1.') return this.transformToList(block, 'ol');

    // Quote
    if (textBefore === '>') return this.transformBlock(block, 'blockquote', 1);

    // Code Block
    if (textBefore === '```') {
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.innerHTML = '<br>';
      pre.appendChild(code);
      block.replaceWith(pre);
      this.setCursorToEnd(code);
      return true;
    }

    // Block Math
    if (textBefore === '$$') return this.transformToMathBlock(block);

    // Horizontal Rule
    if (textBefore === '---') {
      const hr = document.createElement('hr');
      const p = document.createElement('p');
      p.innerHTML = '<br>';
      block.replaceWith(hr, p);
      this.setCursorToEnd(p);
      return true;
    }

    return false;
  }

  /**
   * Inline Markdown Rules: $formula$, **bold**, *italic*, ~~strike~~, `code`
   */
  checkInlineRules() {
    const sel = window.getSelection();
    if (!sel || !sel.isCollapsed || !sel.anchorNode) return;

    const node = sel.anchorNode;
    if (node.nodeType !== Node.TEXT_NODE) return;

    const text = node.textContent;
    const caret = sel.anchorOffset;
    const textBefore = text.slice(0, caret);

    // 1. Inline Math: $formula$
    const mathMatch = textBefore.match(/(^|[^\$])\$([^\$\n]+)\$$/);
    if (mathMatch) {
      const fullMatch = mathMatch[0];
      const formula = mathMatch[2];
      const matchIndex = caret - formula.length - 2;

      this.replaceTextWithElement(node, matchIndex, caret, (container) => {
        const mathEl = this.createInlineMathElement(formula);
        container.appendChild(mathEl);
        const space = document.createTextNode('\u00A0');
        container.appendChild(space);
      });
      return;
    }

    // 2. Inline Bold: **text**
    const boldMatch = textBefore.match(/\*\*([^\*\n]+)\*\*$/);
    if (boldMatch) {
      const word = boldMatch[1];
      const matchIndex = caret - word.length - 4;
      this.replaceTextWithElement(node, matchIndex, caret, (container) => {
        const strong = document.createElement('strong');
        strong.textContent = word;
        container.appendChild(strong);
        container.appendChild(document.createTextNode('\u00A0'));
      });
      return;
    }

    // 3. Inline Strikethrough: ~~text~~
    const strikeMatch = textBefore.match(/~~([^~\n]+)~~$/);
    if (strikeMatch) {
      const word = strikeMatch[1];
      const matchIndex = caret - word.length - 4;
      this.replaceTextWithElement(node, matchIndex, caret, (container) => {
        const del = document.createElement('del');
        del.textContent = word;
        container.appendChild(del);
        container.appendChild(document.createTextNode('\u00A0'));
      });
      return;
    }

    // 4. Inline Code: `code`
    const codeMatch = textBefore.match(/`([^`\n]+)`$/);
    if (codeMatch) {
      const word = codeMatch[1];
      const matchIndex = caret - word.length - 2;
      this.replaceTextWithElement(node, matchIndex, caret, (container) => {
        const code = document.createElement('code');
        code.textContent = word;
        container.appendChild(code);
        container.appendChild(document.createTextNode('\u00A0'));
      });
      return;
    }
  }

  replaceTextWithElement(textNode, startIdx, endIdx, populateCallback) {
    const parent = textNode.parentNode;
    if (!parent) return;

    const fullText = textNode.textContent;
    const beforeText = fullText.slice(0, startIdx);
    const afterText = fullText.slice(endIdx);

    const fragment = document.createDocumentFragment();
    if (beforeText) fragment.appendChild(document.createTextNode(beforeText));

    const span = document.createElement('span');
    populateCallback(span);
    while (span.firstChild) {
      fragment.appendChild(span.firstChild);
    }

    const afterNode = document.createTextNode(afterText);
    fragment.appendChild(afterNode);

    parent.replaceChild(fragment, textNode);
    this.setCursorToEnd(afterNode);
  }

  createInlineMathElement(tex) {
    const wrapper = document.createElement('span');
    wrapper.className = 'math-inline-wrapper';
    wrapper.setAttribute('contenteditable', 'false');
    wrapper.setAttribute('data-tex', tex);

    const katexSpan = document.createElement('span');
    katexSpan.className = 'katex-inline';
    if (window.katex) {
      try {
        window.katex.render(tex, katexSpan, { displayMode: false, throwOnError: false });
      } catch (e) {
        katexSpan.textContent = `$${tex}$`;
      }
    } else {
      katexSpan.textContent = `$${tex}$`;
    }
    wrapper.appendChild(katexSpan);
    return wrapper;
  }

  transformBlock(block, tagName, prefixLength) {
    const newEl = document.createElement(tagName);
    if (tagName === 'h1' && block === this.el.firstElementChild) {
      newEl.classList.add('doc-title');
    }
    const remainingText = block.textContent.slice(prefixLength).trimStart();
    newEl.innerHTML = remainingText ? this.escapeHtml(remainingText) : '<br>';
    block.replaceWith(newEl);
    this.setCursorToEnd(newEl);
    return true;
  }

  transformToList(block, listType) {
    const list = document.createElement(listType);
    const li = document.createElement('li');
    const remainingText = block.textContent.replace(/^([-*]|\d+\.)\s*/, '').trim();
    li.innerHTML = remainingText ? this.escapeHtml(remainingText) : '<br>';
    list.appendChild(li);
    block.replaceWith(list);
    this.setCursorToEnd(li);
    return true;
  }

  transformToMathBlock(block) {
    const tex = prompt("LaTeX数式（ブロック）を入力してください:", "f(x) = \\int_{-\\infty}^\\infty e^{-x^2} dx");
    if (!tex) return false;

    const wrapper = document.createElement('div');
    wrapper.className = 'math-block-wrapper';
    wrapper.setAttribute('contenteditable', 'false');
    wrapper.setAttribute('data-tex', tex);

    const katexContainer = document.createElement('div');
    katexContainer.className = 'katex-display';
    
    if (window.katex) {
      try {
        window.katex.render(tex, katexContainer, { displayMode: true, throwOnError: false });
      } catch (err) {
        katexContainer.textContent = tex;
      }
    } else {
      katexContainer.textContent = tex;
    }

    wrapper.appendChild(katexContainer);

    const nextP = document.createElement('p');
    nextP.innerHTML = '<br>';

    block.replaceWith(wrapper, nextP);
    this.setCursorToEnd(nextP);
    return true;
  }

  // Click handler to edit both block math and inline math
  handleClick(e) {
    const mathBlock = e.target.closest('.math-block-wrapper');
    if (mathBlock) {
      const currentTex = mathBlock.getAttribute('data-tex') || '';
      const newTex = prompt("ブロック数式を編集 (LaTeX):", currentTex);
      if (newTex !== null) {
        if (!newTex.trim()) {
          mathBlock.remove();
        } else {
          mathBlock.setAttribute('data-tex', newTex);
          const katexContainer = mathBlock.querySelector('.katex-display') || mathBlock;
          katexContainer.innerHTML = '';
          if (window.katex) {
            window.katex.render(newTex, katexContainer, { displayMode: true, throwOnError: false });
          }
        }
        this.onChange(this.getMarkdown(), this.getHTML());
      }
      return;
    }

    const mathInline = e.target.closest('.math-inline-wrapper');
    if (mathInline) {
      const currentTex = mathInline.getAttribute('data-tex') || '';
      const newTex = prompt("インライン数式を編集 (LaTeX):", currentTex);
      if (newTex !== null) {
        if (!newTex.trim()) {
          mathInline.remove();
        } else {
          mathInline.setAttribute('data-tex', newTex);
          const katexSpan = mathInline.querySelector('.katex-inline') || mathInline;
          katexSpan.innerHTML = '';
          if (window.katex) {
            window.katex.render(newTex, katexSpan, { displayMode: false, throwOnError: false });
          }
        }
        this.onChange(this.getMarkdown(), this.getHTML());
      }
      return;
    }
  }

  // Heading Toggle (H1-H4 <-> P)
  toggleHeading(level = 2) {
    const sel = window.getSelection();
    if (!sel || !sel.anchorNode) return;

    const block = this.getClosestBlock(sel.anchorNode);
    if (!block) return;

    const targetTag = `H${level}`;
    if (block.tagName === targetTag) {
      // Toggle off -> convert to P
      const p = document.createElement('p');
      p.innerHTML = block.innerHTML;
      block.replaceWith(p);
      this.setCursorToEnd(p);
    } else {
      // Toggle on -> convert to H[level]
      const h = document.createElement(targetTag.toLowerCase());
      if (targetTag === 'H1' && block === this.el.firstElementChild) {
        h.classList.add('doc-title');
      }
      h.innerHTML = block.innerHTML;
      block.replaceWith(h);
      this.setCursorToEnd(h);
    }
    this.extractAndNotifyTitle();
    this.onChange(this.getMarkdown(), this.getHTML());
  }

  // List Toggle (UL / OL <-> P)
  toggleList(type = 'ul') {
    const sel = window.getSelection();
    if (!sel || !sel.anchorNode) return;

    const block = this.getClosestBlock(sel.anchorNode);
    if (!block) return;

    const li = block.tagName === 'LI' ? block : block.closest('li');
    if (li) {
      // Already inside a list item -> toggle off to P
      const list = li.closest('ul, ol');
      const p = document.createElement('p');
      p.innerHTML = li.innerHTML;
      li.remove();
      if (list) {
        list.after(p);
        if (!list.querySelector('li')) list.remove();
      } else {
        this.el.appendChild(p);
      }
      this.setCursorToEnd(p);
    } else {
      // Convert to list
      const list = document.createElement(type);
      const newLi = document.createElement('li');
      newLi.innerHTML = block.innerHTML || '<br>';
      list.appendChild(newLi);
      block.replaceWith(list);
      this.setCursorToEnd(newLi);
    }
    this.onChange(this.getMarkdown(), this.getHTML());
  }

  // Quote Toggle
  toggleQuote() {
    const sel = window.getSelection();
    if (!sel || !sel.anchorNode) return;

    const block = this.getClosestBlock(sel.anchorNode);
    if (!block) return;

    const bq = block.tagName === 'BLOCKQUOTE' ? block : block.closest('blockquote');
    if (bq) {
      const p = document.createElement('p');
      p.innerHTML = bq.innerHTML;
      bq.replaceWith(p);
      this.setCursorToEnd(p);
    } else {
      const newBq = document.createElement('blockquote');
      newBq.innerHTML = block.innerHTML || '<br>';
      block.replaceWith(newBq);
      this.setCursorToEnd(newBq);
    }
    this.onChange(this.getMarkdown(), this.getHTML());
  }

  // Inline Code Toggle
  formatCode() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;

    const range = sel.getRangeAt(0);
    const parentCode = sel.anchorNode.parentElement?.closest('code');
    if (parentCode) {
      // Unwrap code
      const text = parentCode.textContent;
      parentCode.replaceWith(document.createTextNode(text));
    } else if (!range.collapsed) {
      const code = document.createElement('code');
      code.appendChild(range.extractContents());
      range.insertNode(code);
    }
    this.onChange(this.getMarkdown(), this.getHTML());
  }

  extractAndNotifyTitle() {
    let title = "無題のメモ";
    const h1 = this.el.querySelector('h1');
    if (h1 && h1.textContent.trim()) {
      title = h1.textContent.trim();
      if (!h1.classList.contains('doc-title')) {
        h1.classList.add('doc-title');
      }
    }
    this.onTitleChange(title);
    return title;
  }

  getTitle() {
    return this.extractAndNotifyTitle();
  }

  getClosestBlock(node) {
    let curr = node;
    while (curr && curr !== this.el) {
      if (curr.nodeType === Node.ELEMENT_NODE) {
        const display = window.getComputedStyle(curr).display;
        if (display === 'block' || display === 'list-item') return curr;
      }
      curr = curr.parentNode;
    }
    return null;
  }

  setCursorToEnd(el) {
    const range = document.createRange();
    const sel = window.getSelection();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  getHTML() {
    return this.el.innerHTML;
  }

  getMarkdown() {
    let md = '';
    const nodes = Array.from(this.el.children);
    if (nodes.length === 0) return this.el.textContent.trim();

    for (const node of nodes) {
      const tag = node.tagName.toLowerCase();
      if (tag === 'h1') md += `# ${this.convertInlineToMarkdown(node)}\n\n`;
      else if (tag === 'h2') md += `## ${this.convertInlineToMarkdown(node)}\n\n`;
      else if (tag === 'h3') md += `### ${this.convertInlineToMarkdown(node)}\n\n`;
      else if (tag === 'h4') md += `#### ${this.convertInlineToMarkdown(node)}\n\n`;
      else if (tag === 'blockquote') md += `> ${this.convertInlineToMarkdown(node)}\n\n`;
      else if (tag === 'p') {
        const text = node.innerHTML.trim();
        if (text && text !== '<br>') md += `${this.convertInlineToMarkdown(node)}\n\n`;
      } else if (tag === 'ul') {
        for (const li of node.querySelectorAll('li')) md += `- ${this.convertInlineToMarkdown(li)}\n`;
        md += '\n';
      } else if (tag === 'ol') {
        let i = 1;
        for (const li of node.querySelectorAll('li')) md += `${i++}. ${this.convertInlineToMarkdown(li)}\n`;
        md += '\n';
      } else if (tag === 'hr') md += `---\n\n`;
      else if (node.classList.contains('math-block-wrapper')) {
        const tex = node.getAttribute('data-tex') || '';
        md += `$$\n${tex}\n$$\n\n`;
      } else if (tag === 'pre') {
        md += `\`\`\`\n${node.textContent.trim()}\n\`\`\`\n\n`;
      } else if (tag === 'img') {
        const alt = node.getAttribute('alt') || 'image';
        const src = node.getAttribute('src') || '';
        md += `![${alt}](${src})\n\n`;
      } else {
        md += `${this.convertInlineToMarkdown(node)}\n\n`;
      }
    }
    return md.trim();
  }

  convertInlineToMarkdown(node) {
    let clone = node.cloneNode(true);

    // Convert Inline Math wrappers back to $formula$
    clone.querySelectorAll('.math-inline-wrapper').forEach(w => {
      const tex = w.getAttribute('data-tex') || '';
      w.replaceWith(`$${tex}$`);
    });

    let html = clone.innerHTML;
    // Images
    html = html.replace(/<img[^>]*src=["']([^"']+)["'][^>]*alt=["']?([^"'>]*)["']?[^>]*>/gi, '![$2]($1)');
    // Bold
    html = html.replace(/<(b|strong)[^>]*>(.*?)<\/\1>/gi, '**$2**');
    // Italic
    html = html.replace(/<(i|em)[^>]*>(.*?)<\/\1>/gi, '*$2*');
    // Strikethrough
    html = html.replace(/<(del|s)[^>]*>(.*?)<\/\1>/gi, '~~$2~~');
    // Inline Code
    html = html.replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`');

    const temp = document.createElement('div');
    temp.innerHTML = html;
    return temp.textContent || '';
  }

  setContent(markdown) {
    this.el.innerHTML = '';
    const lines = markdown.split('\n');
    let inMath = false;
    let mathBuffer = [];
    let inCode = false;
    let codeBuffer = [];
    let currentList = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Block Math $$ ... $$
      if (line.trim() === '$$') {
        if (!inMath) {
          inMath = true;
          mathBuffer = [];
        } else {
          inMath = false;
          const wrapper = document.createElement('div');
          wrapper.className = 'math-block-wrapper';
          wrapper.setAttribute('contenteditable', 'false');
          const tex = mathBuffer.join('\n');
          wrapper.setAttribute('data-tex', tex);
          const display = document.createElement('div');
          display.className = 'katex-display';
          if (window.katex) {
            try {
              window.katex.render(tex, display, { displayMode: true, throwOnError: false });
            } catch (e) {
              display.textContent = tex;
            }
          } else {
            display.textContent = tex;
          }
          wrapper.appendChild(display);
          this.el.appendChild(wrapper);
        }
        continue;
      }

      if (inMath) {
        mathBuffer.push(line);
        continue;
      }

      // Code Block ``` ... ```
      if (line.trim().startsWith('```')) {
        if (!inCode) {
          inCode = true;
          codeBuffer = [];
        } else {
          inCode = false;
          const pre = document.createElement('pre');
          const code = document.createElement('code');
          code.textContent = codeBuffer.join('\n');
          pre.appendChild(code);
          this.el.appendChild(pre);
        }
        continue;
      }

      if (inCode) {
        codeBuffer.push(line);
        continue;
      }

      // Lists
      const isUl = line.match(/^[-*]\s+(.*)$/);
      const isOl = line.match(/^(\d+)\.\s+(.*)$/);

      if (isUl) {
        if (!currentList || currentList.tagName !== 'UL') {
          currentList = document.createElement('ul');
          this.el.appendChild(currentList);
        }
        const li = document.createElement('li');
        this.renderInlineContent(isUl[1], li);
        currentList.appendChild(li);
        continue;
      } else if (isOl) {
        if (!currentList || currentList.tagName !== 'OL') {
          currentList = document.createElement('ol');
          this.el.appendChild(currentList);
        }
        const li = document.createElement('li');
        this.renderInlineContent(isOl[2], li);
        currentList.appendChild(li);
        continue;
      } else {
        currentList = null;
      }

      if (!line.trim()) continue;

      if (line.startsWith('# ')) {
        const h1 = document.createElement('h1');
        h1.className = 'doc-title';
        this.renderInlineContent(line.replace(/^#\s+/, ''), h1);
        this.el.appendChild(h1);
      } else if (line.startsWith('## ')) {
        const h2 = document.createElement('h2');
        this.renderInlineContent(line.replace(/^##\s+/, ''), h2);
        this.el.appendChild(h2);
      } else if (line.startsWith('### ')) {
        const h3 = document.createElement('h3');
        this.renderInlineContent(line.replace(/^###\s+/, ''), h3);
        this.el.appendChild(h3);
      } else if (line.startsWith('#### ')) {
        const h4 = document.createElement('h4');
        this.renderInlineContent(line.replace(/^####\s+/, ''), h4);
        this.el.appendChild(h4);
      } else if (line.startsWith('> ')) {
        const bq = document.createElement('blockquote');
        this.renderInlineContent(line.replace(/^>\s+/, ''), bq);
        this.el.appendChild(bq);
      } else if (line.match(/^!\[(.*?)\]\((.*?)\)$/)) {
        const m = line.match(/^!\[(.*?)\]\((.*?)\)$/);
        const img = document.createElement('img');
        img.alt = m[1];
        img.src = m[2];
        this.el.appendChild(img);
      } else if (line.trim() === '---') {
        this.el.appendChild(document.createElement('hr'));
      } else {
        const p = document.createElement('p');
        this.renderInlineContent(line, p);
        this.el.appendChild(p);
      }
    }

    this.extractAndNotifyTitle();
  }

  renderInlineContent(text, container) {
    // Parse inline math $...$, bold **..**, italic *..*, strike ~~..~~, code `..`
    const regex = /(\$([^\$\n]+)\$|\*\*([^\*\n]+)\*\*|\*([^\*\n]+)\*|~~([^~\n]+)~~|`([^`\n]+)`)/g;
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        container.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }

      if (match[2]) {
        // Inline Math $formula$
        container.appendChild(this.createInlineMathElement(match[2]));
      } else if (match[3]) {
        // Bold
        const strong = document.createElement('strong');
        strong.textContent = match[3];
        container.appendChild(strong);
      } else if (match[4]) {
        // Italic
        const em = document.createElement('em');
        em.textContent = match[4];
        container.appendChild(em);
      } else if (match[5]) {
        // Strike
        const del = document.createElement('del');
        del.textContent = match[5];
        container.appendChild(del);
      } else if (match[6]) {
        // Code
        const code = document.createElement('code');
        code.textContent = match[6];
        container.appendChild(code);
      }

      lastIndex = regex.lastIndex;
    }

    if (lastIndex < text.length) {
      container.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
  }

  format(cmd, val = null) {
    document.execCommand(cmd, false, val);
    this.onChange(this.getMarkdown(), this.getHTML());
  }

  insertImage(src, alt = 'image') {
    const img = document.createElement('img');
    img.src = src;
    img.alt = alt;
    
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(img);
      const p = document.createElement('p');
      p.innerHTML = '<br>';
      img.after(p);
      this.setCursorToEnd(p);
    } else {
      this.el.appendChild(img);
    }
    this.onChange(this.getMarkdown(), this.getHTML());
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
    this.autoSaveTimer = null;
  }

  async start() {
    await this.db.open();

    this.theme = new ThemeManager(this.db);
    await this.theme.init();

    this.ui = new UIManager(this);
    const savedVariant = await this.db.getSetting('ui_variant', 'capsule');
    this.ui.setVariant(savedVariant);

    this.gistClient = new GistClient(this.db);

    const editorEl = document.getElementById('editor-viewport');
    this.editor = new ZenEditor(editorEl, {
      onChange: (markdown) => this.queueAutoSave(markdown),
      onTitleChange: (title) => this.handleTitleUpdate(title)
    });

    this.imageHandler = new ImageHandler(this.editor);

    this.bindEvents();
    await this.loadInitialNote();
  }

  async loadInitialNote() {
    const notes = await this.db.getAllNotes();
    if (notes.length > 0) {
      await this.openNote(notes[0].id);
    } else {
      await this.createNewNote();
    }
  }

  async openNote(id) {
    const note = await this.db.getNote(id);
    if (!note) return;

    this.currentNote = note;
    this.editor.setContent(note.content || `# ${note.title}\n\n`);
    this.ui.closeDrawer();
  }

  async createNewNote() {
    const newNote = {
      id: 'memo-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: '無題のメモ',
      content: '# 無題のメモ\n\n',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    await this.db.saveNote(newNote);
    this.currentNote = newNote;
    this.editor.setContent(newNote.content);
    this.ui.closeDrawer();
  }

  async deleteCurrentNote() {
    if (!this.currentNote) return;
    if (!confirm(`「${this.currentNote.title}」を削除してもよろしいですか？`)) return;

    await this.db.deleteNote(this.currentNote.id);
    await this.loadInitialNote();
  }

  handleTitleUpdate(title) {
    if (this.currentNote) {
      this.currentNote.title = title;
      document.title = `${title} — Zen Memo`;
    }
  }

  queueAutoSave(markdown) {
    clearTimeout(this.autoSaveTimer);
    this.autoSaveTimer = setTimeout(async () => {
      if (!this.currentNote) return;
      this.currentNote.content = markdown;
      this.currentNote.title = this.editor.getTitle();
      await this.db.saveNote(this.currentNote);
    }, 400);
  }

  async renderNotesList() {
    const listEl = document.getElementById('memo-list');
    if (!listEl) return;

    const notes = await this.db.getAllNotes();
    listEl.innerHTML = '';

    notes.forEach((note) => {
      const li = document.createElement('li');
      li.className = 'memo-item' + (this.currentNote?.id === note.id ? ' active' : '');
      
      const dateStr = new Date(note.updatedAt).toLocaleDateString('ja-JP', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });

      li.innerHTML = `
        <div class="memo-item-title">${this.editor.escapeHtml(note.title || '無題のメモ')}</div>
        <div class="memo-item-meta">${dateStr}</div>
      `;

      li.onclick = () => this.openNote(note.id);
      listEl.appendChild(li);
    });
  }

  bindEvents() {
    window.openDrawer = () => this.ui.openDrawer();
    window.closeDrawer = () => this.ui.closeDrawer();
    window.createNewNote = () => this.createNewNote();
    window.deleteCurrentNote = () => this.deleteCurrentNote();

    window.toggleCapsule = () => this.ui.toggleCapsule();
    window.toggleSheet = () => this.ui.toggleSheet();
    window.openSettings = () => this.openSettings();
    window.closeSettings = () => this.ui.closeSettings();

    window.cmdBold = () => this.editor.format('bold');
    window.cmdItalic = () => this.editor.format('italic');
    window.cmdStrike = () => this.editor.format('strikeThrough');
    window.cmdCode = () => this.editor.formatCode();
    window.cmdH2 = () => this.editor.toggleHeading(2);
    window.cmdH3 = () => this.editor.toggleHeading(3);
    window.cmdListUl = () => this.editor.toggleList('ul');
    window.cmdListOl = () => this.editor.toggleList('ol');
    window.cmdQuote = () => this.editor.toggleQuote();
    window.cmdMath = () => {
      const tex = prompt("数式を入力してください (LaTeX):", "x = 1");
      if (tex && window.katex) {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) {
          // Wrap selected text or insert inline
          const inlineEl = this.editor.createInlineMathElement(tex);
          const range = sel.getRangeAt(0);
          range.deleteContents();
          range.insertNode(inlineEl);
        } else {
          // Insert block or inline
          const wrapper = document.createElement('div');
          wrapper.className = 'math-block-wrapper';
          wrapper.setAttribute('contenteditable', 'false');
          wrapper.setAttribute('data-tex', tex);
          const display = document.createElement('div');
          display.className = 'katex-display';
          window.katex.render(tex, display, { displayMode: true });
          wrapper.appendChild(display);

          if (sel && sel.rangeCount > 0) {
            const range = sel.getRangeAt(0);
            range.insertNode(wrapper);
          } else {
            this.editor.el.appendChild(wrapper);
          }
        }
        this.editor.onChange(this.editor.getMarkdown(), this.editor.getHTML());
      }
    };
    window.cmdImage = () => this.imageHandler.pickImage();

    window.triggerSync = async () => {
      try {
        const result = await this.gistClient.sync((msg) => {
          console.log(`[Sync] ${msg}`);
        });
        alert(`☁️ Gist との同期が完了しました！\nGist ID: ${result.gistId}\n同期ノート数: ${result.count} 件`);
        await this.renderNotesList();
      } catch (err) {
        alert(`❌ 同期失敗: ${err.message}`);
      }
    };
  }

  async openSettings() {
    const pat = await this.db.getSetting('github_pat', '');
    const gistId = await this.db.getSetting('gist_id', '');
    const activeTheme = await this.db.getSetting('active_theme', 'paper');
    const activeUI = await this.db.getSetting('ui_variant', 'capsule');
    const customCss = await this.db.getSetting('custom_css', '');

    document.getElementById('input-pat').value = pat;
    document.getElementById('input-gist-id').value = gistId;
    document.getElementById('select-theme').value = activeTheme;
    document.getElementById('select-ui-variant').value = activeUI;
    document.getElementById('textarea-custom-css').value = customCss;

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
    await this.db.setSetting('active_theme', activeTheme);
    await this.db.setSetting('ui_variant', activeUI);
    await this.db.setSetting('custom_css', customCss);

    this.theme.setTheme(activeTheme);
    this.theme.setCustomCss(customCss);
    this.ui.setVariant(activeUI);

    this.ui.closeSettings();
  }
}

// Bootstrap
window.addEventListener('DOMContentLoaded', () => {
  window.app = new ZenApp();
  window.app.start();
  window.saveSettings = () => window.app.saveSettings();
});