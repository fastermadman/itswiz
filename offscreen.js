// Skriver filer til den vault-mappe brugeren har valgt via options.html. Kører i et
// offscreen-dokument fordi File System Access API'ets håndtag (og fetch/Blob-skrivning) kræver
// en document-kontekst, som service workeren ikke har.
// code: "VAULT_PERMISSION" lader background.js skelne "tilladelse mangler" (badge, stop resten
// af kørslens loop tidligt — den kommer ikke tilbage af sig selv) fra alle andre skrivefejl
// (netværk, disk osv.), som bare skal logges og springes over for den ene fil.
function vaultPermissionError(message) {
  return Object.assign(new Error(message), { code: "VAULT_PERMISSION" });
}

async function getVaultHandle() {
  const handle = await fsGet(VAULT_HANDLE_KEY);
  if (!handle) {
    throw vaultPermissionError("Ingen vault-mappe valgt endnu — åbn indstillinger og vælg mappen.");
  }
  const permission = await handle.queryPermission({ mode: "readwrite" });
  if (permission !== "granted") {
    throw vaultPermissionError("Adgang til vault-mappen er ikke længere givet — åbn indstillinger og vælg mappen igen.");
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

// Bruges til at splejse AUTO-sektionen i lektionsplan-noter (background.js writePlanNotes) uden
// at overskrive noter Valdemar selv har tilføjet i filen — vi skal kende det eksisterende
// indhold før vi kan afgøre hvad der ligger uden for markørerne. Returnerer null hvis filen ikke
// findes endnu (dvs. første gang planen skrives), ikke en fejl — det er en forventet tilstand.
async function readFile(path) {
  const parts = path.split("/");
  const filename = parts.pop();
  const root = await getVaultHandle();
  const dir = await getTargetDirectory(root, parts);

  let fileHandle;
  try {
    fileHandle = await dir.getFileHandle(filename, { create: false });
  } catch (err) {
    if (err.name === "NotFoundError") return null;
    throw err;
  }
  const file = await fileHandle.getFile();
  return await file.text();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== "offscreen") return;
  if (message.type === "writeFile") {
    writeFile(message.path, message.url)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message, code: err.code }));
    return true;
  }
  if (message.type === "readFile") {
    readFile(message.path)
      .then((text) => sendResponse({ ok: true, text }))
      .catch((err) => sendResponse({ ok: false, error: err.message, code: err.code }));
    return true;
  }
});
