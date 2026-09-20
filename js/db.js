/**
 * Zen Memo - IndexedDB Client (Local-First Persistence)
 */

const DB_NAME = 'zen_memo_db';
const DB_VERSION = 1;

export class ZenDB {
  constructor() {
    this.db = null;
  }

  async open() {
    if (this.db) return this.db;

    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (e) => {
        const db = e.target.result;

        // Notes Store
        if (!db.objectStoreNames.contains('notes')) {
          const notesStore = db.createObjectStore('notes', { keyPath: 'id' });
          notesStore.createIndex('updatedAt', 'updatedAt', { unique: false });
        }

        // Settings Store (PAT, GistID, Theme, UI variant, Custom CSS)
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      };

      req.onsuccess = (e) => {
        this.db = e.target.result;
        resolve(this.db);
      };

      req.onerror = (e) => {
        reject(e.target.error);
      };
    });
  }

  /* --- Notes CRUD --- */

  async getAllNotes() {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('notes', 'readonly');
      const store = tx.objectStore('notes');
      const req = store.getAll();
      req.onsuccess = () => {
        // Sort by updatedAt descending
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

  /* --- Settings KV --- */

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