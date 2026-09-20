/**
 * Zen Memo - Theme & Custom CSS Manager
 */

export class ThemeManager {
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