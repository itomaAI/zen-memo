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