// chrome.downloads.download() tvinger en Gem-som-dialog frem for nye undermapper, uanset "spørg
// hvor filer skal gemmes"-indstillingen — udokumenteret macOS-sandbox-adfærd vi ikke kan styre
// fra JS (issues.chromium.org/issues/40359474). File System Access API omgår det helt: brugeren
// vælger vault-mappen én gang (i options.html), og vi får et permanent skrive-håndtag der kan
// oprette vilkårligt dybe undermapper uden flere OS-prompts. showDirectoryPicker() kræver et
// document (en "rigtig" side med brugerinteraktion), som service workeren ikke er — derfor sker
// selve fil-skrivningen i et offscreen-dokument, som denne funktion sørger for er åbent.
async function ensureOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (existing.length > 0) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["BLOBS"],
    justification: "Skriver downloadede filer til vault-mappen via File System Access API",
  });
}

async function writeToVault(path, url) {
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({ target: "offscreen", type: "writeFile", path, url });
  if (!response?.ok) {
    throw Object.assign(new Error(response?.error ?? "Ukendt fejl ved filskrivning i offscreen-dokumentet"), {
      code: response?.code,
    });
  }
}

// Tæller fejlede enkelt-elementer (fil-downloads, kalender-events, lektionsplan-noter) i den
// aktuelle kørsel. Nulstilles i collectAndDownload. Uden denne var den slags fejl kun synlige i
// service worker-konsollen — man skulle vide de skulle kigges efter for overhovedet at opdage dem.
let runErrorCount = 0;
let runErrorMessages = [];
let runFilesDownloaded = 0;
let runEventsSynced = 0;

function recordError(message) {
  runErrorCount++;
  runErrorMessages.push(message);
}

// Badge't viser kun et antal — uden dette skulle man åbne service worker-konsollen for
// overhovedet at se hvad der fejlede, og et klik på extension-ikonet trigger jo bare en ny
// kørsel i stedet for at vise noget. Kappet til 5 linjer så notifikationen ikke vokser
// ubegrænset hvis fx et helt kursus er utilgængeligt.
function notifyErrorsIfAny() {
  if (runErrorCount === 0) return;
  const shown = runErrorMessages.slice(0, 5);
  const rest = runErrorMessages.length - shown.length;
  const message = shown.join("\n") + (rest > 0 ? `\n+${rest} mere` : "");
  chrome.notifications.create({
    type: "basic",
    iconUrl: chrome.runtime.getURL("icon128.png"),
    title: `VIAstudyWiz — ${runErrorCount} element(er) fejlede`,
    message,
    requireInteraction: true,
  });
}

// Vises kun hvis der faktisk skete noget (nye filer/events) — ellers ville den daglige alarm
// give en notifikation hver dag selv i det normale tilfælde, hvor der ikke er noget nyt.
function notifySuccessIfNoteworthy() {
  if (runFilesDownloaded === 0 && runEventsSynced === 0) return;
  chrome.notifications.create({
    type: "basic",
    iconUrl: chrome.runtime.getURL("icon128.png"),
    title: "VIAstudyWiz — kørsel færdig",
    message: `${runFilesDownloaded} fil(er) hentet, ${runEventsSynced} kalender-event(s) synkroniseret.`,
  });
}

// Advarer via extension-ikonet når vault-tilladelsen mangler (sker typisk ved genstart af
// browseren/extensionen — File System Access-tilladelser overlever ikke det pålideligt), eller
// når enkelt-elementer fejlede i seneste kørsel. Vault-adgang har forrang i badge't, da det
// blokerer alt indtil det rettes, mens enkelt-fejl typisk kun rammer ét dokument.
async function updateStatusBadge(vaultPermissionMissing) {
  if (vaultPermissionMissing) {
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
    await chrome.action.setTitle({ title: "VIAstudyWiz — vault-adgang mangler, åbn indstillinger" });
  } else if (runErrorCount > 0) {
    await chrome.action.setBadgeText({ text: String(runErrorCount) });
    await chrome.action.setBadgeBackgroundColor({ color: "#f9ab00" });
    await chrome.action.setTitle({
      title: `VIAstudyWiz — ${runErrorCount} element(er) fejlede i seneste kørsel, se notifikationen`,
    });
  } else {
    await chrome.action.setBadgeText({ text: "" });
    await chrome.action.setTitle({ title: "VIAstudyWiz" });
  }
}

