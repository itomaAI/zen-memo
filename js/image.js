/**
 * Zen Memo - Image Optimization & Clipboard Handler
 * Automatically handles paste & file pick, resizes to max 1200px, compresses to WebP/JPEG Base64.
 */

export class ImageHandler {
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

  /**
   * Prompts user to pick image from camera or photo library
   */
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

  /**
   * Resizes large images (max 1200px) and converts to compact Base64 Data URL
   */
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

          // Resize if larger than maxDimension
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

          // Prefer webp, fallback to jpeg
          try {
            const dataUrl = canvas.toDataURL('image/webp', quality);
            if (dataUrl.startsWith('data:image/webp')) {
              return resolve(dataUrl);
            }
          } catch (e) {
            // fallback
          }

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