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
  const settings = await getSettings();

  const [tab] = await chrome.tabs.query({ url: "https://via.itslearning.com/*" });
  if (!tab) {
    throw new Error("Ingen åben fane med via.itslearning.com fundet — åbn og log ind først.");
  }

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: collectRangeInPage,
    args: [startUnix, endUnix],
  });

  // Kalender + filer først — så en evt. hængende gem-dialog for JSON-metadata (se nedenfor)
  // ikke blokerer det der faktisk betyder noget.
  if (settings.enableCalendarSync) await syncCalendar(result);
  if (settings.enableFileDownloads) await downloadFileElements(result.plans, settings.vaultFolderName);

  // Blob-URL i stedet for data:-URL — Chrome ser ud til at gennemtvinge gem-dialogen for
  // data:-downloads uafhængigt af "spørg hvor filer skal gemmes"-indstillingen.
  const json = JSON.stringify(result, null, 2);
  const blobUrl = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  await chrome.downloads.download({
    url: blobUrl,
    filename: `${settings.vaultFolderName}/_metadata/viastudywiz-${startUnix}-${endUnix}.json`,
  });

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

async function downloadFileElements(plans, vaultFolderName) {
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
      const filename = `${vaultFolderName}/${sanitizeFilename(courseName)}/${weekFolder}/${sanitizeFilename(element.title)}`;
      await chrome.downloads.download({ url: downloadUrl, filename });
      await markDownloaded(element.id);
    } catch (err) {
      console.error(`VIAstudyWiz fil-fejl (${element.title}):`, err);
    }
  }
}

// Kalender-sync: ét Google Calendar-event pr. lektion, i fagets egen kalender (allerede
// oprettet manuelt af Valdemar i viawievaldi@gmail.com). Se ValdiVault:
// 10_Projects/VIAstudyWiz/03-kalender-integration.md.
const COURSE_CALENDAR_NAMES = {
  "LSmu-2527": "Musik",
  "LSmu-ec2425": "Musik",
  "LSkr-2628": "Religion",
  "LSS24.1livs": "LivsOplysning",
  "LSdau2-2526": "Dansk",
  "LSS24.1da": "Dansk",
  "LSS24.1psyk.spæd": "PædPsyk",
  "LSS24pra1-2425": "Praktik",
  "LStek-f26": "Teknologiforståelse",
  "LSS24.1pæd.ad": "PædAd",
};

const CALENDAR_EVENT_MAP_KEY = "calendarEventMap";
const TIME_ZONE = "Europe/Copenhagen";

function getAuthToken(interactive = true) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error(chrome.runtime.lastError?.message ?? "Intet token modtaget"));
      } else {
        resolve(token);
      }
    });
  });
}

async function fetchCalendarIdMap(token) {
  const res = await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  const map = {};
  for (const cal of data.items ?? []) {
    map[cal.summary] = cal.id;
  }
  return map;
}

// itslearning-tider har ingen tidszone-suffix (fx "2026-04-29T12:30:00.0000000") — Calendar
// API'et vil have et rent ISO-tidspunkt + separat timeZone-felt.
function toGoogleDateTime(isoString) {
  return isoString.slice(0, 19);
}

