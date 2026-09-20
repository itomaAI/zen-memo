/**
 * Zen Memo - GitHub Gist API Sync Provider (Plan A: 1 Gist, Multi-file Notebook)
 */

export class GistClient {
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
      throw new Error("GitHub PAT (Personal Access Token) が設定されていません。設定画面で登録してください。");
    }

    onProgress("ローカルノートの取得中...");
    const localNotes = await this.db.getAllNotes();

    let remoteGist = null;
    let targetGistId = gistId;

    // 1. Fetch Remote Gist if exists
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

    // 2. Parse Remote manifest & notes
    const remoteManifest = remoteGist?.files?.['manifest.json'] 
      ? JSON.parse(remoteGist.files['manifest.json'].content || '{}')
      : { notes: {} };

    // 3. Bidirectional Sync / Merge
    onProgress("差分の統合中...");
    const filesToUpload = {};

    // A. Check Remote to Local
    if (remoteGist && remoteGist.files) {
      for (const [filename, fileObj] of Object.entries(remoteGist.files)) {
        if (!filename.endsWith('.md')) continue;
        const noteId = filename.replace(/\.md$/, '');
        const remoteMeta = remoteManifest.notes?.[noteId] || {};
        const local = localNotes.find(n => n.id === noteId);

        if (!local || (remoteMeta.updatedAt && remoteMeta.updatedAt > (local.updatedAt || 0))) {
          // Remote is newer -> Save to Local
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

    // Refresh local after pull
    const refreshedLocal = await this.db.getAllNotes();

    // B. Check Local to Remote
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

    // Include manifest in upload if changed
    if (Object.keys(filesToUpload).length > 0 || !remoteGist) {
      filesToUpload['manifest.json'] = {
        content: JSON.stringify(remoteManifest, null, 2)
      };
    }

    // 4. Push updates to GitHub
    if (!targetGistId) {
      // Create new secret Gist
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

      if (!createRes.ok) {
        throw new Error(`Gist 作成エラー: HTTP ${createRes.status}`);
      }

      const createdGist = await createRes.json();
      targetGistId = createdGist.id;
      await this.db.setSetting('gist_id', targetGistId);
    } else if (Object.keys(filesToUpload).length > 0) {
      onProgress("Gist へ変更をアップロード中...");
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

      if (!patchRes.ok) {
        throw new Error(`Gist 更新エラー: HTTP ${patchRes.status}`);
      }
    }

    onProgress("同期完了");
    return { gistId: targetGistId, count: refreshedLocal.length };
  }
}