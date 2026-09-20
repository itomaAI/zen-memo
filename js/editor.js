/**
 * Zen Memo - Editor Core (Full Markdown/WYSIWYG Engine)
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

  toggleHeading(level = 2) {
    const sel = window.getSelection();
    if (!sel || !sel.anchorNode) return;

    const block = this.getClosestBlock(sel.anchorNode);
    if (!block) return;

    const targetTag = `H${level}`;
    if (block.tagName === targetTag) {
      const p = document.createElement('p');
      p.innerHTML = block.innerHTML;
      block.replaceWith(p);
      this.setCursorToEnd(p);
    } else {
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

  toggleList(type = 'ul') {
    const sel = window.getSelection();
    if (!sel || !sel.anchorNode) return;

    const block = this.getClosestBlock(sel.anchorNode);
    if (!block) return;

    const li = block.tagName === 'LI' ? block : block.closest('li');
    if (li) {
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
      const list = document.createElement(type);
      const newLi = document.createElement('li');
      newLi.innerHTML = block.innerHTML || '<br>';
      list.appendChild(newLi);
      block.replaceWith(list);
      this.setCursorToEnd(newLi);
    }
    this.onChange(this.getMarkdown(), this.getHTML());
  }

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

  formatCode() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;

    const range = sel.getRangeAt(0);
    const parentCode = sel.anchorNode.parentElement?.closest('code');
    if (parentCode) {
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

    clone.querySelectorAll('.math-inline-wrapper').forEach(w => {
      const tex = w.getAttribute('data-tex') || '';
      w.replaceWith(`$${tex}$`);
    });

    let html = clone.innerHTML;
    html = html.replace(/<img[^>]*src=["']([^"']+)["'][^>]*alt=["']?([^"'>]*)["']?[^>]*>/gi, '![$2]($1)');
    html = html.replace(/<(b|strong)[^>]*>(.*?)<\/\1>/gi, '**$2**');
    html = html.replace(/<(i|em)[^>]*>(.*?)<\/\1>/gi, '*$2*');
    html = html.replace(/<(del|s)[^>]*>(.*?)<\/\1>/gi, '~~$2~~');
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
    const regex = /(\$([^\$\n]+)\$|\*\*([^\*\n]+)\*\*|\*([^\*\n]+)\*|~~([^~\n]+)~~|`([^`\n]+)`)/g;
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        container.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }

      if (match[2]) {
        container.appendChild(this.createInlineMathElement(match[2]));
      } else if (match[3]) {
        const strong = document.createElement('strong');
        strong.textContent = match[3];
        container.appendChild(strong);
      } else if (match[4]) {
        const em = document.createElement('em');
        em.textContent = match[4];
        container.appendChild(em);
      } else if (match[5]) {
        const del = document.createElement('del');
        del.textContent = match[5];
        container.appendChild(del);
      } else if (match[6]) {
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