// itslearnings plan-beskrivelser er rig HTML (<p>, <table>, links, osv.). Service workers har
// ikke DOMParser, så det er en regex-baseret oversættelse til læsbar ren tekst, ikke en fuld parser.
function stripHtml(html) {
  if (!html) return "";
  return html
    .replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, "$2 ($1)")
    .replace(/<\/(p|div|tr|table|li)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// itslearning-planer hedder tit "Uge 33 Tirsdag <indhold>" — ugedagen er overflødig i en
// kalender-titel, kalenderen viser jo allerede selv dato/ugedag. Fjern kun hvis mønsteret matcher.
function stripWeekdayPrefix(title) {
  return (title ?? "").replace(/^Uge\s+\d+\s+\S+\s*/i, "").trim();
}

function buildEventDescription(plan) {
  if (!plan) return "";
  const lines = [plan.title ?? "", "", stripHtml(plan.description)];
  const elements = (plan.elements ?? []).map((el) => `- ${el.title}`);
  if (elements.length > 0) {
    lines.push("", "Materialer:", ...elements);
  }
  return lines.join("\n");
}

async function getEventMap() {
  const { [CALENDAR_EVENT_MAP_KEY]: map } = await chrome.storage.local.get(CALENDAR_EVENT_MAP_KEY);
  return map ?? {};
}

async function saveEventMap(map) {
  await chrome.storage.local.set({ [CALENDAR_EVENT_MAP_KEY]: map });
}

async function upsertCalendarEvent(token, calendarId, itslearningEventId, body, eventMap) {
  const existingGoogleEventId = eventMap[itslearningEventId];
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
  const url = existingGoogleEventId ? `${base}/${existingGoogleEventId}` : base;
  const method = existingGoogleEventId ? "PATCH" : "POST";

  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Calendar API-fejl (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  eventMap[itslearningEventId] = data.id;
}

async function syncCalendar(result) {
  const token = await getAuthToken();
  const calendarIds = await fetchCalendarIdMap(token);
  const eventMap = await getEventMap();

  for (const event of result.events) {
    const calendarName = COURSE_CALENDAR_NAMES[event.title];
    if (!calendarName) continue; // ukendt/afsluttet/ikke-mappet fag, spring over

    const calendarId = calendarIds[calendarName];
    if (!calendarId) {
      console.warn(`VIAstudyWiz: ingen Google-kalender fundet ved navn "${calendarName}"`);
      continue;
    }

    const planKey = (event.PlanIds ?? [])[0] ? `${event.courseId}:${event.PlanIds[0]}` : null;
    const plan = planKey ? result.plans[planKey] : null;

    const body = {
      summary: `${calendarName} — ${stripWeekdayPrefix(event.PlanTitle ?? plan?.title)}`,
      location: event.parsedDescription?.room ?? "",
      description: buildEventDescription(plan),
      start: { dateTime: toGoogleDateTime(event.start), timeZone: TIME_ZONE },
      end: { dateTime: toGoogleDateTime(event.end), timeZone: TIME_ZONE },
    };

    try {
      await upsertCalendarEvent(token, calendarId, event.id, body, eventMap);
    } catch (err) {
      console.error(`VIAstudyWiz kalender-fejl (${body.summary}):`, err);
    }
  }

  await saveEventMap(eventMap);
}

const SETTINGS_KEY = "viastudywizSettings";
const DEFAULT_SETTINGS = {
  daysBack: 1,
  daysForward: 30,
  enableFileDownloads: true,
  enableCalendarSync: true,
  vaultFolderName: "ViaVault",
  alarmIntervalHours: 24,
};

async function getSettings() {
  const { [SETTINGS_KEY]: settings } = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...settings };
}

async function runCollectAndDownload() {
  const { daysBack, daysForward } = await getSettings();
  const now = Math.floor(Date.now() / 1000);
  const start = now - daysBack * 24 * 60 * 60;
  const end = now + daysForward * 24 * 60 * 60;
  collectAndDownload(start, end).catch((err) => console.error("VIAstudyWiz fejl:", err));
}

chrome.action.onClicked.addListener(runCollectAndDownload);

// Kører automatisk uden manuelt klik — kræver en åben, logget-ind via.itslearning.com-fane.
const DAILY_ALARM = "viastudywiz-daily-fetch";

async function registerAlarm() {
  const { alarmIntervalHours } = await getSettings();
  chrome.alarms.create(DAILY_ALARM, { periodInMinutes: alarmIntervalHours * 60 });
}

chrome.runtime.onInstalled.addListener(registerAlarm);
chrome.runtime.onStartup.addListener(registerAlarm);

// Options-siden gemmer i SETTINGS_KEY — genregistrér alarmen hvis intervallet er ændret.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[SETTINGS_KEY]) registerAlarm();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === DAILY_ALARM) runCollectAndDownload();
});
