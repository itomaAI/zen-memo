/**
 * Zen Memo - Editor Core (WYSIWYG, Markdown Shortcuts, KaTeX, Title Binding)
 */

export class ZenEditor {
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

    // Bind event listeners
    this.el.addEventListener('input', (e) => this.handleInput(e));
    this.el.addEventListener('keydown', (e) => this.handleKeyDown(e));
    this.el.addEventListener('click', (e) => this.handleClick(e));

    // Ensure document has at least a title H1 and an empty paragraph if blank
    if (!this.el.innerHTML.trim()) {
      this.setContent('# 無題のメモ\n\n');
    }
  }

  handleInput(e) {
    this.extractAndNotifyTitle();
    this.onChange(this.getMarkdown(), this.getHTML());
  }

  handleKeyDown(e) {
    // Check for space key to trigger Markdown input rules
    if (e.key === ' ' || e.key === 'Spacebar') {
      if (this.checkInputRule()) {
        e.preventDefault();
        this.extractAndNotifyTitle();
        this.onChange(this.getMarkdown(), this.getHTML());
        return;
      }
    }

    // Handle Enter key inside blocks
    if (e.key === 'Enter') {
      // If pressing enter in H1 title, create normal paragraph
      const sel = window.getSelection();
      if (sel && sel.anchorNode) {
        const block = this.getClosestBlock(sel.anchorNode);
        if (block && block.tagName === 'H1') {
          // Let browser create next element or ensure it's p
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
  }

  /**
   * Markdown Input Rules (e.g. ## -> H2, - -> UL, > -> Blockquote, $$ -> Math)
   */
  checkInputRule() {
    const sel = window.getSelection();
    if (!sel || !sel.isCollapsed || !sel.anchorNode) return false;

    const node = sel.anchorNode;
    if (node.nodeType !== Node.TEXT_NODE) return false;

    const block = this.getClosestBlock(node);
    if (!block || block === this.el) return false;

    const textBefore = node.textContent.slice(0, sel.anchorOffset);

    // Rule: '## ' -> H2
    if (textBefore === '##') {
      return this.transformBlock(block, 'h2', 2);
    }
    // Rule: '### ' -> H3
    if (textBefore === '###') {
      return this.transformBlock(block, 'h3', 3);
    }
    // Rule: '# ' -> H1 (if needed)
    if (textBefore === '#') {
      return this.transformBlock(block, 'h1', 1);
    }
    // Rule: '- ' or '* ' -> UL LI
    if (textBefore === '-' || textBefore === '*') {
      return this.transformToList(block, 'ul');
    }
    // Rule: '1. ' -> OL LI
    if (textBefore === '1.') {
      return this.transformToList(block, 'ol');
    }
    // Rule: '> ' -> Blockquote
    if (textBefore === '>') {
      return this.transformBlock(block, 'blockquote', 1);
    }
    // Rule: '$$' -> KaTeX Math Block
    if (textBefore === '$$') {
      return this.transformToMathBlock(block);
    }
    // Rule: '---' -> Horizontal Rule
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

  transformBlock(block, tagName, prefixLength) {
    const newEl = document.createElement(tagName);
    if (tagName === 'h1' && block === this.el.firstElementChild) {
      newEl.classList.add('doc-title');
    }
    // Remove the markdown prefix
    const remainingText = block.textContent.slice(prefixLength).trimStart();
    newEl.innerHTML = remainingText ? this.escapeHtml(remainingText) : '<br>';
    block.replaceWith(newEl);
    this.setCursorToEnd(newEl);
    return true;
  }

  transformToList(block, listType) {
    const list = document.createElement(listType);
    const li = document.createElement('li');
    li.innerHTML = '<br>';
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

  handleClick(e) {
    // Click on Math block to edit formula
    const mathWrapper = e.target.closest('.math-block-wrapper');
    if (mathWrapper) {
      const currentTex = mathWrapper.getAttribute('data-tex') || '';
      const newTex = prompt("数式を編集:", currentTex);
      if (newTex !== null) {
        if (!newTex.trim()) {
          mathWrapper.remove();
        } else {
          mathWrapper.setAttribute('data-tex', newTex);
          const katexContainer = mathWrapper.querySelector('.katex-display') || mathWrapper;
          katexContainer.innerHTML = '';
          if (window.katex) {
            window.katex.render(newTex, katexContainer, { displayMode: true, throwOnError: false });
          }
        }
        this.onChange(this.getMarkdown(), this.getHTML());
      }
    }
  }

  /**
   * Title Extraction: The very first H1 element is the title
   */
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
        if (display === 'block' || display === 'list-item') {
          return curr;
        }
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

  /**
   * Serialize ContentEditable DOM to Standard Markdown
   */
  getMarkdown() {
    let md = '';
    const nodes = Array.from(this.el.children);
    
    // If empty
    if (nodes.length === 0) {
      return this.el.textContent.trim();
    }

    for (const node of nodes) {
      const tag = node.tagName.toLowerCase();
      if (tag === 'h1') {
        md += `# ${node.textContent.trim()}\n\n`;
      } else if (tag === 'h2') {
        md += `## ${node.textContent.trim()}\n\n`;
      } else if (tag === 'h3') {
        md += `### ${node.textContent.trim()}\n\n`;
      } else if (tag === 'blockquote') {
        md += `> ${node.textContent.trim()}\n\n`;
      } else if (tag === 'p') {
        const text = node.innerHTML.trim();
        if (text && text !== '<br>') {
          md += `${this.convertInlineToMarkdown(node)}\n\n`;
        }
      } else if (tag === 'ul') {
        for (const li of node.querySelectorAll('li')) {
          md += `- ${li.textContent.trim()}\n`;
        }
        md += '\n';
      } else if (tag === 'ol') {
        let i = 1;
        for (const li of node.querySelectorAll('li')) {
          md += `${i++}. ${li.textContent.trim()}\n`;
        }
        md += '\n';
      } else if (tag === 'hr') {
        md += `---\n\n`;
      } else if (node.classList.contains('math-block-wrapper')) {
        const tex = node.getAttribute('data-tex') || '';
        md += `$$\n${tex}\n$$\n\n`;
      } else if (tag === 'img') {
        const alt = node.getAttribute('alt') || 'image';
        const src = node.getAttribute('src') || '';
        md += `![${alt}](${src})\n\n`;
      } else {
        md += `${node.textContent.trim()}\n\n`;
      }
    }

    return md.trim();
  }

  convertInlineToMarkdown(node) {
    let html = node.innerHTML;
    // Images inside p
    html = html.replace(/<img[^>]*src=["']([^"']+)["'][^>]*alt=["']?([^"'>]*)["']?[^>]*>/gi, '![$2]($1)');
    // Bold
    html = html.replace(/<(b|strong)[^>]*>(.*?)<\/\1>/gi, '**$2**');
    // Italic
    html = html.replace(/<(i|em)[^>]*>(.*?)<\/\1>/gi, '*$2*');
    // Code
    html = html.replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`');
    // Clean remaining tags
    const temp = document.createElement('div');
    temp.innerHTML = html;
    return temp.textContent || '';
  }

  /**
   * Load Markdown into WYSIWYG ContentEditable
   */
  setContent(markdown) {
    this.el.innerHTML = '';
    const lines = markdown.split('\n');
    let inMath = false;
    let mathBuffer = [];
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

      // Check List continuity
      const isUl = line.match(/^[-*]\s+(.*)$/);
      const isOl = line.match(/^(\d+)\.\s+(.*)$/);

      if (isUl) {
        if (!currentList || currentList.tagName !== 'UL') {
          currentList = document.createElement('ul');
          this.el.appendChild(currentList);
        }
        const li = document.createElement('li');
        li.textContent = isUl[1];
        currentList.appendChild(li);
        continue;
      } else if (isOl) {
        if (!currentList || currentList.tagName !== 'OL') {
          currentList = document.createElement('ol');
          this.el.appendChild(currentList);
        }
        const li = document.createElement('li');
        li.textContent = isOl[2];
        currentList.appendChild(li);
        continue;
      } else {
        currentList = null;
      }

      if (!line.trim()) continue;

      // H1 (Title)
      if (line.startsWith('# ')) {
        const h1 = document.createElement('h1');
        h1.className = 'doc-title';
        h1.textContent = line.replace(/^#\s+/, '');
        this.el.appendChild(h1);
      }
      // H2
      else if (line.startsWith('## ')) {
        const h2 = document.createElement('h2');
        h2.textContent = line.replace(/^##\s+/, '');
        this.el.appendChild(h2);
      }
      // H3
      else if (line.startsWith('### ')) {
        const h3 = document.createElement('h3');
        h3.textContent = line.replace(/^###\s+/, '');
        this.el.appendChild(h3);
      }
      // Blockquote
      else if (line.startsWith('> ')) {
        const bq = document.createElement('blockquote');
        bq.textContent = line.replace(/^>\s+/, '');
        this.el.appendChild(bq);
      }
      // Image ![alt](url)
      else if (line.match(/^!\[(.*?)\]\((.*?)\)$/)) {
        const m = line.match(/^!\[(.*?)\]\((.*?)\)$/);
        const img = document.createElement('img');
        img.alt = m[1];
        img.src = m[2];
        this.el.appendChild(img);
      }
      // HR
      else if (line.trim() === '---') {
        this.el.appendChild(document.createElement('hr'));
      }
      // Normal paragraph
      else {
        const p = document.createElement('p');
        p.textContent = line;
        this.el.appendChild(p);
      }
    }

    // Ensure title exists
    this.extractAndNotifyTitle();
  }

  // Formatting helpers
  format(cmd, val = null) {
    document.execCommand(cmd, false, val);
  }

  insertHeading(level = 2) {
    document.execCommand('formatBlock', false, `<h${level}>`);
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