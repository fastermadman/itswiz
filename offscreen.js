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

// macOS/Syncthing kan gemme et mappenavn i NFD (unicode-dekomponeret, fx "å" som to kodepunkter:
// "a" + kombinerende ring) selvom vi selv altid arbejder med NFC-strenge (samme tekst, ét
// kodepunkt) — synligt identisk, byte-forskelligt. getDirectoryHandle matcher eksakt på bytes, så
// et create:false-opslag med vores NFC-streng kan kaste NotFoundError selvom mappen findes, bare
// under en anden byte-repræsentation (bekræftet live 2026-08-28, issue #131: en RAW/MD-mappe der
// havde været gennem Syncthing var NFD på disk, mens vores egen streng var NFC — moveDir() tolkede
// den falske NotFoundError som "allerede flyttet" og rørte aldrig de rigtige filer).
// Kører kun som fallback NÅR det eksakte opslag rent faktisk fejler — det almindelige tilfælde
// (samme session skrev/læste mappen, ingen ekstern normalisering involveret) rammer aldrig denne
// kode og opfører sig som før.
async function findDirEntryNormalized(dir, name) {
  const target = name.normalize("NFC");
  for await (const [entryName, handle] of dir.entries()) {
    if (handle.kind === "directory" && entryName.normalize("NFC") === target) return handle;
  }
  return null;
}

async function getDirectoryHandleTolerant(dir, name, { create = true } = {}) {
  try {
    return await dir.getDirectoryHandle(name, { create: false });
  } catch (err) {
    if (err.name !== "NotFoundError") throw err;
    const found = await findDirEntryNormalized(dir, name);
    if (found) return found;
    if (create) return await dir.getDirectoryHandle(name, { create: true });
    throw err;
  }
}

async function getTargetDirectory(root, pathParts, { create = true } = {}) {
  let dir = root;
  for (const part of pathParts) {
    dir = await getDirectoryHandleTolerant(dir, part, { create });
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

async function copyRecursive(srcDir, destDir) {
  for await (const [name, handle] of srcDir.entries()) {
    if (handle.kind === "file") {
      const file = await handle.getFile();
      const destFile = await destDir.getFileHandle(name, { create: true });
      const writable = await destFile.createWritable();
      await writable.write(file);
      await writable.close();
    } else {
      const destSubDir = await destDir.getDirectoryHandle(name, { create: true });
      await copyRecursive(handle, destSubDir);
    }
  }
}

// Flytter en hel mappe (fx en ugemappe hvis en lektion er blevet udskudt til en anden dato, se
// issue #96) fra oldPath til newPath. FSA har intet atomisk move for mapper — kopierer rekursivt
// og sletter kilden bagefter. No-op hvis kildemappen (eller en af dens forældre) ikke findes, fx
// hvis den allerede blev flyttet i en tidligere kørsel.
async function moveDir(oldPath, newPath) {
  const root = await getVaultHandle();

  const oldParts = oldPath.split("/");
  const oldName = oldParts.pop();
  let oldParentDir;
  try {
    oldParentDir = await getTargetDirectory(root, oldParts, { create: false });
  } catch (err) {
    if (err.name === "NotFoundError") return;
    throw err;
  }
  let oldDir;
  try {
    oldDir = await getDirectoryHandleTolerant(oldParentDir, oldName, { create: false });
  } catch (err) {
    if (err.name === "NotFoundError") return;
    throw err;
  }

  const newParts = newPath.split("/");
  const newName = newParts.pop();
  const newParentDir = await getTargetDirectory(root, newParts);
  const newDir = await newParentDir.getDirectoryHandle(newName, { create: true });

  await copyRecursive(oldDir, newDir);
  await oldParentDir.removeEntry(oldName, { recursive: true });
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
  if (message.type === "moveDir") {
    moveDir(message.oldPath, message.newPath)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message, code: err.code }));
    return true;
  }
});
