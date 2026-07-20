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
  return result;
}

chrome.action.onClicked.addListener(() => {
  const now = Math.floor(Date.now() / 1000);
  const start = now - 7 * 24 * 60 * 60;
  collectAndDownload(start, now).catch((err) => console.error("VIAstudyWiz fejl:", err));
});
