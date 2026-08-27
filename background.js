// Vaultens to rodmapper hedder faktisk "🎓 FAG" og "📝 NOTER" (omdøbt manuelt i Finder for at
// gøre dem nemmere at få øje på), men var tidligere hardcodet som literal "FAG"/"NOTER" i hver
// enkelt sti-byggende funktion. getDirectoryHandle(navn, {create:true}) opretter en NY mappe hvis
// navnet ikke matcher præcis — uden disse konstanter ville næste kørsel altså have oprettet tomme
// "FAG"/"NOTER"-mapper ved siden af de rigtige, og fremtidigt indhold ville splittes over to
// steder (issue #63). Ret navnene her, ét sted, hvis rødderne nogensinde omdøbes igen.
const FAG_ROOT = "§ FAG";
const NOTER_ROOT = "✎ NOTER";

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

// Returnerer null hvis filen ikke findes endnu — bruges af writePlanNotes til at afgøre om en
// note skrives for første gang eller skal splejses (se spliceAutoSection).
async function readFromVault(path) {
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({ target: "offscreen", type: "readFile", path });
  if (!response?.ok) {
    throw Object.assign(new Error(response?.error ?? "Ukendt fejl ved fillæsning i offscreen-dokumentet"), {
      code: response?.code,
    });
  }
  return response.text;
}

