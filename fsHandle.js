// Deler ét gemt FileSystemDirectoryHandle mellem options.html (hvor brugeren vælger mappen)
// og offscreen.html (hvor selve fil-skrivningen sker) — begge kører på samme extension-origin,
// så IndexedDB er fælles lager mellem dem.
const FS_DB_NAME = "viastudywiz-fs";
const FS_STORE = "handles";
const VAULT_HANDLE_KEY = "vaultDir";

function fsOpenDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(FS_DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(FS_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function fsSet(key, value) {
  const db = await fsOpenDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FS_STORE, "readwrite");
    tx.objectStore(FS_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function fsGet(key) {
  const db = await fsOpenDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FS_STORE, "readonly");
    const req = tx.objectStore(FS_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
