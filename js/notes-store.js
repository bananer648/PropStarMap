// ============================================================
// 命题星图（PropStarMap） - 笔记存储（node.html 详情页与主图侧栏共享）
// 存储：IndexedDB（DB 名 math-kg-notes / store 名 notes），
//       打开失败时自动退化为 localStorage（键 kg-note:<id>）。
// 笔记结构（按节点 id 存）：
//   { id, text, images: [{id, dataUrl, name, ts}], updatedAt }
// API（挂到 window.KGNotes）：
//   KGNotes.load(id)            -> Promise<note|null>
//   KGNotes.save(id, note)      -> Promise<void>     （合并覆盖 images/text）
//   KGNotes.remove(id)          -> Promise<void>
//   KGNotes.clearAll()          -> Promise<void>
//   KGNotes.list()              -> Promise<{id, updatedAt}[]>（供主图显示徽标）
//   KGNotes.getStoreMode()      -> "idb" | "local"   （降级信息）
//   KGNotes.exportAll()         -> Promise<Object>   （{format, version, exportedAt, notes}）
//   KGNotes.importAll(obj, mode)-> Promise<{count}>  （mode: "merge" 只填空位 | "overwrite" 全覆）
// 注意：主图 index.html 与详情页 node.html 都需引入本文件（必须在
//       data/*.js 之后、页面内联脚本之前加载）。
// ============================================================
(function () {
  "use strict";

  const DB_NAME = "math-kg-notes";
  const STORE = "notes";
  const DB_VERSION = 1;
  const LS_PREFIX = "kg-note:";

  let idb = null;          // Promise<IDBDatabase>，可用时
  let idbFailed = false;

  function openIDB() {
    return new Promise(function (resolve, reject) {
      try {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = function () {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) {
            db.createObjectStore(STORE, { keyPath: "id" });
          }
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error || new Error("indexedDB open failed")); };
      } catch (e) { reject(e); }
    });
  }
  function getIDB() {
    if (idbFailed) return null;
    if (!idb) {
      idb = openIDB().catch(function () {
        idbFailed = true;
        idb = null;
        return null;
      });
    }
    return idb;
  }

  // ---------- localStorage 兜底 ----------
  function lsLoad(id) {
    try {
      const raw = localStorage.getItem(LS_PREFIX + id);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function lsSave(id, note) {
    try {
      localStorage.setItem(LS_PREFIX + id, JSON.stringify(note));
      return true;
    } catch (e) { return false; }   // 配额满 / 私有模式
  }
  function lsRemove(id) {
    try { localStorage.removeItem(LS_PREFIX + id); } catch (e) { /* ignore */ }
  }
  function lsList() {
    const out = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf(LS_PREFIX) === 0) {
          try {
            const note = JSON.parse(localStorage.getItem(k));
            out.push({ id: note.id || k.slice(LS_PREFIX.length), updatedAt: note.updatedAt || 0 });
          } catch (e) { /* 跳过损坏项 */ }
        }
      }
    } catch (e) { /* ignore */ }
    return out;
  }

  function toPromise(tx) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error || new Error("idb tx failed")); };
      tx.onabort = function () { reject(tx.error || new Error("idb tx aborted")); };
    });
  }

  // ---------- API ----------
  function load(id) {
    const dbp = getIDB();
    if (!dbp) return Promise.resolve(lsLoad(id));
    return dbp.then(function (db) {
      if (!db) return lsLoad(id);
      return new Promise(function (resolve, reject) {
        try {
          const req = db.transaction(STORE, "readonly").objectStore(STORE).get(id);
          req.onsuccess = function () { resolve(req.result || null); };
          req.onerror = function () { reject(req.error); };
        } catch (e) {
          idbFailed = true; idb = null;
          resolve(lsLoad(id));
        }
      });
    });
  }

  function save(id, note) {
    const record = {
      id: id,
      text: String(note.text || ""),
      images: Array.isArray(note.images) ? note.images : [],
      updatedAt: Date.now()
    };
    const dbp = getIDB();
    if (!dbp) {
      return Promise.resolve(lsSave(id, record) ? null : (function () {
        throw new Error("笔记保存失败：本地存储不可用或已满");
      })());
    }
    return dbp.then(function (db) {
      if (!db) {
        if (!lsSave(id, record)) throw new Error("笔记保存失败：本地存储不可用或已满");
        return;
      }
      return new Promise(function (resolve, reject) {
        try {
          const tx = db.transaction(STORE, "readwrite");
          tx.objectStore(STORE).put(record);
          toPromise(tx).then(resolve, reject);
        } catch (e) {
          idbFailed = true; idb = null;
          if (!lsSave(id, record)) reject(new Error("笔记保存失败：本地存储不可用或已满"));
          else resolve();
        }
      });
    });
  }

  function remove(id) {
    const dbp = getIDB();
    if (!dbp) { lsRemove(id); return Promise.resolve(); }
    return dbp.then(function (db) {
      if (!db) { lsRemove(id); return; }
      return new Promise(function (resolve, reject) {
        try {
          const tx = db.transaction(STORE, "readwrite");
          tx.objectStore(STORE).delete(id);
          toPromise(tx).then(resolve, reject);
        } catch (e) {
          idbFailed = true; idb = null;
          lsRemove(id);
          resolve();
        }
      });
    });
  }

  function clearAll() {
    const dbp = getIDB();
    if (!dbp) {
      try {
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const k = localStorage.key(i);
          if (k && k.indexOf(LS_PREFIX) === 0) localStorage.removeItem(k);
        }
      } catch (e) { /* ignore */ }
      return Promise.resolve();
    }
    return dbp.then(function (db) {
      if (!db) { clearAll(); return; }
      return new Promise(function (resolve, reject) {
        try {
          const tx = db.transaction(STORE, "readwrite");
          tx.objectStore(STORE).clear();
          toPromise(tx).then(resolve, reject);
        } catch (e) {
          idbFailed = true; idb = null;
          clearAll();
          resolve();
        }
      });
    });
  }

  function list() {
    const dbp = getIDB();
    if (!dbp) return Promise.resolve(lsList());
    return dbp.then(function (db) {
      if (!db) return lsList();
      return new Promise(function (resolve, reject) {
        try {
          const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
          req.onsuccess = function () {
            resolve((req.result || []).map(function (r) { return { id: r.id, updatedAt: r.updatedAt || 0 }; }));
          };
          req.onerror = function () { reject(req.error); };
        } catch (e) {
          idbFailed = true; idb = null;
          resolve(lsList());
        }
      });
    });
  }

  async function exportAll() {
    const dbp = getIDB();
    let notes = [];
    if (!dbp) {
      notes = lsList().map(function (m) {
        const note = lsLoad(m.id);
        return note || { id: m.id, text: "", images: [], updatedAt: m.updatedAt };
      });
    } else {
      const db = await dbp;
      if (!db) {
        return exportAll();
      }
      notes = await new Promise(function (resolve, reject) {
        try {
          const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
          req.onsuccess = function () { resolve(req.result || []); };
          req.onerror = function () { reject(req.error); };
        } catch (e) {
          idbFailed = true; idb = null;
          resolve(lsList().map(function (m) {
            const note = lsLoad(m.id);
            return note || { id: m.id, text: "", images: [], updatedAt: m.updatedAt };
          }));
        }
      });
    }
    return {
      format: "math-kg-notes",
      version: 1,
      exportedAt: new Date().toISOString(),
      notes: notes.map(function (n) {
        return { id: n.id, text: n.text || "", images: n.images || [], updatedAt: n.updatedAt || 0 };
      })
    };
  }

  async function importAll(obj, mode) {
    if (!obj || obj.format !== "math-kg-notes" || !Array.isArray(obj.notes)) {
      throw new Error("文件格式不正确：需要由本工具导出的 .json 笔记文件");
    }
    mode = mode === "overwrite" ? "overwrite" : "merge";
    let count = 0;
    for (const n of obj.notes) {
      if (!n || typeof n.id !== "string" || !n.id) continue;
      if (mode === "merge") {
        const existing = await load(n.id);
        if (existing && (existing.text || (existing.images && existing.images.length))) continue;
      }
      await save(n.id, { text: n.text || "", images: Array.isArray(n.images) ? n.images : [] });
      count++;
    }
    return { count: count };
  }

  window.KGNotes = {
    load: load,
    save: save,
    remove: remove,
    clearAll: clearAll,
    list: list,
    exportAll: exportAll,
    importAll: importAll,
    getStoreMode: function () { return idbFailed ? "local" : "idb"; }
  };
})();
