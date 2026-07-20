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
  await chrome.downloads.download({ url, filename: `viastudywiz-${startUnix}-${endUnix}.json` });

  await downloadPdfElements(result.plans);
  return result;
}

// PDF-download-kæde (Kæde A i 05-api-reference.md, fuldt kortlagt): elementets side åbnes i en
// skjult fane, og vi lytter efter FileDownloadUrl i PdfViewer/Viewer.aspx-requestet, som er en
// presigned filecache-URL der kan downloades direkte uden cookies.
const PDF_VIEWER_PATTERN = "*://platform.itslearning.com/PdfViewer/Viewer.aspx*";

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

async function downloadPdfElements(plans) {
  const pdfElements = Object.values(plans)
    .filter(Boolean)
    .flatMap((plan) =>
      (plan.elements ?? [])
        .filter((el) => el.typeName === "Fil" && el.title.toLowerCase().endsWith(".pdf"))
        .map((el) => ({
          courseName: plan.courseName ?? "ukendt-fag",
          weekFolder: weekFolderName(plan.start),
          element: el,
        }))
    );

  for (const { courseName, weekFolder, element } of pdfElements) {
    try {
      const downloadUrl = await resolvePdfDownloadUrl(element.url);
      const filename = `viastudywiz/${sanitizeFilename(courseName)}/${weekFolder}/${sanitizeFilename(element.title)}`;
      await chrome.downloads.download({ url: downloadUrl, filename });
    } catch (err) {
      console.error(`VIAstudyWiz PDF-fejl (${element.title}):`, err);
    }
  }
}

chrome.action.onClicked.addListener(() => {
  const now = Math.floor(Date.now() / 1000);
  const start = now - 7 * 24 * 60 * 60;
  collectAndDownload(start, now).catch((err) => console.error("VIAstudyWiz fejl:", err));
});
