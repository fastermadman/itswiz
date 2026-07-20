// Kører selve API-kaldene inde i en åben via.itslearning.com-fane (ikke fra service workeren),
// fordi myEvents-POST'et afvises med 403 når Origin er chrome-extension://... i stedet for
// den rigtige side-origin (CSRF/Origin-tjek server-side).
async function collectRangeInPage(startUnix, endUnix) {
  const BASE = "https://via.itslearning.com";

  async function fetchJson(url, options) {
    const res = await fetch(url, options);
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      throw new Error(`Ikke-JSON svar fra ${url} (status ${res.status}, content-type "${contentType}")`);
    }
    return res.json();
  }

  async function fetchCourses() {
    const [starred, unstarred] = await Promise.all([
      fetchJson(`${BASE}/restapi/personal/courses/cards/starred/v1`),
      fetchJson(`${BASE}/restapi/personal/courses/cards/unstarred/v1`),
    ]);
    return [...starred.EntityArray, ...unstarred.EntityArray];
  }

  async function fetchMyEvents(courseIds, start, end) {
    const filter = JSON.stringify({ courseIds, projectIds: [], personal: true, hierarchyIds: [] });
    return fetchJson(`${BASE}/RestApi/calendar/myEvents`, {
      method: "POST",
      headers: {
        "x-requested-with": "XMLHttpRequest",
        "content-type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify({ filter, start, end }),
    });
  }

  async function fetchPlan(courseId, planId) {
    const url = `${BASE}/restapi/personal/course/${courseId}/plans/selected/v1?ChildId=0&planIds=${planId}&viewForPersonId=0&PageIndex=0&PageSize=3`;
    const data = await fetchJson(url);
    return data?.plans?.entityArray?.[0] ?? null;
  }

  // apiDescriptionPlainText har faste labels ("Lokale/Room:" osv.), ikke sprogafhængige.
  function parseDescription(text) {
    const labels = {
      room: "Lokale/Room:",
      teacher: "Underviser/Teacher:",
      subject: "Fag/Subject:",
      activity: "Aktivitet/Activity:",
    };
    const result = {};
    const entries = Object.entries(labels);
    for (let i = 0; i < entries.length; i++) {
      const [key, label] = entries[i];
      const start = text.indexOf(label);
      if (start === -1) continue;
      const from = start + label.length;
      const nextLabel = entries.slice(i + 1).find(([, l]) => text.indexOf(l) !== -1);
      const to = nextLabel ? text.indexOf(nextLabel[1]) : text.length;
      result[key] = text.slice(from, to).trim();
    }
    return result;
  }

  const courses = await fetchCourses();
  const courseIds = courses.map((c) => c.CourseId);
  const events = await fetchMyEvents(courseIds, startUnix, endUnix);

  const planKeys = new Set();
  for (const event of events) {
    for (const planId of event.PlanIds ?? []) {
      planKeys.add(`${event.courseId}:${planId}`);
    }
  }

  const plans = {};
  for (const key of planKeys) {
    const [courseId, planId] = key.split(":");
    plans[key] = await fetchPlan(courseId, planId);
  }

  return {
    courses,
    events: events.map((e) => ({ ...e, parsedDescription: parseDescription(e.apiDescriptionPlainText ?? "") })),
    plans,
  };
}

async function collectAndDownload(startUnix, endUnix) {
  const [tab] = await chrome.tabs.query({ url: "https://via.itslearning.com/*" });
  if (!tab) {
    throw new Error("Ingen åben fane med via.itslearning.com fundet — åbn og log ind først.");
  }

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: collectRangeInPage,
    args: [startUnix, endUnix],
  });

  const json = JSON.stringify(result, null, 2);
  const url = `data:application/json;charset=utf-8,${encodeURIComponent(json)}`;
  await chrome.downloads.download({ url, filename: `ViaVault/_metadata/viastudywiz-${startUnix}-${endUnix}.json` });

  await downloadFileElements(result.plans);
  return result;
}

// Fil-download: to kæder, begge fra 05-api-reference.md. Elementets side åbnes i en skjult fane;
// PDF'er lytter efter FileDownloadUrl i PdfViewer/Viewer.aspx (Kæde A, 7 hop), Office-filer
// lytter først efter LearningObjectId/LearningObjectInstanceId i File/View.aspx, navigerer så
// til DownloadRedirect.ashx og lytter efter den endelige filecache-URL (Kæde B, 3 hop efter det).
const PDF_VIEWER_PATTERN = "*://platform.itslearning.com/PdfViewer/Viewer.aspx*";
const FILE_VIEW_PATTERN = "*://resource.itslearning.com/File/View.aspx*";
const FILECACHE_PATTERN = "*://filecache.itslearning.com/*";
const OFFICE_EXTENSIONS = [".docx", ".pptx", ".xlsx", ".doc", ".ppt", ".xls"];

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, "_").trim();
}

// Matcher Valdemars eksisterende manuelle ugemappe-navngivning (fx "W34tirs").
function weekFolderName(isoDate) {
  const date = new Date(isoDate);
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  const dayAbbrev = ["søn", "man", "tirs", "ons", "tors", "fre", "lør"][date.getDay()];
  return `W${week}${dayAbbrev}`;
}