// Vises kun ved fejl der stopper hele kørslen (fx ingen åben itslearning-fane) — badge't alene
// opdages typisk ikke før man selv klikker ind i extensionen, en notifikation ses med det samme.
function notifyCriticalFailure(err) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: chrome.runtime.getURL("icon128.png"),
    title: "VIAstudyWiz — kørsel fejlede",
    message: err.message ?? String(err),
    requireInteraction: true,
  });
}

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

  // plans/selected/v1 (batch-endpointet) returnerer altid fields: null, uanset indhold —
  // /v2-endpointet (samme ét-kald-pr-plan som her, bare enkelt-plan-siden) er det eneste der
  // rent faktisk fylder plan.fields ud, herunder "Tilhørende litteratur"-feltet (issue-diskussion
  // 2026-08-11). Bekræftet live ved at sammenligne begge endpoints for samme planId.
  async function fetchPlan(courseId, planId) {
    const url = `${BASE}/restapi/personal/course/${courseId}/plans/${planId}/v2?ChildId=0`;
    return fetchJson(url);
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
  console.log(`VIAstudyWiz: starter kørsel (${new Date(startUnix * 1000).toISOString()} → ${new Date(endUnix * 1000).toISOString()})`);
  runErrorCount = 0;
  runErrorMessages = [];
  runFilesDownloaded = 0;
  runEventsSynced = 0;
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

  console.log(
    `VIAstudyWiz: hentede ${result.courses.length} fag, ${result.events.length} events, ${Object.keys(result.plans).length} planer`
  );

  // Kalender + filer først — så en evt. hængende gem-dialog for JSON-metadata (se nedenfor)
  // ikke blokerer det der faktisk betyder noget.
  if (settings.enableCalendarSync) await syncCalendar(result);
  let vaultPermissionMissing = false;
  if (settings.enableFileDownloads) {
    const planNotesOk = await writePlanNotes(result.plans);
    // Spring downloads over hvis tilladelsen allerede er væk — ingen grund til at åbne skjulte
    // faner og resolve download-URL'er for filer der alligevel ikke kan skrives.
    const filesOk = planNotesOk && (await downloadFileElements(result.plans, tab.id));
    vaultPermissionMissing = !filesOk;
  }
  await updateStatusBadge(vaultPermissionMissing);
  notifyErrorsIfAny();
  notifySuccessIfNoteworthy();

  console.log("VIAstudyWiz: kørsel færdig");

  // Metadata-JSON'en bruges ikke til noget - hverken kalender-sync eller fil-download læser den,
  // den er ren debug-dump. Slået fra som standard.
  if (settings.enableMetadataExport) {
    const json = JSON.stringify(result, null, 2);
    const dataUrl = `data:application/json;charset=utf-8,${encodeURIComponent(json)}`;
    writeToVault(`_metadata/viastudywiz-${startUnix}-${endUnix}.json`, dataUrl).catch((err) =>
      console.error("VIAstudyWiz JSON-download-fejl:", err)
    );
  }

  return result;
}

// Fil-download: to kæder, begge fra 05-api-reference.md. Elementets side åbnes i en skjult fane;
// PDF'er lytter efter FileDownloadUrl i PdfViewer/Viewer.aspx (Kæde A, 7 hop), Office-filer
// lytter først efter LearningObjectId/LearningObjectInstanceId i File/View.aspx, navigerer så
// til DownloadRedirect.ashx og lytter efter den endelige filecache-URL (Kæde B, 3 hop efter det).
const PDF_VIEWER_PATTERN = "*://platform.itslearning.com/PdfViewer/Viewer.aspx*";
const FILE_VIEW_PATTERN = "*://resource.itslearning.com/File/View.aspx*";
const FILECACHE_PATTERN = "*://filecache.itslearning.com/*";
const DOWNLOAD_REDIRECT_PATTERN = "*://resource.itslearning.com/Proxy/DownloadRedirect.ashx*";
const OFFICE_EXTENSIONS = [".docx", ".pptx", ".xlsx", ".doc", ".ppt", ".xls"];

// Diagnostik: logger alle hop i download-kæderne, så vi kan se hvor den går i stå ved timeouts
// i stedet for at gætte (fx pptx der ikke opfører sig som docx).
chrome.webRequest.onBeforeRequest.addListener(
  (details) => console.log(`VIAstudyWiz kæde-hop: ${details.url}`),
  { urls: ["*://resource.itslearning.com/*", "*://filerepository.itslearning.com/*", "*://filecache.itslearning.com/*", "*://platform.itslearning.com/*"] }
);

// Afsluttende "." eller mellemrum afvises af Chromes File System Access API
// (getDirectoryHandle/getFileHandle kaster "Name is not allowed") — en Windows-kompatibilitets-
// regel i selve implementeringen, ikke kun i specifikationen. Rammer typisk forkortelser/
// afsluttede sætninger i itslearnings emnenavne (fx "Når børn synger.").
function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, "_").trim().replace(/[. ]+$/, "");
}

// Udleder filendelsen fra den endelige download-URL — bruges når element.title ikke selv har
// en endelse. Filecache-URL'er har en opak GUID-sti (intet filnavn i selve path'en); det rigtige
// filnavn+endelse ligger derimod i response-content-disposition-query-parameteren
// (fx filename="KRONIK Fortidsøglen klassisk musik.pdf"), så tjek den først og brug path'en
// som fallback for URL'er der rent faktisk har endelsen i stien.
function extractExtension(url) {
  const parsed = new URL(url);
  const disposition = parsed.searchParams.get("response-content-disposition");
  if (disposition) {
    const filenameMatch = /filename="([^"]+)"/i.exec(disposition);
    const ext = filenameMatch?.[1].match(/\.[a-z0-9]{2,5}$/i);
    if (ext) return ext[0].toLowerCase();
  }
  const pathMatch = parsed.pathname.match(/\.[a-z0-9]{2,5}$/i);
  return pathMatch ? pathMatch[0].toLowerCase() : "";
}

