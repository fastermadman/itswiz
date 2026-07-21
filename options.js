const DEFAULTS = { daysBack: 1, daysForward: 30 };

async function load() {
  const { intervalSettings } = await chrome.storage.local.get("intervalSettings");
  const settings = { ...DEFAULTS, ...intervalSettings };
  document.getElementById("daysBack").value = settings.daysBack;
  document.getElementById("daysForward").value = settings.daysForward;
}

document.getElementById("save").addEventListener("click", async () => {
  const daysBack = Number(document.getElementById("daysBack").value);
  const daysForward = Number(document.getElementById("daysForward").value);
  await chrome.storage.local.set({ intervalSettings: { daysBack, daysForward } });
  const status = document.getElementById("status");
  status.textContent = "Gemt.";
  setTimeout(() => (status.textContent = ""), 2000);
});

load();
