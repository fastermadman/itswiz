// Skriver filer til den vault-mappe brugeren har valgt via options.html. Kører i et
// offscreen-dokument fordi File System Access API'ets håndtag (og fetch/Blob-skrivning) kræver
// en document-kontekst, som service workeren ikke har.
async function getVaultHandle() {
  const handle = await fsGet(VAULT_HANDLE_KEY);
  if (!handle) {
    throw new Error("Ingen vault-mappe valgt endnu — åbn indstillinger og vælg mappen.");
  }
  const permission = await handle.queryPermission({ mode: "readwrite" });
  if (permission !== "granted") {
    throw new Error("Adgang til vault-mappen er ikke længere givet — åbn indstillinger og vælg mappen igen.");
  }
  return handle;
}

async function getTargetDirectory(root, pathParts) {
  let dir = root;
  for (const part of pathParts) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  return dir;
}

async function writeFile(path, url) {
  const parts = path.split("/");
  const filename = parts.pop();
  const root = await getVaultHandle();
  const dir = await getTargetDirectory(root, parts);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ved hentning af ${url}`);
  const blob = await res.blob();

  const fileHandle = await dir.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== "offscreen" || message.type !== "writeFile") return;
  writeFile(message.path, message.url)
    .then(() => sendResponse({ ok: true }))
    .catch((err) => sendResponse({ ok: false, error: err.message }));
  return true;
});