// watchForWopiAccessToken()'s URL (${wopiSrc}/contents?access_token=...) rammes når et
// Office-dokument kun findes i Office-online-viseren, ikke i itslearnings egen filecache — den
// har ingen filnavn/endelse noget sted, i modsætning til itslearnings egne URL'er. Bekræftet
// live: elementet "Fælles pptx Klasseledelse i og med musik..." (titlen har intet .pptx-suffiks)
// løste kun via WOPI-kæden, og extractExtension() fejlede på content-URL'en alene. WOPI-
// protokollens CheckFileInfo-endpoint (samme URL uden /contents) er en almindelig GET der
// returnerer JSON med BaseFileName — standard WOPI, ikke itslearning-specifikt.
async function extractExtensionFromWopi(wopiContentsUrl) {
  const checkFileInfoUrl = wopiContentsUrl.replace(/\/contents(\?|$)/, "$1");
  const res = await fetch(checkFileInfoUrl);
  if (!res.ok) return "";
  const info = await res.json();
  const match = (info.BaseFileName ?? "").match(/\.[a-z0-9]{2,5}$/i);
  return match ? match[0].toLowerCase() : "";
}

// Matcher Valdemars eksisterende manuelle ugemappe-navngivning (fx "W34tirs"). Ren dato+ugedag —
// intet fag-specifikt — så to forskellige lektioner i samme fag samme ugedag (fx Musik
// formiddag/eftermiddag) ville ellers kollidere i weekFolderName() nedenfor, hvis ikke emnet
// adskilte dem.
function weekFolderBase(plan) {
  const date = new Date(plan.start);
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  const dayAbbrev = ["søn", "man", "tirs", "ons", "tors", "fre", "lør"][date.getDay()];
  return `W${week}${dayAbbrev}`;
}

// plan.topic.name er strukturerede data fra itslearning (bekræftet live, ikke fritekst) —
// tilføjes når den findes, så mappen selv fortæller hvad lektionen handlede om
// ("W34tors - Skolens formål"). Løser samtidig kollisionen ovenfor: to lektioner samme ugedag har
// (næsten altid) hver sit emne, og får dermed hver sin mappe uden ekstra "A"/"B"-mærkning.
//
// Kun tilføjet fremadrettet: eksisterende mapper i vaulten hedder stadig bare "W34tors" uden
// emne. Migreret retroaktivt med watchfolder/backfill_week_topics.py.
function weekFolderName(plan) {
  const base = weekFolderBase(plan);
  const topic = plan.topic?.name?.trim();
  return topic ? `${base} - ${sanitizeFilename(topic)}` : base;
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

// Venter på et fejl-svar (4xx/5xx) fra urlPattern og afviser med det samme — uden denne må man
// vente hele timeoutMs ud selvom fx et 403 på DownloadRedirect.ashx allerede fortæller at
// filecache-kaldet aldrig kommer (set for et enkelt dokument, årsag ukendt/formentlig forbigående).
function watchForRequestFailure(urlPattern, timeoutMs) {
  return new Promise((_, reject) => {
    function listener(details) {
      if (details.statusCode >= 400) {
        cleanup();
        reject(new Error(`${urlPattern} afvist af itslearning (status ${details.statusCode})`));
      }
    }
    function cleanup() {
      clearTimeout(timeout);
      chrome.webRequest.onCompleted.removeListener(listener);
    }
    const timeout = setTimeout(cleanup, timeoutMs);
    chrome.webRequest.onCompleted.addListener(listener, { urls: [urlPattern] });
  });
}

// Nogle Office-dokumenter har ingen itslearning-cachet kopi at redirecte til (set som 403 fra
// DownloadRedirect.ashx for et enkelt element) — i stedet trigger selve siden en almindelig
// browser-download direkte fra den skjulte fane. Uden dette ville Chrome vise en "Gem som"-dialog
// i baggrunden (hvis "spørg hvor filer skal gemmes" er slået til), og filen ville aldrig nå
// vaulten. Vi annullerer og sletter den native download med det samme og bruger dens URL i
// stedet, ligesom filecache-URL'en normalt bruges. Rejecter (ikke bare hænger) ved timeout, så
// Promise.any nedenfor kan afgøre at *ingen* af de tre veje virkede.
function watchForNativeDownload(timeoutMs) {
  let listener;
  let timeout;
  const promise = new Promise((resolve, reject) => {
    listener = (item) => {
      cleanup();
      chrome.downloads.cancel(item.id, () => chrome.downloads.erase({ id: item.id }));
      resolve(item.finalUrl || item.url);
    };
    timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Ingen native download opstod"));
    }, timeoutMs);
    chrome.downloads.onCreated.addListener(listener);
  });
  function cleanup() {
    clearTimeout(timeout);
    chrome.downloads.onCreated.removeListener(listener);
  }
  return { promise, cancel: cleanup };
}

// itslearning genererer selv en WOPI access_token og poster den (sammen med WOPISrc) til
// Microsofts Office Online-viewer via et skjult formular-POST — set direkte i devtools for et
// dokument uden itslearning-cachet kopi (samme dokument som ovenfor). WOPI-protokollens
// GetFile-endpoint ({WOPISrc}/contents?access_token=...) er en almindelig HTTP GET, så vi kan
// hente indholdet selv uden nogensinde at røre Microsofts iframe — kræver kun at opsnappe
// access_token fra POST-requesten, ikke at rendere den.
const OFFICE_VIEWER_PATTERN = "*://*.officeapps.live.com/*";

