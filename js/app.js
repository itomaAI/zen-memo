/**
 * Zen Memo - Unified Application Core (Tiptap + KaTeX Powered)
 * Standalone, zero-build, static-hosted WYSIWYG note-taking web app.
 * Full AST-based Markdown serialization with zero layout drift or newline inflation.
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
    const appContainer = document.getElementById('app-container');

    const updateLayout = () => {
      if (window.scrollY !== 0 || window.scrollX !== 0) {
        window.scrollTo(0, 0);
      }

      if (!window.visualViewport) return;
      const vv = window.visualViewport;

      if (appContainer) {
        if (Math.abs(window.innerHeight - vv.height) > 10) {
          appContainer.style.height = `${vv.height}px`;
        } else {
          appContainer.style.height = '100%';
        }
        appContainer.style.top = '0px';
      }
    };

    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', updateLayout);
      window.visualViewport.addEventListener('scroll', updateLayout);
    }
    window.addEventListener('scroll', () => {
      if (window.scrollY !== 0 || window.scrollX !== 0) {
        window.scrollTo(0, 0);
      }
    });

    updateLayout();
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
      import('https://esm.sh/@tiptap/core@2.2.4'),
      import('https://esm.sh/@tiptap/starter-kit@2.2.4'),
      import('https://esm.sh/@tiptap/extension-task-list@2.2.4'),
      import('https://esm.sh/@tiptap/extension-task-item@2.2.4'),
      import('https://esm.sh/@tiptap/extension-image@2.2.4'),
      import('https://esm.sh/tiptap-markdown@0.8.10')
    ]);

    const self = this;

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
        return [{ tag: 'span[data-katex-inline]', getAttrs: el => ({ tex: el.getAttribute('data-tex') || '' }) }];
      },
      renderHTML({ HTMLAttributes }) {
        return ['span', mergeAttributes(HTMLAttributes, { 'data-katex-inline': '', 'data-tex': HTMLAttributes.tex, class: 'math-inline-wrapper' }), `$${HTMLAttributes.tex}$`];
      },
      addNodeView() {
        return ({ node, getPos }) => {
          const dom = document.createElement('span');
          dom.className = 'math-inline-wrapper';
          dom.setAttribute('data-tex', node.attrs.tex);
          dom.setAttribute('contenteditable', 'false');

          if (window.katex) {
            try {
              window.katex.render(node.attrs.tex, dom, { displayMode: false, throwOnError: false });
            } catch (e) {
              dom.textContent = `$${node.attrs.tex}$`;
            }
          } else {
            dom.textContent = `$${node.attrs.tex}$`;
          }

          dom.addEventListener('click', () => {
            const newTex = prompt("インライン数式を編集 (LaTeX):", node.attrs.tex);
            if (newTex !== null) {
              if (!newTex.trim()) {
                this.editor.commands.deleteRange({ from: getPos(), to: getPos() + 1 });
              } else {
                this.editor.chain().setNodeSelection(getPos()).command(({ tr }) => {
                  tr.setNodeMarkup(getPos(), undefined, { tex: newTex });
                  return true;
                }).run();
              }
            }
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
        return [{ tag: 'div[data-katex-block]', getAttrs: el => ({ tex: el.getAttribute('data-tex') || '' }) }];
      },
      renderHTML({ HTMLAttributes }) {
        return ['div', mergeAttributes(HTMLAttributes, { 'data-katex-block': '', 'data-tex': HTMLAttributes.tex, class: 'math-block-wrapper' })];
      },
      addNodeView() {
        return ({ node, getPos }) => {
          const dom = document.createElement('div');
          dom.className = 'math-block-wrapper';
          dom.setAttribute('data-tex', node.attrs.tex);
          dom.setAttribute('contenteditable', 'false');

          const display = document.createElement('div');
          display.className = 'katex-display';
          if (window.katex) {
            try {
              window.katex.render(node.attrs.tex, display, { displayMode: true, throwOnError: false });
            } catch (e) {
              display.textContent = node.attrs.tex;
            }
          } else {
            display.textContent = node.attrs.tex;
          }
          dom.appendChild(display);

          dom.addEventListener('click', () => {
            const newTex = prompt("ブロック数式を編集 (LaTeX):", node.attrs.tex);
            if (newTex !== null) {
              if (!newTex.trim()) {
                this.editor.commands.deleteRange({ from: getPos(), to: getPos() + 1 });
              } else {
                this.editor.chain().setNodeSelection(getPos()).command(({ tr }) => {
                  tr.setNodeMarkup(getPos(), undefined, { tex: newTex });
                  return true;
                }).run();
              }
            }
          });

          return { dom };
        };
      },
      addStorage() {
        return {
          markdown: {
            serialize(state, node) {
              state.write(`$$\n${node.attrs.tex}\n$$\n\n`);
            }
          }
        };
      }
    });

    this.tiptap = new Editor({
      element: this.el,
      extensions: [
        StarterKit.configure({
          heading: { levels: [1, 2, 3, 4] }
        }),
        TaskList,
        TaskItem.configure({ nested: true }),
        ImageExt.configure({ allowBase64: true }),
        InlineMath,
        BlockMath,
        Markdown.configure({
          html: true,
          tightLists: true,
          bulletListMarker: '-'
        })
      ],
      content: '',
      onUpdate: () => {
        this.extractAndNotifyTitle();
        this.onChange(this.getMarkdown(), this.getHTML());
      },
      onSelectionUpdate: () => {
        this.extractAndNotifyTitle();
      }
    });

    // Support typing $formula$ inline
    this.el.addEventListener('keyup', (e) => {
      if (e.key === '$' || e.key === ' ' || e.key === 'Spacebar') {
        this.checkInlineMathInput();
      }
    });
  }

  checkInlineMathInput() {
    const sel = this.tiptap.state.selection;
    if (!sel.empty) return;

    const from = Math.max(0, sel.from - 80);
    const textBefore = this.tiptap.state.doc.textBetween(from, sel.from, '\n', '\0');
    const match = textBefore.match(/(^|[^\$])\$([^\$\n]+)\$$/);

    if (match) {
      const formula = match[2];
      const matchStart = sel.from - formula.length - 2;
      this.tiptap.chain()
        .deleteRange({ from: matchStart, to: sel.from })
        .insertContent({ type: 'inlineMath', attrs: { tex: formula } })
        .insertContent(' ')
        .run();
    }
  }

  extractAndNotifyTitle() {
    let title = "無題のメモ";
    if (!this.tiptap) return title;

    this.tiptap.state.doc.descendants((node) => {
      if (node.type.name === 'heading' && node.attrs.level === 1) {
        const text = node.textContent.trim();
        if (text) {
          title = text;
          return false;
        }
      }
      return true;
    });

    this.onTitleChange(title);
    return title;
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

  setContent(markdown) {
    let processed = markdown || '# 無題のメモ\n\n';

    processed = processed.replace(/\$\$\n*([\s\S]*?)\n*\$\$/g, (m, tex) => {
      return `<div data-katex-block="" data-tex="${this.escapeAttr(tex.trim())}"></div>`;
    });

    processed = processed.replace(/(^|[^\$])\$([^\$\n]+)\$/g, (m, prefix, tex) => {
      return `${prefix}<span data-katex-inline="" data-tex="${this.escapeAttr(tex.trim())}"></span>`;
    });

    this.tiptap.commands.setContent(processed);
    this.extractAndNotifyTitle();
  }

  escapeAttr(str) {
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  toggleHeading(level) {
    this.tiptap.chain().focus().toggleHeading({ level }).run();
  }

  toggleList(type) {
    if (type === 'ul') {
      this.tiptap.chain().focus().toggleBulletList().run();
    } else {
      this.tiptap.chain().focus().toggleOrderedList().run();
    }
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
    this.tiptap.chain().focus().setImage({ src, alt }).run();
  }

  insertMath(tex = 'x = 1', isBlock = false) {
    if (isBlock) {
      this.tiptap.chain().focus().insertContent({ type: 'blockMath', attrs: { tex } }).run();
    } else {
      this.tiptap.chain().focus().insertContent({ type: 'inlineMath', attrs: { tex } }).run();
    }
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

    await this.editor.init();
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
        <div class="memo-item-title">${this.escapeHtml(note.title || '無題のメモ')}</div>
        <div class="memo-item-meta">${dateStr}</div>
      `;

      li.onclick = () => this.openNote(note.id);
      listEl.appendChild(li);
    });
  }

  escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
    window.cmdTask = () => this.editor.toggleTask();
    window.cmdQuote = () => this.editor.toggleQuote();
    window.cmdMath = () => {
      const tex = prompt("数式を入力してください (LaTeX):", "x = 1");
      if (tex) this.editor.insertMath(tex, false);
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
window.addEventListener('DOMContentLoaded', async () => {
  window.app = new ZenApp();
  await window.app.start();
  window.saveSettings = () => window.app.saveSettings();
});