async function resolvePdfDownloadUrl(elementUrl, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let tabId = null;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout: intet PdfViewer/Viewer.aspx-kald inden for ${timeoutMs}ms`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timeout);
      chrome.webRequest.onBeforeRequest.removeListener(listener);
      if (tabId !== null) chrome.tabs.remove(tabId).catch(() => {});
    }

    function listener(details) {
      const fileDownloadUrl = new URL(details.url).searchParams.get("FileDownloadUrl");
      if (fileDownloadUrl) {
        cleanup();
        resolve(fileDownloadUrl);
      }
    }

    chrome.webRequest.onBeforeRequest.addListener(listener, { urls: [PDF_VIEWER_PATTERN] });
    chrome.tabs.create({ url: `https://via.itslearning.com${elementUrl}`, active: false }).then((tab) => {
      tabId = tab.id;
    });
  });
}

// Venter på det første webRequest der matcher urlPattern, og returnerer dets fulde URL.
function waitForRequest(urlPattern, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.webRequest.onBeforeRequest.removeListener(listener);
      reject(new Error(`Timeout: intet kald matcher ${urlPattern} inden for ${timeoutMs}ms`));
    }, timeoutMs);

    function listener(details) {
      clearTimeout(timeout);
      chrome.webRequest.onBeforeRequest.removeListener(listener);
      resolve(details.url);
    }

    chrome.webRequest.onBeforeRequest.addListener(listener, { urls: [urlPattern] });
  });
}

async function resolveOfficeDownloadUrl(elementUrl, timeoutMs = 20000) {
  let tabId = null;
  try {
    const fileViewPromise = waitForRequest(FILE_VIEW_PATTERN, timeoutMs);
    const tab = await chrome.tabs.create({ url: `https://via.itslearning.com${elementUrl}`, active: false });
    tabId = tab.id;
    const fileViewUrl = await fileViewPromise;

    const params = new URL(fileViewUrl).searchParams;
    const learningObjectId = params.get("LearningObjectId");
    const learningObjectInstanceId = params.get("LearningObjectInstanceId");
    if (!learningObjectId || !learningObjectInstanceId) {
      throw new Error(`Mangler LearningObjectId/LearningObjectInstanceId i ${fileViewUrl}`);
    }

    const filecachePromise = waitForRequest(FILECACHE_PATTERN, timeoutMs);
    const downloadRedirectUrl = `https://resource.itslearning.com/Proxy/DownloadRedirect.ashx?LearningObjectId=${learningObjectId}&LearningObjectInstanceId=${learningObjectInstanceId}`;
    await chrome.tabs.update(tabId, { url: downloadRedirectUrl });
    return await filecachePromise;
  } finally {
    if (tabId !== null) chrome.tabs.remove(tabId).catch(() => {});
  }
}

// Undgår gendownload (og dermed Chromes "(1)"-duplikater) af elementer vi allerede har hentet —
// sporer via elementets stabile id, ikke filnavn, så det er robust overfor at filer bagefter
// bliver omdøbt/deskewed/flyttet af watch-folder-scriptet.
const DOWNLOADED_IDS_KEY = "downloadedElementIds";

async function getDownloadedIds() {
  const { [DOWNLOADED_IDS_KEY]: ids } = await chrome.storage.local.get(DOWNLOADED_IDS_KEY);
  return new Set(ids ?? []);
}

async function markDownloaded(id) {
  const ids = await getDownloadedIds();
  ids.add(id);
  await chrome.storage.local.set({ [DOWNLOADED_IDS_KEY]: [...ids] });
}

async function downloadFileElements(plans) {
  const downloadedIds = await getDownloadedIds();

  const fileElements = Object.values(plans)
    .filter(Boolean)
    .flatMap((plan) =>
      (plan.elements ?? [])
        .filter((el) => el.typeName === "Fil" && !downloadedIds.has(el.id))
        .map((el) => ({
          courseName: plan.courseName ?? "ukendt-fag",
          weekFolder: weekFolderName(plan.start),
          element: el,
        }))
    );

  for (const { courseName, weekFolder, element } of fileElements) {
    const titleLower = element.title.toLowerCase();
    const isPdf = titleLower.endsWith(".pdf");
    const isOffice = OFFICE_EXTENSIONS.some((ext) => titleLower.endsWith(ext));
    if (!isPdf && !isOffice) continue;

    try {
      const downloadUrl = isPdf
        ? await resolvePdfDownloadUrl(element.url)
        : await resolveOfficeDownloadUrl(element.url);
      const filename = `ViaVault/${sanitizeFilename(courseName)}/${weekFolder}/${sanitizeFilename(element.title)}`;
      await chrome.downloads.download({ url: downloadUrl, filename });
      await markDownloaded(element.id);
    } catch (err) {
      console.error(`VIAstudyWiz fil-fejl (${element.title}):`, err);
    }
  }
}

function runCollectAndDownload() {
  const now = Math.floor(Date.now() / 1000);
  const start = now - 1 * 24 * 60 * 60;
  const end = now + 7 * 24 * 60 * 60;
  collectAndDownload(start, end).catch((err) => console.error("VIAstudyWiz fejl:", err));
}

chrome.action.onClicked.addListener(runCollectAndDownload);

// Kører automatisk hver dag uden manuelt klik — kræver en åben, logget-ind via.itslearning.com-fane.
const DAILY_ALARM = "viastudywiz-daily-fetch";

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(DAILY_ALARM, { periodInMinutes: 60 * 24 });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(DAILY_ALARM, { periodInMinutes: 60 * 24 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === DAILY_ALARM) runCollectAndDownload();
});