function watchForWopiAccessToken(timeoutMs) {
  let listener;
  let timeout;
  const promise = new Promise((resolve, reject) => {
    listener = (details) => {
      const accessToken = details.requestBody?.formData?.access_token?.[0];
      const wopiSrc = new URL(details.url).searchParams.get("WOPISrc");
      if (!accessToken || !wopiSrc) return;
      cleanup();
      resolve(`${wopiSrc}/contents?access_token=${encodeURIComponent(accessToken)}`);
    };
    timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Intet WOPI access_token opsnappet"));
    }, timeoutMs);
    chrome.webRequest.onBeforeRequest.addListener(listener, { urls: [OFFICE_VIEWER_PATTERN] }, ["requestBody"]);
  });
  function cleanup() {
    clearTimeout(timeout);
    chrome.webRequest.onBeforeRequest.removeListener(listener);
  }
  return { promise, cancel: cleanup };
}

// itslearnings egen fil-cache-vej (File/View.aspx → DownloadRedirect.ashx → filecache) — kan
// kaste (fx 403), i hvilket tilfælde resolveOfficeDownloadUrl falder tilbage til native-download-
// og WOPI-vejene i stedet for at give op med det samme.
async function primaryFileChain(tabId, timeoutMs) {
  const fileViewUrl = await waitForRequest(FILE_VIEW_PATTERN, timeoutMs);

  const params = new URL(fileViewUrl).searchParams;
  const learningObjectId = params.get("LearningObjectId");
  const learningObjectInstanceId = params.get("LearningObjectInstanceId");
  if (!learningObjectId || !learningObjectInstanceId) {
    throw new Error(`Mangler LearningObjectId/LearningObjectInstanceId i ${fileViewUrl}`);
  }

  const filecachePromise = waitForRequest(FILECACHE_PATTERN, timeoutMs);
  const redirectFailurePromise = watchForRequestFailure(DOWNLOAD_REDIRECT_PATTERN, timeoutMs);
  filecachePromise.catch(() => {});
  redirectFailurePromise.catch(() => {});
  const downloadRedirectUrl = `https://resource.itslearning.com/Proxy/DownloadRedirect.ashx?LearningObjectId=${learningObjectId}&LearningObjectInstanceId=${learningObjectInstanceId}`;
  await chrome.tabs.update(tabId, { url: downloadRedirectUrl });
  return await Promise.race([filecachePromise, redirectFailurePromise]);
}

async function resolveOfficeDownloadUrl(elementUrl, timeoutMs = 20000) {
  let tabId = null;
  const native = watchForNativeDownload(timeoutMs * 2);
  const wopi = watchForWopiAccessToken(timeoutMs * 2);
  try {
    const tab = await chrome.tabs.create({ url: `https://via.itslearning.com${elementUrl}`, active: false });
    tabId = tab.id;
    return await Promise.any([primaryFileChain(tabId, timeoutMs), native.promise, wopi.promise]);
  } catch (err) {
    if (err instanceof AggregateError) {
      // Foretræk itslearning-cache-fejlen (403 osv.) — den fortæller mest, de to andre er bare
      // generiske "intet opsnappet"-timeouts.
      throw err.errors.find((e) => !/^(Ingen native download|Intet WOPI)/.test(e.message)) ?? err.errors[0];
    }
    throw err;
  } finally {
    native.cancel();
    wopi.cancel();
    if (tabId !== null) chrome.tabs.remove(tabId).catch(() => {});
  }
}

// Ét retry — favoriserer robusthed over hastighed for de webRequest-timeouts der stadig kan
// opstå (netværks-/session-hik).
async function withRetry(fn) {
  try {
    return await fn();
  } catch {
    return await fn();
  }
}

