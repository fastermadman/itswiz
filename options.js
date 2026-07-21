const SETTINGS_KEY = "viastudywizSettings";
const DEFAULTS = {
  daysBack: 1,
  daysForward: 30,
  enableFileDownloads: true,
  enableCalendarSync: true,
  enableMetadataExport: false,
  vaultFolderName: "ViaVault",
  alarmIntervalHours: 24,
};

async function load() {
  const { [SETTINGS_KEY]: settings } = await chrome.storage.local.get(SETTINGS_KEY);
  const merged = { ...DEFAULTS, ...settings };
  document.getElementById("daysBack").value = merged.daysBack;
  document.getElementById("daysForward").value = merged.daysForward;
  document.getElementById("alarmIntervalHours").value = merged.alarmIntervalHours;
  document.getElementById("enableFileDownloads").checked = merged.enableFileDownloads;
  document.getElementById("enableCalendarSync").checked = merged.enableCalendarSync;
  document.getElementById("enableMetadataExport").checked = merged.enableMetadataExport;
  document.getElementById("vaultFolderName").value = merged.vaultFolderName;
}

document.getElementById("save").addEventListener("click", async () => {
  const settings = {
    daysBack: Number(document.getElementById("daysBack").value),
    daysForward: Number(document.getElementById("daysForward").value),
    alarmIntervalHours: Number(document.getElementById("alarmIntervalHours").value),
    enableFileDownloads: document.getElementById("enableFileDownloads").checked,
    enableCalendarSync: document.getElementById("enableCalendarSync").checked,
    enableMetadataExport: document.getElementById("enableMetadataExport").checked,
    vaultFolderName: document.getElementById("vaultFolderName").value.trim() || DEFAULTS.vaultFolderName,
  };
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  const status = document.getElementById("status");
  status.textContent = "Gemt.";
  setTimeout(() => (status.textContent = ""), 2000);
});

load();
