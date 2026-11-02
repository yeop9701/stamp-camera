// 촬영 목록 (IndexedDB). 항목: { id, name, numberText, createdAt, blob, thumb }

const DB_NAME = 'stampcam';
const STORE = 'shots';
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((res, rej) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = () => res(req.result);
      req.onerror = () => {
        dbPromise = null;
        rej(req.error);
      };
    });
  }
  return dbPromise;
}

function tx(mode, fn) {
  return open().then(
    (db) =>
      new Promise((res, rej) => {
        const t = db.transaction(STORE, mode);
        const store = t.objectStore(STORE);
        let result;
        Promise.resolve(fn(store)).then((r) => (result = r));
        t.oncomplete = () => res(result);
        t.onerror = () => rej(t.error);
        t.onabort = () => rej(t.error || new Error('저장 공간이 부족합니다.'));
      })
  );
}

const reqP = (req) => new Promise((res, rej) => {
  req.onsuccess = () => res(req.result);
  req.onerror = () => rej(req.error);
});

export function addShot(item) {
  return tx('readwrite', (s) => reqP(s.add(item)));
}

export function deleteShot(id) {
  return tx('readwrite', (s) => reqP(s.delete(id)));
}

export function clearShots() {
  return tx('readwrite', (s) => reqP(s.clear()));
}

export function getShot(id) {
  return tx('readonly', (s) => reqP(s.get(id)));
}

// 목록 화면용: 원본 blob 없이 가볍게
export function listShots() {
  return tx('readonly', (s) => new Promise((res, rej) => {
    const out = [];
    const req = s.openCursor(null, 'prev');
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return res(out);
      const { blob, ...rest } = c.value;
      out.push({ ...rest, size: blob ? blob.size : 0 });
      c.continue();
    };
    req.onerror = () => rej(req.error);
  }));
}

export async function allShotsWithBlobs() {
  const items = await tx('readonly', (s) => reqP(s.getAll()));
  return items.sort((a, b) => a.id - b.id);
}

export async function requestPersist() {
  try {
    if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
  } catch (e) { /* 무시 */ }
  return false;
}