// Elementets titel har ingen filendelse (fx "KRONIK Fortidsøglen klassisk musik") — de to
// download-kæder skelnes reelt af hvilket netværkskald der rammer først, ikke af titlen, så
// prøv PDF-kæden (den korteste) først og fald tilbage til Office-kæden hvis den ikke rammer.
async function resolveDownloadUrlUnknownType(elementUrl) {
  try {
    return await resolvePdfDownloadUrl(elementUrl, 10000);
  } catch {
    return await resolveOfficeDownloadUrl(elementUrl);
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

// To grene pr. fag: RAW/ er bytes til enheder (NeoReader browser bare filsystemet), MD/ er
// noter til Obsidian (watch-scriptet skriver minerU-outputtet derover). Extensionen rører kun
// RAW/ — den skriver aldrig ind i Obsidian-grenen. Se ValdiVault:
// 10_Projects/VIAstudyWiz/10-filsystem-design-raw-md.md.
//
// itslearnings API har et FriendlyName-felt på kurset, men det er altid null — det eneste
// pæne navn der findes er COURSE_DISPLAY_NAMES, som Valdemar allerede vedligeholder i hånden
// til kalendersyncen. Ukendte kursuskoder (nye fag, "Hjælp", "VIAs onlinekurser") falder
// tilbage til den rå kode i stedet for at fejle.
function courseFolderName(courseName) {
  return COURSE_DISPLAY_NAMES[courseName] ?? courseName;
}

// Fritekstfelt underviseren selv udfylder — henviser ofte til grundbogssider, ikke kun vedhæftede
// filer, så det kan ikke kobles til bestemte elementer. headingText starter altid med
// "Tilhørende litteratur", men har varierende parentes-tilføjelser pr. underviser/kursus.
// field.text er kun rent tekst når isPlainText er sat — nogle undervisere bruger rig tekst i
// feltet, hvor text i stedet indeholder rå HTML (bekræftet live, fx "<p><span
// style=...>...</span></p>" for et Musikforståelse-felt). stripHtml() bruges derfor altid, den
// er et no-op på allerede rent tekst.
function planLiteratureText(plan) {
  const text = plan.fields?.find((f) => f.headingText?.startsWith("Tilhørende litteratur"))?.text;
  return text ? stripHtml(text) || null : null;
}

// YAML literal block scalar (|) — undgår escaping af anførselstegn/kolon/linjeskift i fritekst,
// som en almindelig citeret streng ellers ville kræve. Obsidian viser det som flerlinjet tekst
// i Properties-panelet.
function yamlBlockLines(key, text) {
  return [`${key}: |`, ...text.split("\n").map((line) => `  ${line}`)];
}

function rawPath(courseName, weekFolder, title) {
  return `FAG/${sanitizeFilename(courseFolderName(courseName))}/RAW/${weekFolder}/${sanitizeFilename(title)}`;
}

// watch_viastudywiz.py navngiver MD-noten efter RAW-filens stem (Path.stem, dvs. alt før sidste
// "."), sanitized samme vej — se md_targets() i watchfolder/watch_viastudywiz.py. Title indeholder
// typisk selve endelsen allerede (fx "Titel.docx"), så den skal strippes, ikke bare have .md
// tilføjet oveni.
function mdPath(courseName, weekFolder, title) {
  const stem = sanitizeFilename(title).replace(/\.[^./]+$/, "");
  return `FAG/${sanitizeFilename(courseFolderName(courseName))}/MD/${weekFolder}/${stem}.md`;
}

// "hentet:" i frontmatter — lokal væg-tid i samme tidszone som resten af extensionen (TIME_ZONE),
// ikke maskinens egen, og samme "yyyy-MM-dd HH:mm"-format som start/stop-felterne ovenfor, for
// konsistens (issue #34). Noter her skrives kun én gang (se writePlanNotes), så "opdateret:" giver
// ikke mening endnu — tilføj det hvis en note-type nogensinde begynder at blive genskrevet.
function formatNow() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

// Lektionsplanen hentes allerede til kalender-beskrivelsen — som note i ugemappen binder den
// ugens materialer sammen (og giver Obsidian Bases noget at gruppere efter). Skrives kun én gang:
// senere ændringer fra underviseren hentes ikke ind igen, til gengæld overskrives egne noter aldrig.
// Returnerer false hvis vault-tilladelsen manglede — kalderen bruger det til at springe resten
// af kørslen over (tilladelsen kommer ikke tilbage af sig selv midt i et løb) og til at tænde
// advarsels-badge'et.
async function writePlanNotes(plans) {
  const written = await getDownloadedIds();

  for (const [planKey, plan] of Object.entries(plans)) {
    const noteId = `plan:${planKey}`;
    if (!plan || written.has(noteId)) continue;

    const weekFolder = weekFolderName(plan);
    const fag = sanitizeFilename(courseFolderName(plan.courseName ?? "ukendt-fag"));
    const courseName = plan.courseName ?? "ukendt-fag";
    // Links til MD-noten (navigations-graf), ikke RAW-filen — RAW er bytes til enheder, ikke
    // noget man klikker sig videre til fra en note (issue #26). Mappe/opgave-typer får aldrig en
    // MD-modpart, så de udelades. Link-elementer nævnes som ren tekst (titlen er allerede synlig
    // her) i stedet for en note — automatisk indholds-udtræk blev forsøgt og droppet igen, se #20.
    const materials = (plan.elements ?? [])
      .filter((el) => el.typeName === "Link" || !NON_FILE_TYPE_NAMES.has(el.typeName))
      .map((el) =>
        el.typeName === "Link"
          ? `- ${el.title} (link — åbn selve lektionsplanen i itslearning for at følge det)`
          : `- [[${mdPath(courseName, weekFolder, el.title)}]]`
      );
    const topic = plan.topic?.name?.trim();
    const literature = planLiteratureText(plan);
    const note = [
      "---",
      `fag: ${fag}`,
      `uge: ${weekFolderBase(plan)}`,
      ...(topic ? [`emne: "${topic}"`] : []),
      `dato: ${(plan.start ?? "").slice(0, 10)}`,
      // Lektionens rigtige tidspunkt (ikke lokale-bookingens) — se toGoogleDateTime/syncCalendar
      // for hvorfor plan.start/stop er den pålidelige kilde.
      `start: "${toGoogleDateTime(plan.start ?? "").replace("T", " ")}"`,
      `stop: "${toGoogleDateTime(plan.stop ?? "").replace("T", " ")}"`,
      `hentet: "${formatNow()}"`,
      "type: lektionsplan",
      ...(literature ? yamlBlockLines("litteratur", `📖 ${literature}`) : ["litteratur: false"]),
      "---",
      "",
      `# ${plan.title ?? weekFolder}`,
      "",
      stripHtml(plan.description),
      ...(materials.length ? ["", "## Materialer", ...materials] : []),
      "",
    ].join("\n");

    const path = `FAG/${fag}/MD/${weekFolder}/${weekFolder} lektionsplan.md`;
    try {
      await writeToVault(path, `data:text/markdown;charset=utf-8,${encodeURIComponent(note)}`);
      await markDownloaded(noteId);
    } catch (err) {
      console.error(`VIAstudyWiz lektionsplan-fejl (${path}):`, err);
      if (err.code === "VAULT_PERMISSION") return false;
      recordError(`Lektionsplan (${weekFolder}): ${err.message}`);
    }
  }
  return true;
}

// itslearning bruger separate typeNames pr. dokumenttype for samme
// ViewLearningToolElement-URL-mønster ("Fil", "Microsoft Word", ... — bekræftet i gemte
// metadata-dumps), og der dukker jævnligt uforudsete varianter op alt efter hvordan
// underviseren har lagt materialet ind. En allowlist rammer altid kun de typeNames vi allerede
// kender og springer nye stille over igen — denylist af de kendte ikke-fil-typer er robust
// mod fremtidige varianter uden at kræve endnu en manuel rettelse.
const NON_FILE_TYPE_NAMES = new Set(["Link", "Mappe", "Arbejdsopgave", "Afleveringsopgave"]);

// Kører i itslearning-sidens egen kontekst (se collectRangeInPage ovenfor for hvorfor — samme
// Origin-begrænsning kan gælde). /Resources?FolderID=X returnerer en fuld HTML-side, men
// indlejrer selve mappens indhold som ren JSON i et <script>-tag (window.Resources = {...}) —
// langt simplere end fil-download-kæderne, ingen presigned URL'er eller webRequest-opsnapning
// nødvendig, bekræftet live 2026-08-11 (issue #24).
async function fetchFolderElementsInPage(folderUrl) {
  const res = await fetch(folderUrl, { headers: { "x-requested-with": "XMLHttpRequest" } });
  const text = await res.text();
  const match = text.match(/window\.Resources = (\{.*?\});\s*<\/script>/s);
  if (!match) return [];
  const data = JSON.parse(match[1]);
  return (data.currentFolder?.folderElements?.elements ?? []).map((el) => ({
    id: el.elementId,
    title: el.title,
    typeName: el.isFolder ? "Mappe" : "Fil",
    url: el.elementUrl,
  }));
}

// Mapper kan i princippet indeholde undermapper — depth-grænsen er et sikkerhedsnet mod uendelig
// rekursion (fx en fejlkonfigureret selv-reference), ikke en forventet dybde i praksis.
async function expandFolderElement(tabId, element, depth = 0) {
  if (depth > 5) {
    console.warn(`VIAstudyWiz: Mappe "${element.title}" er over 5 niveauer dyb, stopper rekursion`);
    return [];
  }
  const [{ result: children }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: fetchFolderElementsInPage,
    args: [`https://via.itslearning.com${element.url}`],
  });
  const expanded = [];
  for (const child of children ?? []) {
    if (child.typeName === "Mappe") {
      expanded.push(...(await expandFolderElement(tabId, child, depth + 1)));
    } else {
      expanded.push(child);
    }
  }
  return expanded;
}

// Returnerer false hvis vault-tilladelsen manglede (se writePlanNotes ovenfor).
async function downloadFileElements(plans, tabId) {
  const downloadedIds = await getDownloadedIds();

  const baseElements = Object.values(plans)
    .filter(Boolean)
    .flatMap((plan) =>
      (plan.elements ?? []).map((el) => ({
        courseName: plan.courseName ?? "ukendt-fag",
        weekFolder: weekFolderName(plan),
        element: el,
      }))
    );

  // Mappe-elementer udpakkes til deres reelle indhold (issue #24) — resten af pipelinen
  // (dedup, download, filnavne) ser bare almindelige fil-elementer bagefter, ingen skelnen
  // nødvendig længere nede.
  const matchingElements = [];
  for (const { courseName, weekFolder, element } of baseElements) {
    if (element.typeName === "Mappe") {
      const children = await expandFolderElement(tabId, element);
      for (const child of children) matchingElements.push({ courseName, weekFolder, element: child });
    } else if (!NON_FILE_TYPE_NAMES.has(element.typeName)) {
      matchingElements.push({ courseName, weekFolder, element });
    }
  }

  // Logget her (før dedup-filteret) betyder man kan teste filter-ændringer ved bare at
  // genklikke extension-ikonet og læse service worker-konsollen, uden at skulle rydde
  // downloadedElementIds i chrome.storage.local for at se hvad der matcher.
  console.table(
    matchingElements.map(({ element }) => ({
      titel: element.title,
      typeName: element.typeName,
      id: element.id,
      allerede_downloadet: downloadedIds.has(element.id),
    }))
  );

  const fileElements = matchingElements.filter(({ element }) => !downloadedIds.has(element.id));

  console.log(`VIAstudyWiz: ${fileElements.length} nye fil-elementer at behandle (efter dedup)`);

  for (const { courseName, weekFolder, element } of fileElements) {
    const titleLower = element.title.toLowerCase();
    const isPdf = titleLower.endsWith(".pdf");
    const isOffice = OFFICE_EXTENSIONS.some((ext) => titleLower.endsWith(ext));

    try {
      let downloadUrl;
      let filename;
      if (isPdf || isOffice) {
        downloadUrl = isPdf
          ? await withRetry(() => resolvePdfDownloadUrl(element.url))
          : await withRetry(() => resolveOfficeDownloadUrl(element.url));
        filename = rawPath(courseName, weekFolder, element.title);
      } else {
        downloadUrl = await withRetry(() => resolveDownloadUrlUnknownType(element.url));
        const extension =
          extractExtension(downloadUrl) ||
          (downloadUrl.includes("/contents?access_token=") ? await extractExtensionFromWopi(downloadUrl) : "");
        if (!extension) {
          console.warn(`VIAstudyWiz: kunne ikke udlede filendelse for "${element.title}" (${downloadUrl}), springer over`);
          recordError(`${element.title}: kunne ikke udlede filendelse`);
          continue;
        }
        filename = rawPath(courseName, weekFolder, element.title + extension);
      }
      await writeToVault(filename, downloadUrl);
      await markDownloaded(element.id);
      runFilesDownloaded++;
    } catch (err) {
      console.error(`VIAstudyWiz fil-fejl (${element.title}):`, err);
      if (err.code === "VAULT_PERMISSION") return false;
      recordError(`${element.title}: ${err.message}`);
    }
  }
  return true;
}

// Kalender-sync: ét Google Calendar-event pr. lektion, i fagets egen kalender (allerede
// oprettet manuelt af Valdemar i viawievaldi@gmail.com). Se ValdiVault:
// 10_Projects/VIAstudyWiz/03-kalender-integration.md.
const COURSE_DISPLAY_NAMES = {
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
  const literature = planLiteratureText(plan);
  if (literature) {
    lines.push("", "📖 Tilhørende litteratur:", literature);
  }
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

async function callCalendarApi(token, url, method, body) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res;
}

async function upsertCalendarEvent(token, calendarId, itslearningEventId, body, eventMap) {
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
  const existingGoogleEventId = eventMap[itslearningEventId];

  let res;
  if (existingGoogleEventId) {
    res = await callCalendarApi(token, `${base}/${existingGoogleEventId}`, "PATCH", body);
    if (res.status === 404 || res.status === 410) {
      // Eventet er væk i Google (fx manuelt slettet) — vores gemte mapping er forældet, opret nyt.
      delete eventMap[itslearningEventId];
      res = await callCalendarApi(token, base, "POST", body);
    }
  } else {
    res = await callCalendarApi(token, base, "POST", body);
  }

  if (!res.ok) {
    throw new Error(`Calendar API-fejl (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  eventMap[itslearningEventId] = data.id;
  return data;
}

// itslearning koder "ingen specifik tid angivet" for en plan som 00:01–23:59 (næsten hele
// døgnet), ikke null/undefined — bekræftet live for en Musik-lektion uden tidsangivelse (issue
// #30, plan-id 1158094: start 00:01:00, stop 23:59:00, itslearnings egen UI viser ingen tid).
// En rigtig lektion varer aldrig et helt døgn, så en varighed på 23+ timer er den pålidelige
// detektor — mere robust end at matche de eksakte klokkeslæt, hvis itslearning bruger en anden
// buffer et andet sted.
function planHasSpecificTime(plan) {
  if (!plan?.start || !plan?.stop) return false;
  const durationHours = (new Date(plan.stop) - new Date(plan.start)) / 3600000;
  return durationHours < 23;
}

async function syncCalendar(result) {
  const token = await getAuthToken();
  const calendarIds = await fetchCalendarIdMap(token);
  const eventMap = await getEventMap();

  const matchable = result.events.filter((e) => COURSE_DISPLAY_NAMES[e.title]).length;
  console.log(
    `VIAstudyWiz: ${result.events.length} events hentet, ${matchable} matcher en kendt fag→kalender-mapping, ${Object.keys(calendarIds).length} Google-kalendere fundet:`,
    calendarIds
  );

  for (const event of result.events) {
    const calendarName = COURSE_DISPLAY_NAMES[event.title];
    if (!calendarName) continue; // ukendt/afsluttet/ikke-mappet fag, spring over

    const calendarId = calendarIds[calendarName];
    if (!calendarId) {
      console.warn(`VIAstudyWiz: ingen Google-kalender fundet ved navn "${calendarName}"`);
      continue;
    }

    const planKey = (event.PlanIds ?? [])[0] ? `${event.courseId}:${event.PlanIds[0]}` : null;
    const plan = planKey ? result.plans[planKey] : null;
    if (planKey && !plan) {
      // planKey findes, men blev ikke i result.plans — fetchPlan fejlede stille, IKKE
      // eventual-consistency (den ville have givet et tomt event.PlanIds, se issue #25).
      console.warn(`VIAstudyWiz: plan ${planKey} manglede i result.plans selvom event.PlanIds havde den — fetchPlan fejlede for "${event.title}".`);
    } else if (!planKey) {
      console.log(`VIAstudyWiz: event "${event.title}" har tomt PlanIds (itslearnings myEvents er eventual consistent her) — bruger lokale-tid indtil en senere kørsel retter det.`);
    }

    // upsertCalendarEvent muterer eventMap, så "var det nyt" skal fanges før kaldet — ellers
    // tæller vi hver PATCH af et allerede-synkroniseret event som "nyt" (kører hver kørsel).
    const wasNew = !eventMap[event.id];

    // event.start/event.end er lokale-bookingen for hele blokken (fx 08:15-15:45), ikke
    // nødvendigvis selve lektionens tidspunkt — undervisere kan ændre det i selve planen uden at
    // kunne ændre lokale-bookingen. plan.start/plan.stop er den planlagte tid og matcher
    // event-blokken 1:1 når intet er ændret (bekræftet live: samme værdier for en lektion uden
    // afvigelse), men afviger korrekt når underviseren har indsnævret tidspunktet i planen (fx
    // Livsoplysning 17/8: event 08:15-15:45, plan.start/stop 10:00-15:00). Brug derfor plan-tiden
    // når den findes.
    const titlePart = stripWeekdayPrefix(event.PlanTitle ?? plan?.title) || event.title;
    // plan.topic.name er samme strukturerede "Emne"-felt som nu står i ugemappe-navnet
    // (weekFolderName ovenfor) — sat forrest i titlen så det er synligt uden at åbne eventet.
    const topic = plan?.topic?.name?.trim();
    const summaryTitle = topic ? `${topic} — ${titlePart}` : titlePart;
    // 📖 gør det synligt i kalenderoverblikket at der er noget at læse forud for lektionen, uden
    // at fylde hele teksten ind i titlen — den fulde tekst står i beskrivelsen (buildEventDescription).
    const literaturePrefix = plan && planLiteratureText(plan) ? "📖 " : "";
    const body = {
      status: "confirmed", // PATCH på et manuelt slettet (= "cancelled") event genopliver det ikke
      // automatisk medmindre status eksplicit sættes tilbage - Google bevarer ellers feltet.
      summary: `${literaturePrefix}${calendarName} — ${summaryTitle}`,
      location: event.parsedDescription?.room ?? "",
      description: buildEventDescription(plan),
    };
    if (planHasSpecificTime(plan)) {
      body.start = { dateTime: toGoogleDateTime(plan.start), timeZone: TIME_ZONE };
      body.end = { dateTime: toGoogleDateTime(plan.stop), timeZone: TIME_ZONE };
    } else if (plan || wasNew) {
      // To tilfælde deler samme fallback: (1) plan er hentet, men underviseren har ikke sat en
      // specifik tid (sentinel-værdi, se planHasSpecificTime) — et bekræftet "ingen override"-svar,
      // ikke en midlertidig manglende plan, så det er trygt at bruge lokale-blokken uanset om
      // eventet er nyt. (2) intet plan endnu og eventet er nyt — lokale-blokken som startgæt.
      body.start = { dateTime: toGoogleDateTime(event.start), timeZone: TIME_ZONE };
      body.end = { dateTime: toGoogleDateTime(event.end), timeZone: TIME_ZONE };
    }
    // else: intet plan endnu (og eventet findes allerede i Google) — udelad start/end fra PATCH'en
    // så en tidligere korrekt plan-tid ikke overskrives med lokale-blokken (roden til issue #25).
    try {
      const created = await upsertCalendarEvent(token, calendarId, event.id, body, eventMap);
      console.log(
        `VIAstudyWiz: "${body.summary}" -> kalender-id ${calendarId}, event-link ${created.htmlLink}`
      );
      if (wasNew) runEventsSynced++;
    } catch (err) {
      console.error(`VIAstudyWiz kalender-fejl (${body.summary}):`, err);
      recordError(`${body.summary}: ${err.message}`);
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
  enableMetadataExport: false,
  alarmIntervalHours: 24,
};

async function getSettings() {
  const { [SETTINGS_KEY]: settings } = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...settings };
}

// Uden denne lås kan et ekstra klik (eller alarmen der fyrer midt i en kørsel) starte en ny
// collectAndDownload() oveni den gamle. De skjulte faner og globale webRequest-listeners i
// downloadFileElements er ikke skoped til en bestemt kørsel, så to samtidige kørsler roder i
// hinandens faner/lyttere — det gav "Cannot access contents of the page", "result er null" og
// en bunke USER_CANCELED downloads.
let isRunning = false;

async function runCollectAndDownload() {
  if (isRunning) {
    console.log("VIAstudyWiz: kørsel allerede i gang, springer over");
    return;
  }
  isRunning = true;
  try {
    const { daysBack, daysForward } = await getSettings();
    const now = Math.floor(Date.now() / 1000);
    const start = now - daysBack * 24 * 60 * 60;
    const end = now + daysForward * 24 * 60 * 60;
    await collectAndDownload(start, end);
  } catch (err) {
    console.error("VIAstudyWiz fejl:", err);
    notifyCriticalFailure(err);
  } finally {
    isRunning = false;
  }
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
