const SETTINGS_KEY = "viastudywizSettings";
const DEFAULTS = {
  daysBack: 1,
  daysForward: 30,
  enableFileDownloads: true,
  enableCalendarSync: true,
  enableMetadataExport: false,
  enableTaskCompletionSync: false,
  alarmIntervalHours: 24,
};

async function refreshVaultDirStatus() {
  const statusEl = document.getElementById("vaultDirStatus");
  const handle = await fsGet(VAULT_HANDLE_KEY);
  if (!handle) {
    statusEl.textContent = "Ingen mappe valgt endnu.";
    return;
  }
  const permission = await handle.queryPermission({ mode: "readwrite" });
  statusEl.textContent =
    permission === "granted" ? `Valgt: ${handle.name}` : `Valgt: ${handle.name} (adgang skal genbekræftes)`;
}

document.getElementById("chooseVaultDir").addEventListener("click", async () => {
  try {
    const handle = await window.showDirectoryPicker({ id: "viastudywiz-vault", mode: "readwrite" });
    await fsSet(VAULT_HANDLE_KEY, handle);
    await refreshVaultDirStatus();
    await chrome.action.setBadgeText({ text: "" });
    await chrome.action.setTitle({ title: "VIAstudyWiz" });
  } catch (err) {
    if (err.name !== "AbortError") console.error("VIAstudyWiz vault-mappe-fejl:", err);
  }
});

async function load() {
  const { [SETTINGS_KEY]: settings } = await chrome.storage.local.get(SETTINGS_KEY);
  const merged = { ...DEFAULTS, ...settings };
  document.getElementById("daysBack").value = merged.daysBack;
  document.getElementById("daysForward").value = merged.daysForward;
  document.getElementById("alarmIntervalHours").value = merged.alarmIntervalHours;
  document.getElementById("enableFileDownloads").checked = merged.enableFileDownloads;
  document.getElementById("enableCalendarSync").checked = merged.enableCalendarSync;
  document.getElementById("enableMetadataExport").checked = merged.enableMetadataExport;
  document.getElementById("enableTaskCompletionSync").checked = merged.enableTaskCompletionSync;
  await refreshVaultDirStatus();
}

document.getElementById("save").addEventListener("click", async () => {
  const settings = {
    daysBack: Number(document.getElementById("daysBack").value),
    daysForward: Number(document.getElementById("daysForward").value),
    alarmIntervalHours: Number(document.getElementById("alarmIntervalHours").value),
    enableFileDownloads: document.getElementById("enableFileDownloads").checked,
    enableCalendarSync: document.getElementById("enableCalendarSync").checked,
    enableMetadataExport: document.getElementById("enableMetadataExport").checked,
    enableTaskCompletionSync: document.getElementById("enableTaskCompletionSync").checked,
  };
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  const status = document.getElementById("status");
  status.textContent = "Gemt.";
  setTimeout(() => (status.textContent = ""), 2000);
});

load();