// Flytter en hel ugemappe (RAW/MD, inkl. konverterede materialer og _attachments) — bruges når en
// lektion er blevet udskudt til en anden dato (issue #96, se writePlanNotes). No-op hvis
// kildemappen ikke findes.
async function moveDirInVault(oldPath, newPath) {
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({ target: "offscreen", type: "moveDir", oldPath, newPath });
  if (!response?.ok) {
    throw Object.assign(new Error(response?.error ?? "Ukendt fejl ved flytning i offscreen-dokumentet"), {
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
// Korte, menneskelæsbare linjer om HVAD der ændrede sig i eksisterende lektionsplan-noter (issue
// #74) — adskilt fra runFilesDownloaded/runEventsSynced, som kun tæller. Fyldes af writePlanNotes.
let runChangedNotes = [];

function recordError(message) {
  runErrorCount++;
  runErrorMessages.push(message);
}

// Notifikationens "settings"-tandhjul er macOS/Chromes egen kontrol af om appen må vise
// notifikationer — ikke noget extensionen tegner eller kan reagere på et klik fra, og det leder
// ingen steder hen mod options.html (issue #74). Denne knap er den rigtige vej: et rigtigt
// notifications-API-buttons-array, fanget af onButtonClicked nederst i filen.
const OPEN_SETTINGS_BUTTON = { title: "Åbn indstillinger" };

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
    // VAULT_PERMISSION-fejl er den hyppigste årsag til at elementer fejler (README: tilladelsen
    // overlever ikke pålideligt en genstart) — "åbn indstillinger og vælg vault-mappen igen" er
    // allerede den dokumenterede løsning, så knappen dækker det almindelige tilfælde selvom ikke
    // alle fejl reelt er tilladelses-relaterede.
    buttons: [OPEN_SETTINGS_BUTTON],
  });
}

// Vises kun hvis der faktisk skete noget (nye filer/events/ændret indhold) — ellers ville den
// daglige alarm give en notifikation hver dag selv i det normale tilfælde, hvor der ikke er noget
// nyt. Ændringslisten (issue #74) er kappet ligesom fejllisten ovenfor, af samme grund: mange
// samtidigt ændrede lektioner (fx en underviser der retter en hel uges planer) må ikke give en
// notifikation der vokser ubegrænset.
function notifySuccessIfNoteworthy() {
  if (runFilesDownloaded === 0 && runEventsSynced === 0 && runChangedNotes.length === 0) return;
  const shown = runChangedNotes.slice(0, 5);
  const rest = runChangedNotes.length - shown.length;
  const changedBlock = shown.length
    ? `\n\nÆndret:\n${shown.join("\n")}` + (rest > 0 ? `\n+${rest} note(r) mere` : "")
    : "";
  chrome.notifications.create({
    type: "basic",
    iconUrl: chrome.runtime.getURL("icon128.png"),
    title: "VIAstudyWiz — kørsel færdig",
    message: `${runFilesDownloaded} fil(er) hentet, ${runEventsSynced} kalender-event(s) synkroniseret.${changedBlock}`,
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

  // itslearning kan have en plan der aldrig får et event.PlanIds-link (issue #92, live-verificeret
  // 2026-08-17: en Musik-lektion med reelt indhold i Planner havde intet linket kalender-event —
  // det ene event i vinduet var et generisk lokale-bookings-event for en helt anden tidsblok).
  // plans/current/v1 lister planer direkte pr. fag, uafhængigt af myEvents — bruges HER kun til at
  // finde planId'er der mangler i planKeys nedenfor. Selve plan-indholdet hentes stadig via
  // fetchPlan ovenfor (samme /v2-endpoint som alt andet), så resten af koden ikke skal kende to
  // forskellige plan-objektformer.
  async function fetchCoursePlansPage(courseId, pageIndex, pageSize) {
    const url = `${BASE}/restapi/personal/course/${courseId}/plans/current/v1?PageIndex=${pageIndex}&PageSize=${pageSize}&ChildId=0`;
    return fetchJson(url);
  }

  // Kappet til 5 sider (250 planer) som sikkerhed mod et kursus med usædvanligt mange planer —
  // ikke observeret i praksis (20 planer dækkede ~6 uger frem for Musik), men bedre en for lav grænse
  // for daysForward end en uendelig løkke. Stopper tidligere hvis en side kommer tilbage kortere end
  // pageSize (sidste side) eller tom.
  const ORPHAN_PLAN_PAGE_SIZE = 50;
  const MAX_ORPHAN_PLAN_PAGES = 5;

  async function fetchOrphanPlanCandidateIds(courseId) {
    const ids = [];
    for (let pageIndex = 0; pageIndex < MAX_ORPHAN_PLAN_PAGES; pageIndex++) {
      const page = await fetchCoursePlansPage(courseId, pageIndex, ORPHAN_PLAN_PAGE_SIZE);
      const entries = page?.entityArray ?? [];
      if (entries.length === 0) break;
      for (const entry of entries) {
        const startMs = new Date(entry.start).getTime();
        if (startMs >= startUnix * 1000 && startMs <= endUnix * 1000) ids.push(entry.id);
      }
      if (entries.length < ORPHAN_PLAN_PAGE_SIZE) break;
    }
    return ids;
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

  // Afleveringsopgavers deadline findes ikke i plan.elements (de Arbejdsopgave-elementer der ligger
  // dér har ingen deadline overhovedet) — den kommer fra dette kursus-niveau-endpoint, ét kald pr.
  // kursus, som returnerer alle opgaver for hele kurset uanset lektionsplan (issue #45,
  // live-inspektion på tværs af alle 12 rum). Endpointet blander opgavetyper: opgaver uden reel
  // deadline bærer sentinel-værdien 9999-12-31 og er de samme "Forberedelse"-elementer der allerede
  // vises i lektionsplanerne — uden filteret ville Kristendomskundskab alene give 13 tomme
  // duplikat-noter. Ét fag der fejler må ikke vælte resten af kørslen, derfor try/catch pr. kursus.
  async function fetchTasks(courses) {
    const tasks = [];
    for (const course of courses) {
      try {
        const data = await fetchJson(`${BASE}/restapi/personal/tasklistdailyworkflow/${course.CourseId}/v1`);
        // Svaret er grupperet i sektioner ("Afleveringsfrist senere", "Der er ikke nogen deadline",
        // ...) — data.EntityArray er sektionerne, ikke opgaverne selv. De faktiske opgaver ligger
        // ét niveau dybere i hver sektions TaskDailyWorkflow.EntityArray. Bekræftet live 2026-08-12
        // mod kursus 36016 (Musik).
        const list = (data.EntityArray ?? []).flatMap((section) => section.TaskDailyWorkflow?.EntityArray ?? []);
        for (const task of list) {
          if (!task.Deadline || task.Deadline.startsWith("9999")) continue;
          // Endpointet er ikke bundet til tidsrummet som myEvents er — uden denne grænse ville
          // hele kursets afleveringshistorik blive til noter og kalenderevents bagud i tiden.
          // Kun nedre grænse: en deadline længere ude end daysForward er stadig relevant at kende.
          if (new Date(task.Deadline).getTime() < startUnix * 1000) continue;
          tasks.push(task);
        }
      } catch (err) {
        console.warn(`VIAstudyWiz: kunne ikke hente opgaveliste for ${course.CourseId}:`, err);
      }
    }
    return tasks;
  }

  // "Forberedelse" og andre Arbejdsopgave-elementer bærer INTET indhold i plan.elements — kun
  // titel, id og en URL til CustomActivity-siden (issue #59, bekræftet mod 16 elementer på tværs af
  // 3 fag i gemte metadata-dumps). Siden er almindelig server-renderet HTML, så en ren fetch er nok:
  // ingen SSO-handshake, ingen skjult fane som fil-kæderne og Afleveringsopgave-værktøjet kræver
  // (live-inspiceret 2026-08-12). Selve beskrivelsen ligger i præcis ét .h-userinput-element —
  // valgt frem for at matche <h2>Beskrivelse</h2>, som er sprogafhængig.
  async function fetchActivityBody(element) {
    const res = await fetch(element.url, { credentials: "include" });
    const doc = new DOMParser().parseFromString(await res.text(), "text/html");
    const body = doc.querySelector(".h-userinput");
    if (!body) return null;
    // Indlejrede dokumenter (Google Docs, Office, Padlet o.l.) ligger som iframes, og stripHtml
    // fjerner iframes helt — linket ville altså FORSVINDE, ikke bare blive fladtrykt til tekst.
    // itslearning pakker dem i sin egen oembed-viser med det rigtige mål i ?Url=; uden udpakningen
    // ville linket pege på wrapperen i stedet for dokumentet. Bekræftet live på et Dansk-element.
    for (const frame of body.querySelectorAll("iframe[src]")) {
      const src = new URL(frame.getAttribute("src"), location.origin);
      const link = doc.createElement("a");
      link.setAttribute("href", src.searchParams.get("Url") ?? src.href);
      link.textContent = "Indlejret dokument";
      frame.replaceWith(link);
    }
    return body.innerHTML;
  }

  const courses = await fetchCourses();
  const courseIds = courses.map((c) => c.CourseId);
  const events = await fetchMyEvents(courseIds, startUnix, endUnix);
  const tasks = await fetchTasks(courses);

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

  // Forældreløse planer (issue #92): findes i Planner, men uden noget linket kalender-event —
  // planKeys ovenfor ser dem derfor aldrig, uanset hvor mange gange kørslen gentages. Ét fags
  // fejl (kursus lukket, midlertidigt utilgængeligt) må ikke vælte resten af kørslen, samme
  // mønster som fetchTasks ovenfor.
  const orphanPlans = {};
  for (const courseId of courseIds) {
    try {
      const candidateIds = await fetchOrphanPlanCandidateIds(courseId);
      for (const planId of candidateIds) {
        const key = `${courseId}:${planId}`;
        if (planKeys.has(key)) continue; // allerede dækket via et kalender-event
        orphanPlans[key] = await fetchPlan(courseId, planId);
      }
    } catch (err) {
      console.warn(`VIAstudyWiz: kunne ikke hente forældreløse planer for kursus ${courseId}:`, err);
    }
  }

  // Antallet af kald er allerede afgrænset af tidsvinduet (kun planer i vinduet er hentet ovenfor).
  // Fejler ét element, står titlen der stadig — den kommer fra plan.elements — og kun teksten
  // mangler; det må ikke vælte resten af kørslen.
  for (const plan of Object.values(plans)) {
    for (const element of plan?.elements ?? []) {
      if (element.typeName !== "Arbejdsopgave") continue;
      try {
        element.body = await fetchActivityBody(element);
      } catch (err) {
        console.warn(`VIAstudyWiz: kunne ikke hente Forberedelse-indhold for "${element.title}":`, err);
      }
    }
  }

  return {
    courses,
    events: events.map((e) => ({ ...e, parsedDescription: parseDescription(e.apiDescriptionPlainText ?? "") })),
    plans,
    orphanPlans,
    tasks,
  };
}

async function collectAndDownload(startUnix, endUnix) {
  console.log(`VIAstudyWiz: starter kørsel (${new Date(startUnix * 1000).toISOString()} → ${new Date(endUnix * 1000).toISOString()})`);
  runErrorCount = 0;
  runErrorMessages = [];
  runFilesDownloaded = 0;
  runEventsSynced = 0;
  runChangedNotes = [];
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
    `VIAstudyWiz: hentede ${result.courses.length} fag, ${result.events.length} events, ${Object.keys(result.plans).length} planer, ${(result.tasks ?? []).length} opgaver med deadline`
  );

  // Kalender + filer først — så en evt. hængende gem-dialog for JSON-metadata (se nedenfor)
  // ikke blokerer det der faktisk betyder noget.
  if (settings.enableCalendarSync) await syncCalendar(result);
  let vaultPermissionMissing = false;
  if (settings.enableFileDownloads) {
    const notesOk =
      (await writePlanNotes(result.plans, tab.id, settings.enableTaskCompletionSync)) && (await writeTaskNotes(result.tasks ?? []));
    // Spring downloads over hvis tilladelsen allerede er væk — ingen grund til at åbne skjulte
    // faner og resolve download-URL'er for filer der alligevel ikke kan skrives.
    const filesOk = notesOk && (await downloadFileElements(result.plans, tab.id));
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
// Begge grene logger, fordi fallbacken ellers er usynlig når den virker — uden log-linjen kan man
// ikke se forskel på "fallbacken reddede filen" og "URL'en havde endelsen hele tiden", og så kan
// #57's manglende end-to-end-test aldrig krydses af (issue #80).
async function extractExtensionFromWopi(wopiContentsUrl) {
  const checkFileInfoUrl = wopiContentsUrl.replace(/\/contents(\?|$)/, "$1");
  try {
    const res = await fetch(checkFileInfoUrl);
    if (!res.ok) throw new Error(`CheckFileInfo svarede ${res.status}`);
    const { BaseFileName } = await res.json();
    const match = (BaseFileName ?? "").match(/\.[a-z0-9]{2,5}$/i);
    console.log(`VIAstudyWiz: WOPI CheckFileInfo → BaseFileName "${BaseFileName}", endelse "${match?.[0] ?? "(ingen)"}"`);
    return match ? match[0].toLowerCase() : "";
  } catch (err) {
    // Fanget frem for at boble op: kalderens "kunne ikke udlede filendelse"-warn er en bedre
    // besked på elementet end en rå fetch/JSON-parse-fejl, og den her linje har detaljerne.
    console.warn(`VIAstudyWiz: WOPI CheckFileInfo fejlede (${checkFileInfoUrl}):`, err);
    return "";
  }
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

// Returnerer { url, fileName } — Viewer.aspx-kaldet bærer ALTID en FileName-parameter (fx
// "Frede+V+Nielsen+Ars+og+Scientia+dimensionen.pdf") ved siden af selve FileDownloadUrl, men den
// endelige filerepository.itslearning.com-URL (som FileDownloadUrl peger på) har hverken endelse i
// stien eller i noget response-content-disposition-parameter — kun en opak GUID + Token +
// "Download=1". Uden at fange FileName her mister vi den eneste kilde til filendelsen for
// elementer hvis titel selv mangler den (issue fundet 2026-08-18, element "Frede V Nielsen Ars og
// Scientia dimensionen" uden ".pdf"-suffiks i titlen).
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
      const params = new URL(details.url).searchParams;
      const fileDownloadUrl = params.get("FileDownloadUrl");
      if (fileDownloadUrl) {
        cleanup();
        resolve({ url: fileDownloadUrl, fileName: params.get("FileName") });
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
// Returnerer altid { url, fileName } — Office-kæden har ingen tilsvarende FileName-kilde (den går
// aldrig gennem Viewer.aspx), så fileName er null der. Det er OK: WOPI-fallbacken i
// downloadFileElements løser samme problem for Office-dokumenter via CheckFileInfo i stedet.
async function resolveDownloadUrlUnknownType(elementUrl) {
  try {
    return await resolvePdfDownloadUrl(elementUrl, 10000);
  } catch {
    const url = await resolveOfficeDownloadUrl(elementUrl);
    return { url, fileName: null };
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

// Separat fra downloadedElementIds: dén er en simpel tilstedeværelse-Set (fil/opgave enten
// hentet eller ej), men lektionsplan-noter skal opdages som "ændret" så underviserens rettelser
// til beskrivelsen ikke drifter væk fra noten (issue #61) — derfor gemmes et indholds-hash pr.
// plan i stedet for bare et boolean. Ikke-kryptografisk (planKollisions-risiko er irrelevant
// her, vi skal bare opdage "ændrede sig teksten") — undgår at skulle awaite Web Crypto for noget
// der kører synkront i en loop over alle ugens planer.
const PLAN_NOTE_HASHES_KEY = "planNoteContentHashes";

async function getPlanNoteRecords() {
  const { [PLAN_NOTE_HASHES_KEY]: records } = await chrome.storage.local.get(PLAN_NOTE_HASHES_KEY);
  return records ?? {};
}

// Ældre lagrede værdier er rene hash-strenge (før issue #96 tilføjede ugemappe-sporing) —
// normaliseres her i stedet for at migrere storage, weekFolder: null betyder bare "ukendt gammel
// placering, spring flytte-detektion over denne ene gang" (opgraderes automatisk ved næste skrivning).
function planNoteRecord(records, noteId) {
  const value = records[noteId];
  if (value == null) return null;
  return typeof value === "string" ? { hash: value, weekFolder: null } : value;
}

async function savePlanNoteRecord(noteId, hash, weekFolder) {
  const records = await getPlanNoteRecords();
  records[noteId] = { hash, weekFolder };
  await chrome.storage.local.set({ [PLAN_NOTE_HASHES_KEY]: records });
}

function simpleHash(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (Math.imul(hash, 31) + text.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
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
function courseDisplayName(courseName) {
  return COURSE_DISPLAY_NAMES[courseName] ?? courseName;
}

// Kun til vault-mappestier og Google Calendar-navne (begge er steder man navigerer visuelt hen —
// Valdemar har omdøbt de faktiske kalendere til at matche, fx "♪ Musik"). IKKE til
// fag:-frontmatter-feltet (courseDisplayName ovenfor), som Seminarium.base filtrerer eksakt på
// (`fag == "Musik"`) — et symbol blandet ind der ville splitte eksisterende og nye noter i to
// grupper i stedet for at være rent kosmetisk (issue #63).
// LivsOplysning bruger ⚖︎ (U+2696 + U+FE0E, tekst-variationsselector) i stedet for bare ⚖ — uden
// den render macOS/Apples emoji-font symbolet farvet, selvom Unicode-standarden angiver monokrom
// som default presentation (bekræftet 2026-08-12). ♪/♱ har ingen emoji-variant og rammer altid
// monokromt uden selektoren.
const FOLDER_SYMBOLS = { Musik: "♪", Religion: "♱", LivsOplysning: "⚖︎" };

function courseFolderName(courseName) {
  const display = courseDisplayName(courseName);
  const symbol = FOLDER_SYMBOLS[display];
  return symbol ? `${symbol} ${display}` : display;
}

// Samme symbol-logik som courseFolderName, men bevarer courseFolderName/COURSE_DISPLAY_NAMES'
// oprindelige "undefined for ukendt kursus"-kontrakt — kaldere bruger `if (!calendarName)
// continue` til at springe ukendte/ikke-mappede kurser stille over, og skal blive ved med det.
function courseCalendarName(courseName) {
  const display = COURSE_DISPLAY_NAMES[courseName];
  if (!display) return undefined;
  const symbol = FOLDER_SYMBOLS[display];
  return symbol ? `${symbol} ${display}` : display;
}

// Fritekstfelt underviseren selv udfylder — henviser ofte til grundbogssider, ikke kun vedhæftede
// filer, så det kan ikke kobles til bestemte elementer. headingText starter altid med
// "Tilhørende litteratur", men har varierende parentes-tilføjelser pr. underviser/kursus.
// field.text er kun rent tekst når isPlainText er sat — nogle undervisere bruger rig tekst i
// feltet, hvor text i stedet indeholder rå HTML (bekræftet live, fx "<p><span
// style=...>...</span></p>" for et Musikforståelse-felt). stripHtml() bruges derfor altid, den
// er et no-op på allerede rent tekst.
function planLiteratureText(plan) {
  const text = plan.fields?.find((f) => f.headingText?.includes("Litteratur"))?.text;
  return text ? stripHtml(text) || null : null;
}

// Arbejdsopgave-elementer er itslearnings "gør noget"-side af en lektion, modsat litteratur-feltets
// "læs noget" (issue #59). Skellet ligger i BÆREREN, ikke i indholdet: et element med titlen
// "Forberedelse" kan sagtens indeholde en ren litteraturliste (bekræftet live på et Religion-
// element), for itslearning har ét enkelt fritekstfelt til det hele. Vi holder derfor de to kilder
// adskilt i noten og gætter aldrig på hvad teksten "egentlig" er.
// Titler trimmes: mindst ét element hedder "Forberedelse " med afsluttende mellemrum.
function forberedelseElements(plan) {
  return (plan.elements ?? [])
    .filter((el) => el.typeName === "Arbejdsopgave")
    .map((el) => ({ titel: (el.title ?? "Forberedelse").trim(), body: el.body, url: el.url, isCompleted: el.isCompleted ?? false }));
}

// YAML literal block scalar (|) — undgår escaping af anførselstegn/kolon/linjeskift i fritekst,
// som en almindelig citeret streng ellers ville kræve. Obsidian viser det som flerlinjet tekst
// i Properties-panelet.
function yamlBlockLines(key, text) {
  return [`${key}: |`, ...text.split("\n").map((line) => `  ${line}`)];
}

function rawPath(courseName, weekFolder, title) {
  return `${FAG_ROOT}/${sanitizeFilename(courseFolderName(courseName))}/RAW/${weekFolder}/${sanitizeFilename(title)}`;
}

// watch_viastudywiz.py navngiver MD-noten efter RAW-filens stem (Path.stem, dvs. alt før sidste
// "."), sanitized samme vej — se md_targets() i watchfolder/watch_viastudywiz.py. Title indeholder
// typisk selve endelsen allerede (fx "Titel.docx"), så den skal strippes, ikke bare have .md
// tilføjet oveni.
function mdPath(courseName, weekFolder, title) {
  const stem = sanitizeFilename(title).replace(/\.[^./]+$/, "");
  return `${FAG_ROOT}/${sanitizeFilename(courseFolderName(courseName))}/MD/${weekFolder}/${stem}.md`;
}

// § FAG/<fag>/NOTER/<uge>/ — søskende til RAW/MD, ikke en separat NOTER-rod (issue #65 §11:
// Valdemar har ADHD og har brug for ét sted pr. fag at kigge, ikke tre rødder at huske).
function noteStubPath(courseName, weekFolder) {
  return `${FAG_ROOT}/${sanitizeFilename(courseFolderName(courseName))}/NOTER/${weekFolder}/[NOTE] ${weekFolder}.md`;
}

// Stubbens Forberedelse-sektion (issue #59): kun titlen som afkrydsningslinje, aldrig indholdet.
// Indholdet står i lektionsplan-notens AUTO-blok, som kilde: wikilinker til, og som genskrives når
// underviseren retter noget. Stod teksten også her, ville Valdemars egen fil — der per design
// aldrig overskrives — drifte væk fra itslearning uden at nogen kunne se det.
const FORB_HEADING = "## ⚒ Forberedelse";

// Skriver kun hvis filen ikke findes i forvejen — modsat lektionsplan-noten (som genskrives når
// planen ændrer sig), er denne stub udelukkende til at give Valdemar et sted at skrive: findes
// den allerede, er den hans, og røres aldrig igen. Et rigtigt exists-tjek (readFromVault),
// ikke written.has(noteId) (muterbar download-log) — samme klasse beskyttelse som
// already_converted() i watch_viastudywiz.py, se 12-notestruktur-egne-noter.md §6.
// Eneste undtagelse er nye afkrydsningslinjer, som APPENDES (se nedenfor) — eksisterende linjer,
// og dermed hans afkrydsninger, røres aldrig.
// Tager hele plan'en frem for fag/uge/emne/start hver for sig: felterne udledes alligevel her, og
// signaturen var på vej mod syv parametre da Forberedelse kom til.
// Returnerer false hvis vault-tilladelsen mangler, ellers true (fejl på selve stubben er ikke
// kritiske nok til at stoppe resten af kørslen — kun logges via recordError).
async function writeLectureNoteStub(plan, weekFolder, lektionsplanPath, forberedelse, tabId, syncEnabled) {
  const courseName = plan.courseName ?? "ukendt-fag";
  const path = noteStubPath(courseName, weekFolder);
  const labels = forberedelse.map((el) => `⚒ ${el.titel}`);
  try {
    const existing = await readFromVault(path);
    if (existing != null) {
      // issue #70: kun når afkrydsningen allerede er sat af Valdemar — nye stubbe kan ikke have
      // et flueben, så tjekket giver først mening her, ikke ved førstegangs-skrivning nedenfor.
      if (syncEnabled) {
        const afkrydsede = new Set(
          existing.split("\n").filter((line) => /^- \[[xX]\]/.test(line.trim())).map((line) => line.replace(/^- \[[xX]\]\s*/, "").trim())
        );
        const skalMarkeres = forberedelse.filter((el) => !el.isCompleted && afkrydsede.has(`⚒ ${el.titel}`));
        if (skalMarkeres.length) await completeTasks(skalMarkeres, tabId);
      }
      // Underviseren kan tilføje en Forberedelse EFTER stubben blev skrevet — uden dette ville den
      // aldrig dukke op i noten, fordi stubben kun skrives én gang.
      // ponytail: matcher på titel, ikke element-id. To elementer med IDENTISK titel i samme
      // lektion giver kun én linje; et id i en HTML-kommentar er opgraderingen hvis det sker.
      const nye = labels.filter((label) => !existing.includes(label)).map((label) => `- [ ] ${label}`);
      if (nye.length === 0) return true;
      const opdateret = existing.includes(FORB_HEADING)
        ? existing.replace(FORB_HEADING, [FORB_HEADING, ...nye].join("\n"))
        : `${existing.trimEnd()}\n\n${[FORB_HEADING, ...nye].join("\n")}\n`;
      await writeToVault(path, `data:text/markdown;charset=utf-8,${encodeURIComponent(opdateret)}`);
      return true;
    }
    const topic = plan.topic?.name?.trim();
    const kildeStem = lektionsplanPath.slice(lektionsplanPath.lastIndexOf("/") + 1).replace(/\.md$/, "");
    const note = [
      "---",
      "type: note",
      `fag: ${courseDisplayName(courseName)}`,
      `uge: ${weekFolderBase(plan)}`,
      ...(topic ? [`emne: "${topic}"`] : []),
      // uge (W33fre) sorterer alfabetisk og scrambler ugedagene — start er den universelle,
      // kronologiske nøgle, samme lærepenge som Seminarium.base's sorteringsfejl i issue #65.
      `start: "${toGoogleDateTime(plan.start ?? "").replace("T", " ")}"`,
      `kilde: "[[${kildeStem}]]"`,
      "tags: []",
      "---",
      "",
      `Kilde: [[${kildeStem}]]`,
      "",
      ...(labels.length ? [FORB_HEADING, ...labels.map((label) => `- [ ] ${label}`), ""] : []),
    ].join("\n");
    await writeToVault(path, `data:text/markdown;charset=utf-8,${encodeURIComponent(note)}`);
    return true;
  } catch (err) {
    console.error(`VIAstudyWiz forelæsningsnote-stub-fejl (${path}):`, err);
    if (err.code === "VAULT_PERMISSION") return false;
    recordError(`Forelæsningsnote (${weekFolder}): ${err.message}`);
    return true;
  }
}

// issue #70: CustomActivity-siden er en almindelig WebForms-postback uden UpdatePanel (live-målt
// 2026-08-12), så et rent form-POST med de skjulte felter er nok — samme GET som
// fetchActivityBody allerede laver. Selvstændig funktion (ingen closures over ydre scope) fordi
// den injiceres i itslearning-fanen via chrome.scripting.executeScript, samme grund som
// fetchActivityBody kun kan køre i selve fanen: session-cookien findes kun der.
async function toggleTaskCompletedInPage(url) {
  const getRes = await fetch(url, { credentials: "include" });
  const doc = new DOMParser().parseFromString(await getRes.text(), "text/html");
  const field = (name) => doc.querySelector(`[name="${name}"]`)?.value ?? "";
  const body = new URLSearchParams({
    __ITSL_CSRF_TOKEN__: field("__ITSL_CSRF_TOKEN__"),
    __EVENTTARGET: "ctl00$ContentPlaceHolder$TaskCompletedToggle",
    __EVENTARGUMENT: "",
    __VIEWSTATE: field("__VIEWSTATE"),
    __VIEWSTATEGENERATOR: field("__VIEWSTATEGENERATOR"),
    __EVENTVALIDATION: field("__EVENTVALIDATION"),
  });
  await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

// Kun én retning ([ ] → [x] i noten poster til itslearning, aldrig omvendt) og kun når
// isCompleted allerede er false — isCompleted kommer med i plan.elements ved hver kørsel, så det
// ER idempotens-tjekket, ingen selvstændig log nødvendig. WebForms svarer 200 + en fejlside ved et
// udløbet __EVENTVALIDATION i stedet for en fejlkode (issue #70), så succes verificeres ikke her —
// et fejlet POST retter sig selv ved næste kørsel, fordi isCompleted så stadig er false og noten
// stadig har [x]. ponytail: ingen re-GET til at bekræfte samme kørsel, næste kørsels friske
// isCompleted er verifikationen.
async function completeTasks(forberedelse, tabId) {
  for (const el of forberedelse) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, func: toggleTaskCompletedInPage, args: [el.url] });
    } catch (err) {
      console.error(`VIAstudyWiz TaskCompletedToggle-fejl ("${el.titel}"):`, err);
      recordError(`Kunne ikke markere "${el.titel}" som fuldført i itslearning: ${err.message}`);
    }
  }
}

// "hentet:" i frontmatter — lokal væg-tid i samme tidszone som resten af extensionen (TIME_ZONE),
// ikke maskinens egen, og samme "yyyy-MM-dd HH:mm"-format som start/stop-felterne ovenfor, for
// konsistens (issue #34). Opdateres hver gang AUTO-sektionen i en lektionsplan-note regenereres
// (issue #61), ikke kun ved første hentning — fungerer derfor reelt som et "sidst opdateret".
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

const AUTO_START = "<!-- AUTO:START -->";
const AUTO_END = "<!-- AUTO:END -->";
const AUTO_BLOCK_RE = new RegExp(`${AUTO_START}[\\s\\S]*?${AUTO_END}`);

// Lektionsplan-noten har to zoner: frontmatter + AUTO-sektionen er 100% maskin-ejet og
// genskrives hver gang planens indhold ændrer sig (issue #61) — alt uden for AUTO-markørerne er
// Valdemars eget og røres aldrig. Findes markørerne ikke i en eksisterende fil (en note skrevet
// før denne splejsning fandtes), regnes hele det gamle indhold som hans eget og bevares under
// den nye AUTO-sektion i stedet for at gætte på hvor den gamle grænse gik.
function spliceAutoSection(existingBody, autoContent) {
  const autoBlock = `${AUTO_START}\n${autoContent}\n${AUTO_END}`;
  if (existingBody == null) return autoBlock;
  if (AUTO_BLOCK_RE.test(existingBody)) return existingBody.replace(AUTO_BLOCK_RE, autoBlock);
  return `${autoBlock}\n\n${existingBody}`;
}

// Kort resumé af HVAD der ændrede sig i AUTO-blokken, til succes-notifikationen (issue #74) — ikke
// en rigtig diff-algoritme, kun en linje-baseret mængdeforskel. Nok til at vise "der kom en ny
// linje materiale/Forberedelse ind", for meget for en notifikation ville selve den fulde tekst
// være. Returnerer null hvis der ikke er noget at sammenligne med (ny note) eller intet ændrede sig.
// ponytail: viser kun den FØRSTE tilføjede linje, ikke alle — en fuld linje-diff er overkill for en
// notifikation man alligevel bare klikker væk. Opgraderingsvej: en rigtig linjediff hvis én linje
// viser sig for sparsom i praksis.
function summarizeAutoChange(oldAutoContent, newAutoContent) {
  if (oldAutoContent == null || oldAutoContent === newAutoContent) return null;
  const oldLines = new Set(oldAutoContent.split("\n").map((l) => l.trim()).filter(Boolean));
  const addedLine = newAutoContent
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !oldLines.has(l));
  if (!addedLine) return "indhold fjernet eller omformuleret";
  return addedLine.length > 80 ? `${addedLine.slice(0, 80)}…` : addedLine;
}

// Lektionsplanen hentes allerede til kalender-beskrivelsen — som note i ugemappen binder den
// ugens materialer sammen (og giver Obsidian Bases noget at gruppere efter). Frontmatter og
// AUTO-sektionen genskrives når planens indhold (beskrivelse/materialer/emne) reelt ændrer sig —
// sporet via et content-hash pr. plan (getPlanNoteRecords), ikke bare "er filen skrevet før", så
// underviserens rettelser ikke drifter væk fra noten (issue #61). Alt Valdemar selv skriver i
// filen uden for AUTO-markørerne bevares uanset, se spliceAutoSection.
// Returnerer false hvis vault-tilladelsen manglede — kalderen bruger det til at springe resten
// af kørslen over (tilladelsen kommer ikke tilbage af sig selv midt i et løb) og til at tænde
// advarsels-badge'et.
async function writePlanNotes(plans, tabId, syncTaskCompletion) {
  const records = await getPlanNoteRecords();

  for (const [planKey, plan] of Object.entries(plans)) {
    const noteId = `plan:${planKey}`;
    if (!plan) continue;

    const weekFolder = weekFolderName(plan);
    const courseName = plan.courseName ?? "ukendt-fag";
    // Symbol-navnet er kun til selve mappestien — fag:-feltet nedenfor skal blive ved den rene
    // værdi (courseDisplayName), da Seminarium.base filtrerer eksakt på den (issue #63).
    const fag = sanitizeFilename(courseFolderName(courseName));
    const fagField = courseDisplayName(courseName);

    // planId'et er stabilt selv når itslearning redigerer start/stop-felterne på en eksisterende
    // plan i stedet for at oprette en ny (fx en reel udskydelse, live-bekræftet 2026-08-27 på
    // Religion: den fortrængte lektions plan beholdt sit id, kun datoen ændrede sig — mens selve
    // tidsspunktet fik en NY placeholder-plan). weekFolderName() er dato-afledt, så en udskudt
    // lektion regner sig frem til en ny mappe her — uden dette flyttes de allerede hentede filer
    // aldrig med, og bliver stående i den gamle ugemappe for evigt (issue #96).
    let prevRecord = planNoteRecord(records, noteId);
    if (prevRecord?.weekFolder && prevRecord.weekFolder !== weekFolder) {
      try {
        await moveDirInVault(`${FAG_ROOT}/${fag}/MD/${prevRecord.weekFolder}`, `${FAG_ROOT}/${fag}/MD/${weekFolder}`);
        await moveDirInVault(`${FAG_ROOT}/${fag}/RAW/${prevRecord.weekFolder}`, `${FAG_ROOT}/${fag}/RAW/${weekFolder}`);
        runChangedNotes.push(`${prevRecord.weekFolder} → ${weekFolder} (${fagField}): lektion flyttet, vault-materialer fulgte med`);
        await savePlanNoteRecord(noteId, prevRecord.hash, weekFolder);
        prevRecord = { hash: prevRecord.hash, weekFolder };
      } catch (err) {
        console.error(`VIAstudyWiz vault-flytning fejlede (${prevRecord.weekFolder} → ${weekFolder}):`, err);
        recordError(`Lektion flyttet (${fagField}, ${prevRecord.weekFolder} → ${weekFolder}): vault-materialer kunne ikke flyttes automatisk — ${err.message}`);
      }
    }
    // Links til MD-noten (navigations-graf), ikke RAW-filen — RAW er bytes til enheder, ikke
    // noget man klikker sig videre til fra en note (issue #26). Mappe/opgave-typer får aldrig en
    // MD-modpart, så de udelades. Link-elementer nævnes som ren tekst (titlen er allerede synlig
    // her) i stedet for en note — automatisk indholds-udtræk blev forsøgt og droppet igen, se #20.
    // Suffikset til itslearning (issue #73) er en nødvendig vej tilbage til ORIGINALEN, ikke bare
    // en genvej: viser et fil-element sig at være en skabelon man selv skal skrive i og aflevere
    // (samme klasse som Forberedelse-elementernes SharePoint-links, issue #59), er MinerU-
    // renderingen ubrugelig til det, og RAW-filen findes kun på disken, ikke i noten.
    const materials = (plan.elements ?? [])
      .filter((el) => el.typeName === "Link" || !NON_FILE_TYPE_NAMES.has(el.typeName))
      .map((el) =>
        el.typeName === "Link"
          ? `- ${el.title} (link — åbn selve lektionsplanen i itslearning for at følge det)`
          : `- [[${mdPath(courseName, weekFolder, el.title)}]] · [itslearning](https://via.itslearning.com${el.url})`
      );
    const topic = plan.topic?.name?.trim();
    const literature = planLiteratureText(plan);
    const forberedelse = forberedelseElements(plan);

    // Skrives hver kørsel, uafhængigt af lektionsplan-hashet nedenfor — stubben skal findes før
    // timen selv når planens indhold ikke har ændret sig siden sidste kørsel.
    const lektionsplanPath = `${FAG_ROOT}/${fag}/MD/${weekFolder}/[PLAN] ${weekFolder}.md`;
    const stubOk = await writeLectureNoteStub(plan, weekFolder, lektionsplanPath, forberedelse, tabId, syncTaskCompletion);
    if (!stubOk) return false;

    // Ligger i AUTO-blokken, så underviserens rettelser følger med (issue #61) — i modsætning til
    // afkrydsningerne i stubben, som er Valdemars og aldrig overskrives. Underoverskrift kun ved
    // flere elementer: 13 af 16 hedder bare "Forberedelse", og "## ⚒ Forberedelse / ### Forberedelse"
    // er ren støj. Link tilbage til itslearning, fordi billeder i beskrivelsen ikke overlever
    // stripHtml (deres URL'er er kortlivede tokens fra filerepository).
    const forberedelseLines = forberedelse.flatMap((el) => [
      "",
      ...(forberedelse.length > 1 ? [`### ${el.titel}`, ""] : []),
      stripHtml(el.body, true) || "_(intet indhold hentet — åbn i itslearning)_",
      "",
      `[Åbn "${el.titel}" i itslearning](https://via.itslearning.com${el.url})`,
    ]);

    const autoContent = [
      `# ${plan.title ?? weekFolder}`,
      "",
      stripHtml(plan.description),
      ...(materials.length ? ["", "## Materialer", ...materials] : []),
      ...(forberedelse.length ? ["", FORB_HEADING, ...forberedelseLines] : []),
    ].join("\n");

    // Hashet dækker kun det maskin-genererede indhold (autoContent), ikke frontmatter — ellers
    // ville "hentet:"-tidsstemplet i frontmatter gøre hashet forskelligt ved hver kørsel uanset
    // om planen reelt ændrede sig, og hele pointen med at undgå unødvendige genskrivninger ville
    // forsvinde.
    // Bagsiden af det: et NYT frontmatter-felt når aldrig ud til noter hvis AUTO-indholdet er
    // uændret — en lektion uden Forberedelse ville aldrig få `forberedelse: false`, og basens
    // `!= false`-filter ville så se et felt der slet ikke findes. Versionsmarkøren tvinger én
    // genskrivning af alle lektionsplan-noter når skemaet ændrer sig, og koster ingenting bagefter.
    // Bump den når frontmatter får nye felter. (Valdemars eget indhold uden for AUTO-markørerne
    // bevares af spliceAutoSection, så genskrivningen er ufarlig.)
    // (#73's itslearning-suffiks på materialer trænger ikke til et bump — det ÆNDRER selve
    // autoContent-strengen, så hashet skifter af sig selv. Bump kun ved rene frontmatter-ændringer.)
    const FRONTMATTER_VERSION = 4; // 2 = forberedelse-feltet (#59), 3 = fjernet dato:-felt, 4 = plan_id: (#96)
    const currentHash = simpleHash(`v${FRONTMATTER_VERSION}\n${autoContent}`);
    if (prevRecord?.hash === currentHash) {
      // Indholdet er uændret, så resten af funktionen springes over — men weekFolder skal stadig
      // opdateres i storage, ellers når en ukendt/forældet placering (fx lige opgraderet fra det
      // gamle streng-format, weekFolder: null) aldrig at blive kendt, og drift-detektionen
      // ovenfor får aldrig en baseline at sammenligne næste gang planen rykker sig (issue #96).
      if (prevRecord.weekFolder !== weekFolder) {
        await savePlanNoteRecord(noteId, currentHash, weekFolder);
      }
      continue;
    }

    const frontmatter = [
      "---",
      `fag: ${fagField}`,
      `uge: ${weekFolderBase(plan)}`,
      ...(topic ? [`emne: "${topic}"`] : []),
      // Intet separat dato:-felt — det var bare start's første 10 tegn, kun til stede på
      // lektionsplan-noter (materiale-noter fra watchfolderen har ingen dato:, men har altid
      // start:). Basens visdato-formel læser start direkte og virker derfor på alle rækketyper.
      // Lektionens rigtige tidspunkt (ikke lokale-bookingens) — se toGoogleDateTime/syncCalendar
      // for hvorfor plan.start/stop er den pålidelige kilde.
      `start: "${toGoogleDateTime(plan.start ?? "").replace("T", " ")}"`,
      `stop: "${toGoogleDateTime(plan.stop ?? "").replace("T", " ")}"`,
      `hentet: "${formatNow()}"`,
      "type: lektionsplan",
      // Samme stabile id som weekFolder-flytningen (issue #96) sporer på — synligt her frem for
      // kun i chrome.storage.local, så identiteten overlever en nulstillet extension-storage og
      // kan slås op direkte i vaulten (fx grep efter planKey for at rekonstruere cachen manuelt).
      `plan_id: "${planKey}"`,
      ...(literature ? yamlBlockLines("litteratur", `▥ ${literature}`) : ["litteratur: false"]),
      // Kun titlerne, ikke indholdet: Properties-panelet og basens kolonne skal kunne læses på et
      // blik, og selve teksten står i AUTO-sektionen nedenfor. `false` frem for at udelade feltet,
      // så basens formel kan bruge et eksplicit `!= false` i stedet for antaget truthiness — samme
      // mønster som `litteratur` lige ovenfor.
      ...(forberedelse.length
        ? yamlBlockLines("forberedelse", forberedelse.map((el) => `⚒ ${el.titel}`).join("\n"))
        : ["forberedelse: false"]),
      "---",
      "",
    ].join("\n");

    const path = lektionsplanPath;
    try {
      const existingText = await readFromVault(path);
      const existingBody = existingText ? existingText.replace(/^---\n[\s\S]*?\n---\n\n?/, "") : null;
      // Kun et resumé når noten reelt fandtes FØR (prevRecord !== null) — ellers ville enhver
      // nyoprettet note (en plan der lige kom ind i tidsvinduet) fejlagtigt blive rapporteret som
      // "ændret", i stedet for at det bare er første gang den skrives.
      if (prevRecord != null) {
        const oldAutoMatch = existingBody?.match(AUTO_BLOCK_RE)?.[0];
        const oldAutoContent = oldAutoMatch ? oldAutoMatch.slice(AUTO_START.length, -AUTO_END.length).trim() : null;
        const changeSummary = summarizeAutoChange(oldAutoContent, autoContent);
        if (changeSummary) runChangedNotes.push(`${weekFolder} (${fagField}): ${changeSummary}`);
      }
      const note = frontmatter + spliceAutoSection(existingBody, autoContent) + "\n";
      await writeToVault(path, `data:text/markdown;charset=utf-8,${encodeURIComponent(note)}`);
      await savePlanNoteRecord(noteId, currentHash, weekFolder);
    } catch (err) {
      console.error(`VIAstudyWiz lektionsplan-fejl (${path}):`, err);
      if (err.code === "VAULT_PERMISSION") return false;
      recordError(`Lektionsplan (${weekFolder}): ${err.message}`);
    }
  }
  return true;
}

// Stabilt id pr. opgave: ElementID fra TaskUrl (fx main.aspx?CourseID=36016&ElementID=4831051&...).
// Falder tilbage til kursus+titel hvis URL'en mangler/ser anderledes ud, så dedup stadig virker.
function taskId(task) {
  const elementId = task.TaskUrl ? new URL(task.TaskUrl).searchParams.get("ElementID") : null;
  return elementId ? `opgave:${elementId}` : `opgave:${task.CourseId}:${task.TaskTitle}`;
}

// Afleveringsopgavers vedhæftede opgavebeskrivelse ligger i selve Afleveringsopgave-værktøjet
// (assignment.itslearning.com), ikke i plan.elements eller Ressourcer — nået via en cross-origin
// SSO-handshake (LoginSSO.aspx → assignment.itslearning.com/view.aspx) der sætter en session-cookie
// scopet til DET domæne. En direkte DownloadRedirect.ashx-URL uden den handshake giver 403 (afprøvet
// 2026-08-12). Løsningen: lad en rigtig fane gennemføre handshaket selv (samme teknik som
// resolveOfficeDownloadUrl), og læs filens rigtige download-URL ud af siden bagefter — den ligger som
// klartekst i sidens fileListControl.initialize([...])-konfiguration (Knockout, ikke server-rendret
// før JS kører, så det skal læses fra den FÆRDIGT indlæste side, ikke fra et rent HTML-fetch).
const ASSIGNMENT_TOOL_HOST = "assignment.itslearning.com";

// Hele SSO-kæden (LoginSSO.aspx -> ... -> assignment.itslearning.com) foregår inde i indlejrede
// iframes, aldrig i selve fanens topframe — bekræftet live 2026-08-12: en chrome.tabs.onUpdated-
// baseret ventefunktion (der kun ser tab.url, altså topframen) timede ud efter 20s, selvom
// kæde-hop-loggeren tidligere havde vist at kaldene rent faktisk skete. chrome.webRequest ser
// derimod alle frames uanset origin, som den eksisterende diagnostik allerede beviser. Bruger
// derfor webRequest igen, men venter på RO (ingen nyt kald i quietMs) i stedet for det første
// kald, så vi rammer den sidste interne navigation, ikke en signeret mellemside undervejs — og
// gemmer requestens frameId, så vi bagefter kan injicere scriptet i den RIGTIGE (indlejrede,
// cross-origin) iframe, ikke fanens topframe, hvor JSON'en aldrig ville findes.
function waitForFrameToSettle(tabId, urlPattern, timeoutMs, quietMs = 1500) {
  return new Promise((resolve, reject) => {
    let quietTimer = null;
    let lastFrameId = null;
    const overallTimeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout: intet kald matcher ${urlPattern} inden for ${timeoutMs}ms`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(overallTimeout);
      clearTimeout(quietTimer);
      chrome.webRequest.onBeforeRequest.removeListener(listener);
    }

    function listener(details) {
      if (details.tabId !== tabId) return;
      lastFrameId = details.frameId;
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => {
        cleanup();
        resolve(lastFrameId);
      }, quietMs);
    }

    chrome.webRequest.onBeforeRequest.addListener(listener, { urls: [urlPattern] });
  });
}

// Balanceret parentes-scan i stedet for en grådig regex — "DownloadEndpointUrl" og
// "signedFileRepoId" er flade strengfelter og trygge at matche direkte, men selve filens navn kan i
// princippet indeholde citationstegn, så vi henter det fra samme JSON i stedet for en løsrevet regex.
function extractAssignmentFile(html) {
  const downloadUrlMatch = html.match(/"DownloadEndpointUrl":"([^"]+)"/);
  const fileRepoIdMatch = html.match(/"signedFileRepoId":"([^"]+)"/);
  const nameMatch = html.match(/"Name":"((?:[^"\\]|\\.)*)"/);
  if (!downloadUrlMatch || !fileRepoIdMatch || !nameMatch) return null;
  const downloadUrl = downloadUrlMatch[1]
    .replace(/\\u0026/g, "&")
    .replace("{fileRepoId}", encodeURIComponent(fileRepoIdMatch[1]));
  return {
    name: JSON.parse(`"${nameMatch[1]}"`),
    url: new URL(downloadUrl, "https://assignment.itslearning.com").toString(),
  };
}

async function downloadTaskAttachment(task) {
  if (!task.TaskUrl) return null;

  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url: task.TaskUrl, active: false });
    tabId = tab.id;
    const frameId = await waitForFrameToSettle(tabId, `*://${ASSIGNMENT_TOOL_HOST}/*`, 20000);

    const [{ result: html }] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: () => document.documentElement.outerHTML,
    });
    const file = extractAssignmentFile(html);
    if (!file) {
      console.warn(
        `VIAstudyWiz: siden landede for opgaven "${task.TaskTitle}", men fileListControl-data blev ikke fundet i HTML'en`
      );
      return null;
    }

    const folder = sanitizeFilename(task.TaskTitle ?? "opgave");
    const rawName = sanitizeFilename(file.name);
    const stem = rawName.replace(/\.[^./]+$/, "");
    // Samme RAW/MD-gren som FAG/ (10-filsystem-design-raw-md.md) — watch_viastudywiz.py er ikke
    // bundet til FAG/, den konverterer enhver RAW/-gren i vaulten. Noten linker til MD (læselaget),
    // ikke RAW (bytes), samme regel som lektionsplan-noternes materialer-liste (issue #26).
    await writeToVault(`${NOTER_ROOT}/OPGAVER/${folder}/RAW/${rawName}`, file.url); // VAULT_PERMISSION propagerer til kalderen
    runFilesDownloaded++;
    return `${NOTER_ROOT}/OPGAVER/${folder}/MD/${stem}.md`;
  } catch (err) {
    if (err.code === "VAULT_PERMISSION") throw err; // propagerer til kalderen, samme regel som ellers
    console.warn(`VIAstudyWiz: ingen vedhæftning fundet for opgaven "${task.TaskTitle}":`, err);
    return null;
  } finally {
    if (tabId !== null) chrome.tabs.remove(tabId).catch(() => {});
  }
}

// NOTER/OPGAVER/<opgave>/ er opgavens egen mappe (kladde, uddrag, aflevering) — jf. ValdiVault
// 12-notestruktur-egne-noter.md §2. Noten her er kun indgangen: deadline + link til itslearning.
// Skrives én gang og aldrig igen, netop fordi mappen er Valdemars eget skriveområde — en
// gensynkronisering må ikke overskrive det han selv har skrevet i noten (samme regel som
// lektionsplan-noterne, af en stærkere grund).
async function writeTaskNotes(tasks) {
  const written = await getDownloadedIds();

  for (const task of tasks) {
    const noteId = `note:${taskId(task)}`;
    if (written.has(noteId)) continue;

    const folder = sanitizeFilename(task.TaskTitle ?? "opgave");
    // OPGAVER/<opgave>/ har ingen fag-undermappe (issue #37 §2) — fag bruges kun i frontmatter
    // her, så det rene navn (courseDisplayName), ikke symbol-varianten (courseFolderName).
    const fag = courseDisplayName(task.CourseTitle ?? "ukendt-fag");

    let attachmentPath = null;
    try {
      attachmentPath = await downloadTaskAttachment(task);
    } catch (err) {
      console.error(`VIAstudyWiz opgave-vedhæftning-fejl (${folder}):`, err);
      if (err.code === "VAULT_PERMISSION") return false;
      recordError(`Opgave-vedhæftning (${folder}): ${err.message}`);
    }

    const note = [
      "---",
      "type: opgave",
      `fag: ${fag}`,
      `deadline: "${toGoogleDateTime(task.Deadline).replace("T", " ")}"`,
      ...(task.TaskUrl ? [`kilde: "${task.TaskUrl}"`] : []),
      `hentet: "${formatNow()}"`,
      "---",
      "",
      `# ${task.TaskTitle ?? folder}`,
      "",
      `Deadline: ${task.DeadlineDisplayTime ?? task.Deadline}`,
      ...(task.TaskUrl ? ["", `[Åbn opgaven i itslearning](${task.TaskUrl})`] : []),
      // Link til MD-noten, ikke RAW-filen — samme regel som lektionsplan-noternes
      // materialer-liste (issue #26), af samme grund: MD er læselaget.
      ...(attachmentPath ? ["", "## Opgavebeskrivelse", `- [[${attachmentPath}]]`] : []),
      "",
    ].join("\n");

    const path = `${NOTER_ROOT}/OPGAVER/${folder}/${folder}.md`;
    try {
      await writeToVault(path, `data:text/markdown;charset=utf-8,${encodeURIComponent(note)}`);
      await markDownloaded(noteId);
    } catch (err) {
      console.error(`VIAstudyWiz opgave-note-fejl (${path}):`, err);
      if (err.code === "VAULT_PERMISSION") return false;
      recordError(`Opgave (${folder}): ${err.message}`);
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
          ? (await withRetry(() => resolvePdfDownloadUrl(element.url))).url
          : await withRetry(() => resolveOfficeDownloadUrl(element.url));
        filename = rawPath(courseName, weekFolder, element.title);
      } else {
        const resolved = await withRetry(() => resolveDownloadUrlUnknownType(element.url));
        downloadUrl = resolved.url;
        // Viewer.aspx's FileName-parameter (fanget i resolvePdfDownloadUrl) foretrækkes — den
        // bærer titlen elementet reelt blev uploadet med, inkl. endelse, uafhængigt af om selve
        // filerepository-URL'en har nogen endelse-info overhovedet (den har typisk ikke).
        const fromViewerFileName = resolved.fileName?.match(/\.[a-z0-9]{2,5}$/i)?.[0]?.toLowerCase() ?? "";
        const extension =
          fromViewerFileName ||
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
// markdownLinks bruges kun til Forberedelse-indhold (issue #59), hvor teksten er fuld af
// handlings-links (SharePoint-PPT'er man skal skrive i, emu.dk, indlejrede Google Docs) der skal
// kunne klikkes i Obsidian. Kalenderbeskrivelser og plan-tekst bliver ved "tekst (url)" — Google
// Calendar kan ikke markdown, og et [tekst](url) dér ville bare være støj.
function stripHtml(html, markdownLinks = false) {
  if (!html) return "";
  return html
    .replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, markdownLinks ? "[$2]($1)" : "$2 ($1)")
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
    lines.push("", "▥ Tilhørende litteratur:", literature);
  }
  // Ren tekst, ikke markdown — Google Calendar renderer ikke [tekst](url), men gør bare-URL'er
  // klikbare af sig selv, hvilket er præcis hvad stripHtml's "tekst (url)"-form giver.
  for (const el of forberedelseElements(plan)) {
    lines.push("", `⚒ Forberedelse — ${el.titel}:`, stripHtml(el.body));
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

// Afleveringsopgaver får deres eget event på selve deadline-tidspunktet, adskilt fra
// lektionsplan-events (issue #58). Deadline er et punkt, ikke et interval — Google kræver en
// slutning, så eventet lægges som den sidste halve time op til deadline. Til forskel fra
// opgave-noten opdateres eventet ved hver kørsel (upsert): flytter underviseren deadline, skal
// kalenderen følge med.
const TASK_EVENT_DURATION_MINUTES = 30;

async function syncTaskDeadlines(tasks, token, calendarIds, eventMap) {
  for (const task of tasks) {
    const calendarName = courseCalendarName(task.CourseTitle);
    if (!calendarName) continue; // ukendt/ikke-mappet fag, samme regel som lektions-events
    const calendarId = calendarIds[calendarName];
    if (!calendarId) {
      // Se samme fejlhåndtering i syncCalendar() nedenfor — faget er kendt/mappet, men selve
      // Google-kalenderen mangler. Ikke forventet, derfor recordError (ikke kun console.warn).
      const message = `Ingen Google-kalender fundet ved navn "${calendarName}"`;
      console.warn(`VIAstudyWiz: ${message}`);
      recordError(message);
      continue;
    }

    const deadline = toGoogleDateTime(task.Deadline);
    // Regnes som UTC begge veje ("...Z" ind, .toISOString() ud) så det er ren væg-tids-aritmetik:
    // maskinens egen tidszone må ikke forskyde tidspunktet, timeZone-feltet nedenfor bestemmer det.
    const start = new Date(new Date(`${deadline}Z`).getTime() - TASK_EVENT_DURATION_MINUTES * 60000)
      .toISOString()
      .slice(0, 19);
    const eventId = taskId(task);
    const wasNew = !eventMap[eventId];
    const body = {
      status: "confirmed",
      summary: `⚑ ${calendarName} — aflevering: ${task.TaskTitle ?? ""}`,
      description: [`Deadline: ${task.DeadlineDisplayTime ?? deadline}`, task.TaskUrl ?? ""].join("\n").trim(),
      start: { dateTime: start, timeZone: TIME_ZONE },
      end: { dateTime: deadline, timeZone: TIME_ZONE },
    };
    try {
      await upsertCalendarEvent(token, calendarId, eventId, body, eventMap);
      if (wasNew) runEventsSynced++;
    } catch (err) {
      console.error(`VIAstudyWiz opgave-kalender-fejl (${body.summary}):`, err);
      recordError(`${body.summary}: ${err.message}`);
    }
  }
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
    const calendarName = courseCalendarName(event.title);
    if (!calendarName) continue; // ukendt/afsluttet/ikke-mappet fag, spring over

    const calendarId = calendarIds[calendarName];
    if (!calendarId) {
      // I modsætning til !calendarName ovenfor er dette IKKE forventet — faget er kendt/mappet,
      // men selve Google-kalenderen mangler (omdøbt, slettet, OAuth-scope). Uden recordError her
      // forsvinder det i console.warn, og eventet forbliver stille tomt i Google Calendar uden
      // nogen advarsel til brugeren (fundet 2026-08-17: materialer downloadet korrekt, kalender-
      // event tomt, ingen notifikation).
      const message = `Ingen Google-kalender fundet ved navn "${calendarName}"`;
      console.warn(`VIAstudyWiz: ${message}`);
      recordError(message);
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
    // ▥ gør det synligt i kalenderoverblikket at der er noget at læse forud for lektionen, uden
    // at fylde hele teksten ind i titlen — den fulde tekst står i beskrivelsen (buildEventDescription).
    const literaturePrefix = plan && planLiteratureText(plan) ? "▥ " : "";
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

  // Forældreløse planer (issue #92): ingen kalender-event at læse tid/lokale fra, kun selve planen.
  // Egen nøgle-namespace ("plan:courseId:planId") så den aldrig kan kollidere med et event.id — hvis
  // itslearning senere alligevel linker planen til et rigtigt event, får den to kalender-indgange
  // indtil den ene ryddes op i hånden. Sjældent, selv-synligt (dublet, ikke tabt info), accepteret.
  for (const [planKey, plan] of Object.entries(result.orphanPlans ?? {})) {
    if (!plan) continue;

    const calendarName = courseCalendarName(plan.courseName);
    if (!calendarName) continue; // ukendt/ikke-mappet fag, samme regel som resten af filen

    const calendarId = calendarIds[calendarName];
    if (!calendarId) {
      const message = `Ingen Google-kalender fundet ved navn "${calendarName}" (forældreløs plan)`;
      console.warn(`VIAstudyWiz: ${message}`);
      recordError(message);
      continue;
    }

    // Ingen "ingen specifik tid angivet"-fallback her (til forskel fra hoved-loopet ovenfor) —
    // der er intet event.start/event.end at falde tilbage til, det er jo netop pointen med
    // forældreløse planer. En plan uden specifik tid ville give et misvisende heldags-event.
    if (!planHasSpecificTime(plan)) continue;

    const eventKey = `plan:${planKey}`;
    const wasNew = !eventMap[eventKey];

    const titlePart = stripWeekdayPrefix(plan.title) || plan.title;
    const topic = plan.topic?.name?.trim();
    const summaryTitle = topic ? `${topic} — ${titlePart}` : titlePart;
    const literaturePrefix = planLiteratureText(plan) ? "▥ " : "";
    const body = {
      status: "confirmed",
      summary: `${literaturePrefix}${calendarName} — ${summaryTitle}`,
      description: buildEventDescription(plan),
      start: { dateTime: toGoogleDateTime(plan.start), timeZone: TIME_ZONE },
      end: { dateTime: toGoogleDateTime(plan.stop), timeZone: TIME_ZONE },
    };

    try {
      const created = await upsertCalendarEvent(token, calendarId, eventKey, body, eventMap);
      console.log(
        `VIAstudyWiz: [forældreløs plan] "${body.summary}" -> kalender-id ${calendarId}, event-link ${created.htmlLink}`
      );
      if (wasNew) runEventsSynced++;
    } catch (err) {
      console.error(`VIAstudyWiz kalender-fejl (${body.summary}):`, err);
      recordError(`${body.summary}: ${err.message}`);
    }
  }

  await syncTaskDeadlines(result.tasks ?? [], token, calendarIds, eventMap);

  await saveEventMap(eventMap);
}

const SETTINGS_KEY = "viastudywizSettings";
const DEFAULT_SETTINGS = {
  daysBack: 1,
  daysForward: 30,
  enableFileDownloads: true,
  enableCalendarSync: true,
  enableMetadataExport: false,
  enableTaskCompletionSync: false,
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

// Fanger klik på OPEN_SETTINGS_BUTTON i fejl-notifikationen (issue #74) — buttonIndex 0, da
// notifikationen kun har den ene knap. chrome.runtime.openOptionsPage() er den rigtige API til at
// åbne options.html, i modsætning til macOS/Chromes eget tandhjul på notifikationen, som ikke er
// bundet til extensionen overhovedet.
chrome.notifications.onButtonClicked.addListener((_notificationId, buttonIndex) => {
  if (buttonIndex === 0) chrome.runtime.openOptionsPage();
});

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
