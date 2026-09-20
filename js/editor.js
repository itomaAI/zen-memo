/**
 * Zen Memo - Robust Tiptap & KaTeX Editor Engine
 * AST-based Markdown serialization with zero layout drift or newline inflation.
 */

import { Editor, Node as TiptapNode, mergeAttributes } from 'https://esm.sh/@tiptap/core@2.2.4';
import StarterKit from 'https://esm.sh/@tiptap/starter-kit@2.2.4';
import TaskList from 'https://esm.sh/@tiptap/extension-task-list@2.2.4';
import TaskItem from 'https://esm.sh/@tiptap/extension-task-item@2.2.4';
import ImageExt from 'https://esm.sh/@tiptap/extension-image@2.2.4';
import { Markdown } from 'https://esm.sh/tiptap-markdown@0.8.10';

// Custom Node: Inline Math ($formula$)
const InlineMath = TiptapNode.create({
  name: 'inlineMath',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return {
      tex: { default: '' }
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-katex-inline]',
        getAttrs: el => ({ tex: el.getAttribute('data-tex') || '' })
      }
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, {
      'data-katex-inline': '',
      'data-tex': HTMLAttributes.tex,
      class: 'math-inline-wrapper'
    }), `$${HTMLAttributes.tex}$`];
  },

  addNodeView() {
    return ({ node, getPos }) => {
      const dom = document.createElement('span');
      dom.className = 'math-inline-wrapper';
      dom.setAttribute('data-tex', node.attrs.tex);
      dom.setAttribute('contenteditable', 'false');

      const renderFormula = () => {
        dom.innerHTML = '';
        if (window.katex) {
          try {
            window.katex.render(node.attrs.tex, dom, { displayMode: false, throwOnError: false });
          } catch (e) {
            dom.textContent = `$${node.attrs.tex}$`;
          }
        } else {
          dom.textContent = `$${node.attrs.tex}$`;
        }
      };
      renderFormula();

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
        },
        parse: {
          // Handled via text scanning on load
        }
      }
    };
  }
});

// Custom Node: Block Math ($$\n...\n$$)
const BlockMath = TiptapNode.create({
  name: 'blockMath',
  group: 'block',
  atom: true,

  addAttributes() {
    return {
      tex: { default: '' }
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-katex-block]',
        getAttrs: el => ({ tex: el.getAttribute('data-tex') || '' })
      }
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, {
      'data-katex-block': '',
      'data-tex': HTMLAttributes.tex,
      class: 'math-block-wrapper'
    })];
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

export class ZenEditor {
  constructor(element, options = {}) {
    this.el = element;
    this.options = options;
    this.onChange = options.onChange || (() => {});
    this.onTitleChange = options.onTitleChange || (() => {});

    this.tiptap = null;
    this.init();
  }

  init() {
    this.tiptap = new Editor({
      element: this.el,
      extensions: [
        StarterKit.configure({
          heading: {
            levels: [1, 2, 3, 4]
          }
        }),
        TaskList,
        TaskItem.configure({
          nested: true
        }),
        ImageExt.configure({
          allowBase64: true
        }),
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
    this.tiptap.state.doc.descendants((node) => {
      if (node.type.name === 'heading' && node.attrs.level === 1) {
        const text = node.textContent.trim();
        if (text) {
          title = text;
          return false; // stop traversal
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
    // Pre-process math blocks and inline math into clean tags for Tiptap
    let processed = markdown || '# 無題のメモ\n\n';

    // Convert $$...$$ block math to html tags for Tiptap
    processed = processed.replace(/\$\$\n*([\s\S]*?)\n*\$\$/g, (m, tex) => {
      return `<div data-katex-block="" data-tex="${this.escapeAttr(tex.trim())}"></div>`;
    });

    // Convert $formula$ inline math to html tags
    processed = processed.replace(/(^|[^\$])\$([^\$\n]+)\$/g, (m, prefix, tex) => {
      return `${prefix}<span data-katex-inline="" data-tex="${this.escapeAttr(tex.trim())}"></span>`;
    });

    this.tiptap.commands.setContent(processed);
    this.extractAndNotifyTitle();
  }

  escapeAttr(str) {
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Toolbar action helpers
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
      this.tiptap.chain().focus().insertContent({
        type: 'blockMath',
        attrs: { tex }
      }).run();
    } else {
      this.tiptap.chain().focus().insertContent({
        type: 'inlineMath',
        attrs: { tex }
      }).run();
    }
  }

  destroy() {
    if (this.tiptap) this.tiptap.destroy();
  }
}