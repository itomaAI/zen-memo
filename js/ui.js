/**
 * Zen Memo - UI Manager (3 Variant Switcher, Mobile Viewport Keyboard Fix, Drawer, Modals)
 */

export class UIManager {
  constructor(app) {
    this.app = app;
    this.currentVariant = 'capsule'; // 'capsule' | 'sheet' | 'bar'
    this.initViewportObserver();
  }

  setVariant(variant) {
    this.currentVariant = variant;
    
    // Toggle DOM wrappers
    const capsuleEl = document.getElementById('variant-capsule');
    const cornerEl = document.getElementById('variant-corner');
    const sheetEl = document.getElementById('variant-sheet');
    const barEl = document.getElementById('variant-bar');

    if (capsuleEl) capsuleEl.style.display = variant === 'capsule' ? 'flex' : 'none';
    if (cornerEl) cornerEl.style.display = variant === 'sheet' ? 'flex' : 'none';
    if (sheetEl && variant !== 'sheet') sheetEl.classList.remove('open');
    if (barEl) barEl.style.display = variant === 'bar' ? 'flex' : 'none';
  }

  /**
   * Handle Mobile Keyboard via window.visualViewport
   * Brings toolbars smoothly above virtual keyboard without clipping.
   */
  initViewportObserver() {
    const appContainer = document.getElementById('app-container');

    const updateLayout = () => {
      if (window.scrollY !== 0 || window.scrollX !== 0) {
        window.scrollTo(0, 0);
      }

      if (!window.visualViewport) return;
      const vv = window.visualViewport;

      if (appContainer) {
        appContainer.style.height = `${vv.height}px`;
        appContainer.style.top = `${vv.offsetTop}px`;
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

  // Drawer Controls
  openDrawer() {
    document.getElementById('drawer-overlay')?.classList.add('open');
    document.getElementById('drawer')?.classList.add('open');
    this.app.renderNotesList();
  }

  closeDrawer() {
    document.getElementById('drawer-overlay')?.classList.remove('open');
    document.getElementById('drawer')?.classList.remove('open');
  }

  // Bottom Sheet (Variant B) Controls
  toggleSheet() {
    const sheet = document.getElementById('variant-sheet');
    sheet?.classList.toggle('open');
  }

  closeSheet() {
    document.getElementById('variant-sheet')?.classList.remove('open');
  }

  // Capsule Expand/Collapse (Variant A)
  toggleCapsule() {
    const pill = document.getElementById('capsule-pill');
    pill?.classList.toggle('expanded');
  }

  // Settings Modal Controls
  openSettings() {
    this.closeSheet();
    document.getElementById('modal-settings')?.classList.add('open');
  }

  closeSettings() {
    document.getElementById('modal-settings')?.classList.remove('open');
  }
}