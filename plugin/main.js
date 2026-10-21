// ItsWiz: VIAstudyWiz' itslearning-høst som Obsidian-plugin (milestone "ItsWiz: fra Chrome til Obsidian").
// Kun desktop. Ingen build, ingen dependencies. Logikken nedenfor er kopieret fra Chrome-extensionens
// background.js (#239, plan i issue-kommentaren); extensionen er slettet i #244 og findes kun i git-historikken.

const { Plugin, ItemView, Modal, PluginSettingTab, Setting, Notice, TFile, TFolder, normalizePath, requestUrl } = require("obsidian");

// Vaultens to rodmapper er indstillinger (#269, plan i #266): fagmappen og den fulde sti til
// opgaverne. De er modulvariabler, sat af applyRoots() ved start og når indstillingen ændres, så
// alle sti-byggende funktioner bruger samme navn (issue #63: ellers opstår tomme dublet-mapper).
let FAG_ROOT = "Fag";
let OPGAVER_ROOT = "Noter/Opgaver";
// Extra folders outside Fag whose RAW/ branches are converted too; their notes get `folder:`, not `course:`.
let EXTRA_FOLDERS = [];
// Accepts what people paste: an absolute path inside the vault, and/or the RAW folder itself.
function extraFolderPath(value) {
  let v = String(value ?? "").trim();
  try {
    const base = plugin?.app?.vault?.adapter?.getBasePath?.();
    if (base && v.startsWith(base + "/")) v = v.slice(base.length + 1);
  } catch {}
  return normRoot(v.replace(/\/+$/, "").replace(/\/RAW$/, ""), "");
}
const normRoot = (v, fallback) => (String(v ?? "").trim().replace(/^\/+|\/+$/g, "") || fallback);
function applyRoots(settings) {
  EXTRA_FOLDERS = (settings?.extraFolders ?? []).map(extraFolderPath).filter(Boolean);
  FAG_ROOT = normRoot(settings?.fagRoot, "Fag");
  OPGAVER_ROOT = normRoot(settings?.opgaverRoot, "Noter/Opgaver");
}
const underRoot = (path, root) => path.startsWith(`${root}/`);

// Fagnavne er en indstilling (#270, plan i #266): kursuskode -> navn. Navnet bruges til mappen,
// `fag:`, kalendertitlen og Hold Course-klassen. Ukendt kode eller tomt navn = den rå kode.
// Samme modulvariabel-mønster som rødderne ovenfor, sat af applyCourseNames().
let COURSE_NAMES = {};
function applyCourseNames(settings) {
  COURSE_NAMES = { ...(settings?.courseNames ?? {}) };
}

// #202: Hold Course-pluginets egen data.json, ikke en vaultsti under FAG_ROOT/OPGAVER_ROOT — læst
// (aldrig skrevet) for at se om Valdemar har trykket Done DER, uden om et kryds i [NOTE]-stubben.
const HOLD_COURSE_DATA_PATH = ".obsidian/plugins/hold-course/data.json";

// Versionsmarkøren tvinger én genskrivning af alle lektionsplan-noter når frontmatter-skemaet
// ændrer sig (se brugen i writePlanNotes), og koster ingenting bagefter. Bump den når frontmatter
// får nye felter. (#73's itslearning-suffiks på materialer trænger ikke til et bump — det ÆNDRER
// selve autoContent-strengen, så hashet skifter af sig selv. Bump kun ved rene
// frontmatter-ændringer.)
//
// Modulniveau, ikke kun lokal i writePlanNotes: runCollectAndDownload skal kunne sammenligne den
// mod den senest GENNEMFØRTE version (issue #121) for at vide om en engangs-backfill er
// nødvendig — se FRONTMATTER_VERSION_KEY og runCollectAndDownload.
const FRONTMATTER_VERSION = 12; // 12 = engelske nøgler/overskrifter, uden uge/ugedag/dato, false-værdier og præfikser (#271), 2 = forberedelse-feltet (#59), 3 = fjernet dato:-felt, 4 = plan_id: (#96), 5 = litteratur-case-fix (#44), 6 = litteratur_filer (#44), 7 = materiale_filer (#113), 8 = beskrivelse (#113), 9 = kun linke downloadede elementer (#129), 10 = [PLAN]-note pr. lektion (#184), 11 = forberedelse_tekst (#205)

// Kører selve API-kaldene inde i en åben via.itslearning.com-fane (ikke fra service workeren),
// fordi myEvents-POST'et afvises med 403 når Origin er chrome-extension://... i stedet for
// den rigtige side-origin (CSRF/Origin-tjek server-side).
//
// #295: alle kursuskort (starred + unstarred; starred er ikke et signal). Selvstændig funktion, fordi
// den serialiseres ind i siden (se inPage).
async function fetchCourseCardsInPage() {
  const BASE = "https://via.itslearning.com";
  const get = async (url) => {
    const res = await fetch(url);
    if (!(res.headers.get("content-type") ?? "").includes("application/json")) {
      throw new Error(`Non-JSON response from ${url} (status ${res.status})`);
    }
    return res.json();
  };
  const [starred, unstarred] = await Promise.all([
    get(`${BASE}/restapi/personal/courses/cards/starred/v1`),
    get(`${BASE}/restapi/personal/courses/cards/unstarred/v1`),
  ]);
  return [...starred.EntityArray, ...unstarred.EntityArray];
}

// courses: de kort brugeren har valgt (filterCourses), ikke alle.
async function collectRangeInPage(startUnix, endUnix, courses) {
  const BASE = "https://via.itslearning.com";

  async function fetchJson(url, options) {
    const res = await fetch(url, options);
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      throw new Error(`Non-JSON response from ${url} (status ${res.status}, content-type "${contentType}")`);
    }
    return res.json();
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
    // ItsWiz: all/v1 frem for current/v1. current/v1 starter i dag, så planer i daysBack-delen af
    // vinduet manglede; all/v1 er hele kursets historik, ældste først (målt 2026-10-12: 103 planer
    // for Musik, 3 sider).
    const url = `${BASE}/restapi/personal/course/${courseId}/plans/all/v1?PageIndex=${pageIndex}&PageSize=${pageSize}&ChildId=0`;
    return fetchJson(url);
  }

  // Kappet til 5 sider (250 planer) som sikkerhed mod et kursus med usædvanligt mange planer —
  // ikke observeret i praksis (20 planer dækkede ~6 uger frem for Musik), men bedre en for lav grænse
  // for daysForward end en uendelig løkke. Stopper tidligere hvis en side kommer tilbage kortere end
  // pageSize (sidste side) eller tom.
  const ORPHAN_PLAN_PAGE_SIZE = 50;
  const MAX_ORPHAN_PLAN_PAGES = 20; // ItsWiz: all/v1 er ældste først, så 5 sider nåede ikke frem til i dag

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

  const courseIds = courses.map((c) => c.CourseId);
  const events = await fetchMyEvents(courseIds, startUnix, endUnix);
  const tasks = await fetchTasks(courses);

  // Lokale/underviser kommer kun fra kalenderevent'ets fritekstbeskrivelse (issue #118/#124),
  // ikke fra selve Planner-planen — samme parsedDescription som allerede bruges til Google
  // Calendar-eventets location. Ét event kan i teorien dække flere planId'er; det først sete
  // event med en udfyldt værdi vinder, resten overskriver ikke (planLocation[key] allerede sat).
  const planKeys = new Set();
  const planLocation = {};
  for (const event of events) {
    const parsed = parseDescription(event.apiDescriptionPlainText ?? "");
    for (const planId of event.PlanIds ?? []) {
      const key = `${event.courseId}:${planId}`;
      planKeys.add(key);
      if (!planLocation[key] && (parsed.room || parsed.teacher)) {
        planLocation[key] = { room: parsed.room ?? "", teacher: parsed.teacher ?? "" };
      }
    }
  }

  const plans = {};
  for (const key of planKeys) {
    const [courseId, planId] = key.split(":");
    const plan = await fetchPlan(courseId, planId);
    if (plan && planLocation[key]) Object.assign(plan, planLocation[key]);
    plans[key] = plan;
  }

  // Forældreløse planer (issue #92): findes i Planner, men uden noget linket kalender-event —
  // planKeys ovenfor ser dem derfor aldrig, uanset hvor mange gange kørslen gentages. Ét fags
  // fejl (kursus lukket, midlertidigt utilgængeligt) må ikke vælte resten af kørslen, samme
  // mønster som fetchTasks ovenfor.
  const orphanPlans = {};
  const okCourseIds = []; // fag hvis planliste blev hentet uden fejl: kun dér kan en manglende plan betyde "aflyst" (#243)
  for (const courseId of courseIds) {
    try {
      const candidateIds = await fetchOrphanPlanCandidateIds(courseId);
      for (const planId of candidateIds) {
        const key = `${courseId}:${planId}`;
        if (planKeys.has(key)) continue; // allerede dækket via et kalender-event
        orphanPlans[key] = await fetchPlan(courseId, planId);
      }
      okCourseIds.push(String(courseId));
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
    okCourseIds,
    tasks,
  };
}

// Fil-download: to kæder, begge fra 05-api-reference.md. Elementets side åbnes i en skjult fane;
// PDF'er lytter efter FileDownloadUrl i PdfViewer/Viewer.aspx (Kæde A, 7 hop), Office-filer
// lytter først efter LearningObjectId/LearningObjectInstanceId i File/View.aspx, navigerer så
// til DownloadRedirect.ashx og lytter efter den endelige filecache-URL (Kæde B, 3 hop efter det).
const OFFICE_EXTENSIONS = [".docx", ".pptx", ".xlsx", ".doc", ".ppt", ".xls"];

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
    // ItsWiz: requestUrl i stedet for fetch, fordi renderer-fetch mod WOPI-værten rammer CORS.
    const res = await requestUrl({ url: checkFileInfoUrl, throw: false });
    if (res.status >= 400) throw new Error(`CheckFileInfo responded ${res.status}`);
    const { BaseFileName } = res.json;
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

// Ren ISO-dato (YYYY-MM-DD) fra plan.start — samme streng-slice-mønster som toGoogleDateTime,
// da itslearning-tider ikke har noget tidszone-suffix (naiv lokal Europe/Copenhagen-væg-tid,
// fx "2026-04-29T12:30:00.0000000"). En slice er robust uanset hvilken tidszone selve
// browseren kører i, i modsætning til den tidligere `new Date(...)`-baserede
// ISO-ugenummer-beregning (issue #135), som manglede årstal helt: "W35fre" for to forskellige
// år regnede sig frem til NØJAGTIG samme vaultsti, så et gammelt semesters materiale kunne blive
// forvekslet med indeværende semesters. Dato er årstals-unik i sig selv uden ekstra logik.
// Bruges til NOTER-grenens "<dato> - <emne>".
function weekFolderBase(plan) {
  return plan.start.slice(0, 10);
}

// [NOTE]-stubbens FILNAVN: fortsat "<dato> - <emne>" pr. lektion (issue #209 grupperede kun selve
// MAPPEN efter enhed ligesom RAW/MD — filnavnet holder datoen, så stubbene sorterer kronologisk).
function weekFolderName(plan) {
  const base = weekFolderBase(plan);
  const topic = plan.topic?.name?.trim();
  return topic ? `${base} - ${sanitizeFilename(topic)}` : base;
}

// RAW/- og MD-grenen: files efter ENHED (itslearnings `topic`), ikke lektionsdato — flere
// lektioner i samme forløb deler mappe, så genbrugt materiale ligger ét sted og ikke som
// per-uge redirect-noter. Se ValdiVault 15-vault-fillayout-enhedsmapper.md + issue #148/#149/#150.
// Lektion uden brugbart emne falder tilbage til dato (samme fallback som før).
function enhedFolder(plan) {
  const topic = plan.topic?.name?.trim();
  if (!topic) return weekFolderBase(plan);
  return sanitizeFilename(topic);
}

// [PLAN]-notens FILNAVN (issue #184). Mappen deles fortsat af enhedens lektioner (enhedFolder
// ovenfor) — det er #183s ejerskabsmekanisme afhængig af — så filnavnet er det eneste sted der
// kan skille søskende ad. `[PLAN] <enhed>.md` var ens for dem alle, så N lektioner skrev til én
// fil hvor hver kørsel overskrev den forrige, og kun den sidst skrevne lektions plandata
// overlevede. Den daterede form er den vaulten allerede havde fra før enhed-migreringen; #150
// var regressionen, ikke navngivningen (ValdiVault 14-hold-course-synk.md, grundreglen om at
// stien er en etiket og `plan_id` er identiteten — en etiket skal stadig være unik i sin mappe).
// Lektion uden brugbart emne: mappen ER datoen, og "<dato> - <dato>" ville være ren støj — så
// dér er `[PLAN] <dato>.md` allerede unik, samme fallback som enhedFolder selv bruger.
function planNoteName(plan) {
  const base = weekFolderBase(plan);
  const enhed = enhedFolder(plan);
  return enhed === base ? `[PLAN] ${base}` : `[PLAN] ${base} - ${enhed}`;
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

// Separat fra downloadedElementIds: dén er en simpel tilstedeværelse-Set (fil/opgave enten
// hentet eller ej), men lektionsplan-noter skal opdages som "ændret" så underviserens rettelser
// til beskrivelsen ikke drifter væk fra noten (issue #61) — derfor gemmes et indholds-hash pr.
// plan i stedet for bare et boolean. Ikke-kryptografisk (planKollisions-risiko er irrelevant
// her, vi skal bare opdage "ændrede sig teksten") — undgår at skulle awaite Web Crypto for noget
// der kører synkront i en loop over alle ugens planer.
const PLAN_NOTE_HASHES_KEY = "planNoteContentHashes";

// Ældre lagrede værdier er rene hash-strenge (før issue #96 tilføjede ugemappe-sporing) —
// normaliseres her i stedet for at migrere storage, weekFolder: null betyder bare "ukendt gammel
// placering, spring flytte-detektion over denne ene gang" (opgraderes automatisk ved næste skrivning).
function planNoteRecord(records, noteId) {
  const value = records[noteId];
  if (value == null) return null;
  return typeof value === "string" ? { hash: value, weekFolder: null } : value;
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
// itslearnings API har et FriendlyName-felt på kurset, men det er altid null, og kortets Title er
// selve kursuskoden. Det pæne navn kommer derfor fra indstillingen `courseNames` (COURSE_NAMES).
// Ukendte kursuskoder (nye fag, "Hjælp", "VIAs onlinekurser") falder tilbage til den rå kode i
// stedet for at fejle.
function courseDisplayName(courseName) {
  return COURSE_NAMES[courseName] || courseName;
}

// Mappenavn = fagnavn, uden symbol (#270): ikoner og farver ejes af Hold Course. Navnet bruges
// også i `fag:`-frontmatter, som Seminarium.base filtrerer eksakt på (`fag == "Musik"`).
function courseFolderName(courseName) {
  return courseDisplayName(courseName);
}

// Fritekstfelt underviseren selv udfylder — henviser ofte til grundbogssider, ikke kun vedhæftede
// filer, så det kan ikke kobles til bestemte elementer. headingText varierer i store/små
// bogstaver på tværs af undervisere/kurser — bekræftet live 2026-08-27: feltet med det faktiske
// indhold (10 af 10 planer med udfyldt tekst) hedder "Tilhørende litteratur (læses forud for
// lektionen)" med lille l, mens et par planer har et separat TOMT felt "Litteratur" med stort L.
// Et case-sensitivt includes("Litteratur") ramte kun det tomme felt og misforstod dermed en
// UDFYLDT lektion for en tom (issue #44) — match derfor case-insensitivt.
// field.text er kun rent tekst når isPlainText er sat — nogle undervisere bruger rig tekst i
// feltet, hvor text i stedet indeholder rå HTML (bekræftet live, fx "<p><span
// style=...>...</span></p>" for et Musikforståelse-felt). stripHtml() bruges derfor altid, den
// er et no-op på allerede rent tekst.
function planLiteratureText(plan) {
  const text = plan.fields?.find((f) => f.headingText?.toLowerCase().includes("litteratur"))?.text;
  return text ? stripHtml(text) || null : null;
}

// Ord der er for almindelige til at bevise noget om et match — udelades fra begge sider, ellers
// ville fx "og"/"kap" alene kunne trække overlap-scoren op mellem to helt urelaterede titler.
const LITTERATUR_STOPORD = new Set([
  "og", "i", "af", "med", "til", "fra", "for", "den", "det", "en", "et", "s", "side", "siderne", "kap", "kapitel", "del",
]);

function significantTokens(text) {
  return (text.toLowerCase().match(/[a-zæøåé]+/g) ?? []).filter((t) => t.length >= 3 && !LITTERATUR_STOPORD.has(t));
}

// Litteratur-feltet er fri tekst der lige så tit henviser til en grundbogsside (uden vedhæftet
// fil) som til et konkret element (issue #44). Match derfor KONSERVATIVT — et forkert link er
// værre end intet, det giver falsk tryghed om at have læst det rigtige — frem for at forsøge at
// matche alting. Krav: mindst 2 betydende ord fra elementtitlen igen i litteraturteksten, og
// mindst 60% af elementtitlens ord dækket. Bekræftet mod alle 10 planer med reelt indhold
// 2026-08-27 (live-korpus): 0 falske positiver, korrekt ingen match ved rene grundbogshenvisninger
// (ingen elementer i planen overhovedet, eller ingen med nok ordoverlap).
// Elementer konkurrerer IKKE mod hinanden om "bedste match" — literaturteksten nævner ofte flere
// forskellige læsninger i træk, og hver skal kunne finde sin egen fil uafhængigt af de andre.
// Sideeffekt når to elementer reelt er samme tekst i to filformater (set live: en .pdf og en
// .pptx med næsten-identiske titler) — begge matcher uafhængigt af hinanden og linkes begge, i
// stedet for at gætte hvilken af dem der er "den rigtige".
function matchLiteratureElements(literatureText, elements) {
  if (!literatureText) return [];
  const litTokens = new Set(significantTokens(literatureText));
  return elements.filter((el) => {
    const stem = el.title.replace(/\.[^./]+$/, "");
    const elTokens = significantTokens(stem);
    if (elTokens.length < 2) return false;
    const matched = elTokens.filter((t) => litTokens.has(t));
    return matched.length / elTokens.length >= 0.6 && matched.length >= 2;
  });
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
// tilføjet oveni. Kun når titlen faktisk ender på en kendt endelse (samme liste som isPdf/isOffice
// ved download, se downloadNewFiles) — ellers strimler et almindeligt punktum i titlen selv (fx
// "... kap. 2") det forkert, fordi RAW-filen i det tilfælde får sin endelse tilføjet efter titlen,
// ikke fra titlen selv (issue #116).
function mdPath(courseName, weekFolder, title) {
  const sanitized = sanitizeFilename(title);
  const lower = sanitized.toLowerCase();
  const knownExtension = [".pdf", ...OFFICE_EXTENSIONS].find((ext) => lower.endsWith(ext));
  const stem = knownExtension ? sanitized.slice(0, -knownExtension.length) : sanitized;
  return `${FAG_ROOT}/${sanitizeFilename(courseFolderName(courseName))}/MD/${weekFolder}/${stem}.md`;
}

// § FAG/<fag>/NOTER/<enhed>/ — søskende til RAW/MD, ikke en separat NOTER-rod (issue #65 §11:
// Valdemar har ADHD og har brug for ét sted pr. fag at kigge, ikke tre rødder at huske).
// Mappen er enhed-grupperet ligesom RAW/MD (issue #209: 21 enkeltfil-mapper for 6 enheder i
// Religion, samme overhead #150/#155 allerede løste for MD/) — filnavnet bærer stadig dato+enhed
// (weekFolder), så stubbene sorterer kronologisk i Finder uden at behøve egen mappe hver.
function noteStubPath(courseName, enhedFolder, weekFolder) {
  return `${FAG_ROOT}/${sanitizeFilename(courseFolderName(courseName))}/NOTER/${enhedFolder}/[NOTE] ${weekFolder}.md`;
}

// Stubbens Forberedelse-sektion (issue #59): kun titlen som afkrydsningslinje, aldrig indholdet.
// Indholdet står i lektionsplan-notens AUTO-blok, som kilde: wikilinker til, og som genskrives når
// underviseren retter noget. Stod teksten også her, ville Valdemars egen fil — der per design
// aldrig overskrives — drifte væk fra itslearning uden at nogen kunne se det.
const FORB_HEADING = "## Preparation";

// Skriver kun hvis filen ikke findes i forvejen — modsat lektionsplan-noten (som genskrives når
// planen ændrer sig), er denne stub udelukkende til at give Valdemar et sted at skrive: findes
// den allerede, er den hans, og røres aldrig igen. Et rigtigt exists-tjek (readFromVault),
// ikke written.has(noteId) (muterbar download-log) — samme klasse beskyttelse som
// already_converted() i watch_viastudywiz.py, se 12-notestruktur-egne-noter.md §6.
// Eneste undtagelse er nye afkrydsningslinjer, som APPENDES (se nedenfor) — eksisterende linjer,
// og dermed hans afkrydsninger, røres aldrig.
// #202: Hold Course -> itslearning gik tidligere via [NOTE]-stubbens checkbox som mellemstation
// (sync_hold_course.py krydsede den af, denne fil scannede stubben ved næste kørsel). Nu Hold
// Course ER den primære indgang, læses `assignment.status` direkte i data.json i stedet — ingen
// grund til at vente på at et separat script først skriver et kryds ind i en fil. Læst én gang pr.
// writePlanNotes()-kørsel (kaldt fra loopet, ikke pr. lektion), ikke skrevet til her nogensinde.
// Returnerer null ved manglende fil/ugyldig JSON — kaldere falder da tilbage til kun at læse
// checkbox-state i noten, samme adfærd som før #202.
async function readHoldCourseData() {
  try {
    const text = await readFromVault(HOLD_COURSE_DATA_PATH);
    return text != null ? JSON.parse(text) : null;
  } catch (err) {
    console.warn("VIAstudyWiz: kunne ikke læse Hold Courses data.json (#202):", err);
    return null;
  }
}

// Forberedelse-TITLER markeret `done` i Hold Course for lektionen med dette plan_id, matchet på
// samme vswKey-form ("<lecture.id>|forb|<titel>") sync_hold_course.py selv bruger og selv skrev
// stemplet (`lec.vswPlanId`) ind fra. Tomt sæt hvis lektionen ikke findes endnu i data.json
// (synken har ikke kørt for den siden #202 landede) eller intet er markeret.
function holdCourseDoneForbTitles(holdCourseData, planKey) {
  const done = new Set();
  for (const sem of holdCourseData?.semesters ?? []) {
    for (const cls of sem.classes ?? []) {
      for (const lec of cls.lectures ?? []) {
        if (lec.vswPlanId !== planKey) continue;
        for (const a of lec.assignments ?? []) {
          const idx = (a.vswKey ?? "").indexOf("|forb|");
          if (idx !== -1 && a.status === "done") done.add(a.vswKey.slice(idx + "|forb|".length));
        }
        return done; // planKey er unik — ingen grund til at blive ved med at lede
      }
    }
  }
  return done;
}

// Tager hele plan'en frem for fag/uge/emne/start hver for sig: felterne udledes alligevel her, og
// signaturen var på vej mod syv parametre da Forberedelse kom til.
// Returnerer false hvis vault-tilladelsen mangler, ellers true (fejl på selve stubben er ikke
// kritiske nok til at stoppe resten af kørslen — kun logges via recordError).
async function writeLectureNoteStub(plan, weekFolder, lektionsplanPath, forberedelse, tabId, syncEnabled, holdCourseDone) {
  const courseName = plan.courseName ?? "ukendt-fag";
  const path = noteStubPath(courseName, enhedFolder(plan), weekFolder);
  const labels = forberedelse.map((el) => el.titel);
  try {
    const existing = await readFromVault(path);
    if (existing != null) {
      // issue #70: kun når afkrydsningen allerede er sat af Valdemar — nye stubbe kan ikke have
      // et flueben, så tjekket giver først mening her, ikke ved førstegangs-skrivning nedenfor.
      // #202: to UAFHÆNGIGE kilder til "allerede markeret Done", forenet — et kryds direkte i
      // noten (#70's oprindelige vej, uden om Hold Course) ELLER `assignment.status === 'done'`
      // i Hold Courses egen data.json (den primære vej i dag). !el.isCompleted (frisk fra
      // itslearning ved denne kørsel) gør unionen naturligt idempotent, samme som før: har
      // itslearning allerede registreret det, POSTes der ikke igen uanset hvilken kilde der sagde ja.
      if (syncEnabled) {
        const afkrydsede = new Set(
          existing.split("\n").filter((line) => /^- \[[xX]\]/.test(line.trim())).map((line) => line.replace(/^- \[[xX]\]\s*/, "").trim())
        );
        const skalMarkeres = forberedelse.filter((el) =>
          !el.isCompleted && (afkrydsede.has(el.titel) || holdCourseDone.has(el.titel))
        );
        if (skalMarkeres.length) await completeTasks(skalMarkeres, tabId);
      }
      // Underviseren kan tilføje en Forberedelse EFTER stubben blev skrevet — uden dette ville den
      // aldrig dukke op i noten, fordi stubben kun skrives én gang.
      // ponytail: matcher på titel, ikke element-id. To elementer med IDENTISK titel i samme
      // lektion giver kun én linje; et id i en HTML-kommentar er opgraderingen hvis det sker.
      // Whole checkbox lines, not substrings: without the old ⚒ marker a title like "Preparation"
      // would otherwise match the heading itself.
      const present = new Set(existing.split("\n").map((line) => /^- \[[ xX]\]\s*(.*)$/.exec(line.trim())?.[1]).filter(Boolean));
      const nye = labels.filter((label) => !present.has(label)).map((label) => `- [ ] ${label}`);
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
      `course: ${courseDisplayName(courseName)}`,
      ...(topic ? [`topic: "${topic}"`] : []),
      // start is the chronological key (the week/weekday/date fields are gone, #271).
      `start: "${toGoogleDateTime(plan.start ?? "").replace("T", " ")}"`,
      `source: "[[${kildeStem}]]"`,
      "tags: []",
      "---",
      "",
      `Source: [[${kildeStem}]]`,
      "",
      ...(labels.length ? [FORB_HEADING, ...labels.map((label) => `- [ ] ${label}`), ""] : []),
    ].join("\n");
    await writeToVault(path, `data:text/markdown;charset=utf-8,${encodeURIComponent(note)}`);
    return true;
  } catch (err) {
    console.error(`VIAstudyWiz forelæsningsnote-stub-fejl (${path}):`, err);
    if (err.code === "VAULT_PERMISSION") return false;
    recordError(`Lecture note (${weekFolder}): ${err.message}`);
    return true;
  }
}

// issue #70: CustomActivity-siden er en almindelig WebForms-postback uden UpdatePanel, så et rent
// form-POST med de skjulte felter er nok — samme GET som fetchActivityBody allerede laver.
// Selvstændig funktion (ingen closures over ydre scope) fordi den injiceres i itslearning-fanen
// via extensionens scripting.executeScript, samme grund som fetchActivityBody kun kan køre i selve
// fanen: session-cookien findes kun der.
// Toggleknappen er en rigtig checkbox (name="…$TaskCompletedToggle$input") med en onchange der
// kalder __doPostBack('…$TaskCompletedToggle', '') — issuets oprindelige live-måling (2026-08-12)
// fangede kun __EVENTTARGET-kaldet, ikke at checkboxens EGEN feltværdi også skal med i POST'en
// (en rigtig klik-handling sætter checked=true client-side FØR postbacken sendes, så den rider
// med i form-serialiseringen). Uden feltet ser serveren en umarkeret boks og gør intet — 200 OK,
// ingen fejl, ingen synlig ændring. Live-verificeret 2026-08-27 mod CustomActivityId 4732053.

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
    "ctl00$ContentPlaceHolder$TaskCompletedToggle$input": "on",
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


// "hentet:" i frontmatter — lokal væg-tid i samme tidszone som resten af extensionen (TIME_ZONE),
// ikke maskinens egen, og samme "yyyy-MM-dd HH:mm"-format som start/stop-felterne ovenfor, for
// konsistens (issue #34). Opdateres hver gang AUTO-sektionen i en lektionsplan-note regenereres
// (issue #61), ikke kun ved første hentning — fungerer derfor reelt som et "sidst opdateret".
// room/teacher only come from the calendar event's free text (#118/#124). A rewrite without that
// event (backfill of an old lesson) would erase them, so they are carried over from the old note.
// ponytail: a room that itslearning removes on purpose is never removed here; clear it by hand.
function keepLocation(frontmatter, existingText) {
  if (!existingText) return frontmatter;
  const old = parseFrontmatter(existingText);
  const add = ["room", "teacher"].filter((k) => old[k] && !new RegExp(`^${k}:`, "m").test(frontmatter)).map((k) => `${k}: "${old[k]}"`);
  return add.length ? frontmatter.replace(/^fetched: /m, (m) => `${add.join("\n")}\n${m}`) : frontmatter;
}

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

// Et wikilink til et materiale må kun skrives hvis MD-filen det peger på RENT FAKTISK findes i
// vaulten lige nu, MED indhold — downloadedElementIds (dedup-cachen i downloadFileElements) er
// ikke nok, den siger kun "vi har forsøgt at downloade dette element.id engang", ikke "filen
// findes stadig på den sti vi er ved at skrive". Cachen drifter væk fra virkeligheden når
// itslearning omdøber et element eller flytter dets lektion til en anden uge — mdPath() afhænger
// af titel+weekFolder, som begge kan ændre sig efter første download, mens element.id (det cachen
// er keyet på) består (issue #128/#129, live-bekræftet: to elementer stod som downloadet i
// cachen uden at deres fil nogensinde har eksisteret i vaulten).
// Tom streng tæller IKKE som fundet: readFromVault returnerer "" (ikke null) for en 0-byte fil,
// og en 0-byte .md er præcis Obsidians egen spøgelsesnote-signatur (oprettet ved klik på et dødt
// wikilink) — uden dette tjek ville selve symptomet på bugbasen bekræfte sig selv som "fundet" og
// linket blive stående for evigt.
async function existingMaterialeIds(plan, courseName, weekFolder) {
  const fileElements = (plan.elements ?? []).filter(
    (el) => el.typeName !== "Link" && !NON_FILE_TYPE_NAMES.has(el.typeName)
  );
  // existsInVault, ikke readFromVault: samme "Message exceeded maximum allowed size of 64MiB"-
  // risiko som eksistingRawIds havde (bce06b1) — en MinerU-konverteret MD-note er sjældent stor,
  // men ved en bred backfill (400 dage, FRONTMATTER_VERSION-bump) summer nok af dem sig op til at
  // ramme grænsen. Indholdet bruges alligevel ikke her, kun om noten findes.
  const checks = await Promise.all(
    fileElements.map(async (el) => [el.id, await existsInVault(mdPath(courseName, weekFolder, el.title))])
  );
  return new Set(checks.filter(([, exists]) => exists).map(([id]) => id));
}

// Samme mønster som existingMaterialeIds, men for RAW-originalen — bruges kun til at afgøre om et
// ekstra RAW-link er trygt at vise ved siden af MD-linket (Valdemars ønske: kunne åbne selve
// PDF'en/docx'en direkte, ikke kun MinerU-konverteringen). rawPath(title) er kun pålidelig når
// titlen selv bærer endelsen (isPdf/isOffice) — "unknown type"-elementer får deres endelse tilføjet
// FØRST ved selve downloadet (se downloadFileElements), så et gæt her ville nogle gange pege på en
// fil der aldrig eksisterer under det navn. At udelade linket for de elementer er derfor korrekt,
// ikke en fejl.
async function existingRawIds(plan, courseName, weekFolder) {
  const fileElements = (plan.elements ?? []).filter(
    (el) => el.typeName !== "Link" && !NON_FILE_TYPE_NAMES.has(el.typeName)
  );
  const checks = await Promise.all(
    fileElements.map(async (el) => [el.id, await existsInVault(rawPath(courseName, weekFolder, el.title))])
  );
  return new Set(checks.filter(([, exists]) => exists).map(([id]) => id));
}

// [[fuld/sti/Titel.md]] viser hele stien som synlig linktekst i Obsidian — ulæseligt i en liste med
// flere materialer. |alias giver kort, læsbar tekst uden at give slip på det fulde, entydige mål.
// Aliasset er selve FILNAVNET inkl. ægte endelse (Valdemars ønske, 2026-08-30) — .md/.pdf/.pptx
// osv. fortæller i sig selv om det er MinerU-noten eller originalfilen, uden at opdigte en
// markør. rawLink() bruger samme princip; kun itslearning-linket (writePlanNotes) får en "(web)"-
// markør i stedet, fordi det IKKE er en fil med en ægte endelse — at kalde den ".html" ville være
// løgn om hvad linket rent faktisk peger på.
function mdLink(courseName, weekFolder, title) {
  const full = mdPath(courseName, weekFolder, title);
  const alias = full.slice(full.lastIndexOf("/") + 1);
  return `[[${full}|${alias}]]`;
}

function rawLink(courseName, weekFolder, title) {
  const full = rawPath(courseName, weekFolder, title);
  const alias = full.slice(full.lastIndexOf("/") + 1);
  return `[[${full}|${alias}]]`;
}

// #241: MinerU er et tilvalg. Uden MD-note peger linket på RAW-originalen; når MD dukker op, ændrer
// AUTO-hashet sig og linket skifter til MD ved næste høst.
function fileLink(courseName, weekFolder, title, hasMd) {
  return hasMd ? mdLink(courseName, weekFolder, title) : rawLink(courseName, weekFolder, title);
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
  // Én læsning for hele kørslen (dusinvis af planer i loopet nedenfor), ikke én pr. lektion —
  // og kun når indstillingen overhovedet er slået til, ellers er filen ligegyldig for denne kørsel.
  const holdCourseData = syncTaskCompletion ? await readHoldCourseData() : null;

  for (const [planKey, plan] of Object.entries(plans)) {
    const noteId = `plan:${planKey}`;
    if (!plan) continue;

    // RAW/MD/NOTER files alle efter enhed (issue #209) — kun selve stub-FILNAVNET bærer "<dato> - <emne>".
    const weekFolder = enhedFolder(plan);
    const courseName = plan.courseName ?? "ukendt-fag";
    // Mappenavn og fag:-felt er samme fagnavn (#270), så Seminarium.base kan filtrere eksakt på det (issue #63).
    const fag = sanitizeFilename(courseFolderName(courseName));
    const fagField = courseDisplayName(courseName);
    const existingIds = await existingMaterialeIds(plan, courseName, weekFolder);
    const rawIds = await existingRawIds(plan, courseName, weekFolder);
    const hasFile = (el) => existingIds.has(el.id) || rawIds.has(el.id);

    // planId'et er stabilt selv når itslearning redigerer start/stop-felterne på en eksisterende
    // plan i stedet for at oprette en ny (fx en reel udskydelse, live-bekræftet 2026-08-27 på
    // Religion: den fortrængte lektions plan beholdt sit id, kun datoen ændrede sig — mens selve
    // tidsspunktet fik en NY placeholder-plan). enhedFolder() er emne-afledt, så en udskudt
    // lektion der bliver i samme enhed rammer samme mappe (ingen flytning nødvendig); skifter
    // den emne, flyttes de allerede hentede filer med her, ellers bliver de stående (issue #96).
    let prevRecord = planNoteRecord(records, noteId);
    if (prevRecord?.weekFolder && prevRecord.weekFolder !== weekFolder) {
      try {
        // MD afgør: RAW-mappen har ingen [PLAN]-noter og kan derfor ikke selv se om enheden er
        // delt. Flyttes kun når MD faktisk blev flyttet, ellers ville de to grene drifte fra
        // hinanden (issue #181).
        const md = await moveDirInVault(`${FAG_ROOT}/${fag}/MD/${prevRecord.weekFolder}`, `${FAG_ROOT}/${fag}/MD/${weekFolder}`);
        if (md.reason === "shared") {
          // Materialet bliver liggende under det gamle emne, hvor søskende-lektionerne stadig
          // bruger det. Ikke en fejl der kan rettes automatisk: en delt fil har ingen enkelt
          // ejer at flytte med (samme grundproblem som #183), så det er Valdemars beslutning.
          recordError(`Lesson moved (${fagField}, ${prevRecord.weekFolder} → ${weekFolder}): `
            + `materials were NOT moved: the folder is shared with other lessons in the same unit. Move it manually in Obsidian if it should follow.`);
        } else {
          await moveDirInVault(`${FAG_ROOT}/${fag}/RAW/${prevRecord.weekFolder}`, `${FAG_ROOT}/${fag}/RAW/${weekFolder}`);
          runChangedNotes.push(`${prevRecord.weekFolder} → ${weekFolder} (${fagField}): lektion flyttet, vault-materialer fulgte med`);
        }
        await savePlanNoteRecord(noteId, prevRecord.hash, weekFolder);
        prevRecord = { hash: prevRecord.hash, weekFolder };
      } catch (err) {
        console.error(`VIAstudyWiz vault-flytning fejlede (${prevRecord.weekFolder} → ${weekFolder}):`, err);
        recordError(`Lesson moved (${fagField}, ${prevRecord.weekFolder} → ${weekFolder}): vault materials could not be moved automatically: ${err.message}`);
      }
    }
    // Links til MD-noten (navigations-graf) er hovedlinket, men et ekstra RAW-link er tilføjet ved
    // siden af (issue #135-opfølgning, Valdemars ønske) — MinerU-renderingen er ikke altid trofast
    // mod originalens layout/billeder, og indtil nu var originalen kun tilgængelig via et ekstra
    // klik ind i MD-notens eget kilde:-felt. Kun vist når RAW-filen rent faktisk findes under det
    // gættede navn (existingRawIds, se dens kommentar for hvorfor "unknown type"-elementer udelades).
    // Mappe/opgave-typer får aldrig en MD-modpart, så de udelades. Link-elementer nævnes som ren
    // tekst (titlen er allerede synlig her) i stedet for en note — automatisk indholds-udtræk blev
    // forsøgt og droppet igen, se #20. Suffikset til itslearning (issue #73) er en nødvendig vej
    // tilbage til ORIGINALEN, ikke bare en genvej: viser et fil-element sig at være en skabelon man
    // selv skal skrive i og aflevere (samme klasse som Forberedelse-elementernes SharePoint-links,
    // issue #59), er MinerU-renderingen ubrugelig til det.
    const materials = (plan.elements ?? [])
      .filter((el) => el.typeName === "Link" || (!NON_FILE_TYPE_NAMES.has(el.typeName) && hasFile(el)))
      .map((el) => {
        if (el.typeName === "Link") return `- ${el.title} (link — open the lesson plan in itslearning to follow it)`;
        if (!existingIds.has(el.id)) return `- ${rawLink(courseName, weekFolder, el.title)} · [${el.title} (web)](https://via.itslearning.com${el.url})`;
        const raw = rawIds.has(el.id) ? ` · ${rawLink(courseName, weekFolder, el.title)}` : "";
        return `- ${mdLink(courseName, weekFolder, el.title)}${raw} · [${el.title} (web)](https://via.itslearning.com${el.url})`;
      });
    const topic = plan.topic?.name?.trim();
    const literature = planLiteratureText(plan);
    const literatureFiles = literature
      ? matchLiteratureElements(literature, plan.elements ?? []).filter(hasFile)
      : [];
    const forberedelse = forberedelseElements(plan);
    // Samme tekst som AUTO-sektionens brødtekst nedenfor, men som eget felt: Hold Course-synken
    // (issue #113) læser kun frontmatter, ikke AUTO-blokken. "Lesson Description" på lektionen i
    // Hold Course (main.js, hold-course#172) er netop den read-only boks planens beskrivelse hører
    // hjemme i — IKKE "Key Concepts & Lesson Goal", som er en anden, Valdemar-ejet fritekstboks
    // (rettet her, 2026-09-09 — den gamle kommentar navngav den forkerte).
    const beskrivelse = stripHtml(plan.description).trim();
    // #205: samme Forberedelse-instruktion som AUTO-blokkens "## ⚒ Forberedelse" nedenfor
    // (el.body), men som EGET felt af samme grund som beskrivelse ovenfor — Hold Course-synken
    // læser kun frontmatter. Uden dette felt kunne Valdemar se AT der var en Forberedelse, men
    // ikke HVAD den bad om, uden at åbne [PLAN]-noten. Underoverskrift kun ved flere elementer,
    // samme regel som forberedelseLines nedenfor bruger til AUTO-blokken.
    const forberedelseTekst = forberedelse
      .map((el) => (forberedelse.length > 1 ? `**${el.titel}**\n\n${stripHtml(el.body, true)}` : stripHtml(el.body, true)))
      .join("\n\n").trim();
    // Ikke alle undervisere udfylder "Tilhørende litteratur"-feltet — LivsOplysning vedhæfter i
    // stedet læsestoffet som almindelige fil-elementer og skriver selve læse-instruktionen
    // ("Forberedelse: Læs indledningen af...") ind i planens frie beskrivelsestekst i stedet for i
    // et separat felt (bekræftet live 2026-08-27: 0 af 6 LivsOplysning-planer har et udfyldt
    // litteratur- eller Arbejdsopgave-felt, men alle har vedhæftede fil-elementer). Uden dette felt
    // var LivsOplysnings læsestof usynligt for alt der læser frontmatter (Hold Course-synken,
    // issue #113) — det stod kun i AUTO-sektionens "## Materialer", som er fritekst.
    // Samme fil-elementer som "## Materialer" ovenfor, minus dem litteratur_filer allerede har
    // fanget (samme fil skal ikke stå i begge felter) — NON_FILE_TYPE_NAMES udelukker i forvejen
    // Link/Mappe/Arbejdsopgave/Afleveringsopgave, samme filter som materials-listen bruger.
    const literatureFileTitles = new Set(literatureFiles.map((el) => el.title));
    const materialeFiler = (plan.elements ?? [])
      .filter((el) => !NON_FILE_TYPE_NAMES.has(el.typeName) && !literatureFileTitles.has(el.title) && hasFile(el));

    // Skrives hver kørsel, uafhængigt af lektionsplan-hashet nedenfor — stubben skal findes før
    // timen selv når planens indhold ikke har ændret sig siden sidste kørsel.
    const lektionsplanPath = `${FAG_ROOT}/${fag}/MD/${weekFolder}/${planNoteName(plan)}.md`;
    const holdCourseDone = holdCourseData ? holdCourseDoneForbTitles(holdCourseData, planKey) : new Set();
    const stubOk = await writeLectureNoteStub(plan, weekFolderName(plan), lektionsplanPath, forberedelse, tabId, syncTaskCompletion, holdCourseDone);
    if (!stubOk) return false;

    // Ligger i AUTO-blokken, så underviserens rettelser følger med (issue #61) — i modsætning til
    // afkrydsningerne i stubben, som er Valdemars og aldrig overskrives. Underoverskrift kun ved
    // flere elementer: 13 af 16 hedder bare "Forberedelse", og "## ⚒ Forberedelse / ### Forberedelse"
    // er ren støj. Link tilbage til itslearning, fordi billeder i beskrivelsen ikke overlever
    // stripHtml (deres URL'er er kortlivede tokens fra filerepository).
    const forberedelseLines = forberedelse.flatMap((el) => [
      "",
      ...(forberedelse.length > 1 ? [`### ${el.titel}`, ""] : []),
      stripHtml(el.body, true) || "_(no content fetched — open in itslearning)_",
      "",
      `[Open "${el.titel}" in itslearning](https://via.itslearning.com${el.url})`,
    ]);

    const autoContent = [
      `# ${plan.title ?? weekFolder}`,
      "",
      stripHtml(plan.description),
      ...(materials.length ? ["", "## Materials", ...materials] : []),
      ...(forberedelse.length ? ["", FORB_HEADING, ...forberedelseLines] : []),
    ].join("\n");

    // Hashet dækker kun det maskin-genererede indhold (autoContent), ikke frontmatter — ellers
    // ville "hentet:"-tidsstemplet i frontmatter gøre hashet forskelligt ved hver kørsel uanset
    // om planen reelt ændrede sig, og hele pointen med at undgå unødvendige genskrivninger ville
    // forsvinde.
    // Bagsiden af det: et NYT frontmatter-felt når aldrig ud til noter hvis AUTO-indholdet er
    // uændret — en lektion uden Forberedelse ville aldrig få `forberedelse: false`, og basens
    // `!= false`-filter ville så se et felt der slet ikke findes. Det er derfor FRONTMATTER_VERSION
    // (modulniveau, se toppen af filen) tvinger én genskrivning ved et bump. (Valdemars eget
    // indhold uden for AUTO-markørerne bevares af spliceAutoSection, så genskrivningen er ufarlig.)
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

    const newFrontmatter = [
      "---",
      `course: ${fagField}`,
      ...(topic ? [`topic: "${topic}"`] : []),
      // Lektionens rigtige tidspunkt (ikke lokale-bookingens) — se toGoogleDateTime/syncCalendar
      // for hvorfor plan.start/stop er den pålidelige kilde.
      `start: "${toGoogleDateTime(plan.start ?? "").replace("T", " ")}"`,
      `stop: "${toGoogleDateTime(plan.stop ?? "").replace("T", " ")}"`,
      // Kun til stede når kalenderevent'ets beskrivelse rent faktisk havde feltet (issue #118/
      // #124) — sync_hold_course.py skriver dem videre til Hold Course KUN når de afviger fra
      // klassens standard, så en manglende linje her er ikke tabt information, bare "ingen
      // afvigelse at rapportere".
      ...(plan.room ? [`room: "${plan.room}"`] : []),
      ...(plan.teacher ? [`teacher: "${plan.teacher}"`] : []),
      `fetched: "${formatNow()}"`,
      "type: lesson-plan",
      // Samme stabile id som weekFolder-flytningen (issue #96) sporer på — synligt her frem for
      // kun i extensionens storage.local, så identiteten overlever en nulstillet extension-storage og
      // kan slås op direkte i vaulten (fx grep efter planKey for at rekonstruere cachen manuelt).
      `plan_id: "${planKey}"`,
      // A field is only written when it has content (no `false` placeholders, #271).
      ...(literature ? yamlBlockLines("literature", literature) : []),
      // Separat felt fra litteratur selv (issue #44, spørgsmål 1+3): litteratur-teksten er ofte en
      // ren grundbogshenvisning uden fil, så et match mod plan.elements er ikke garanteret — basen
      // skal kunne skelne "har litteratur OG en fundet fil" fra "har kun litteratur-tekst" uden at
      // parse brødteksten. `false` når matchLiteratureElements ikke fandt noget, samme mønster som
      // litteratur/forberedelse ovenfor.
      ...(literatureFiles.length
        ? yamlBlockLines("literature_files", literatureFiles.map((el) => fileLink(courseName, weekFolder, el.title, existingIds.has(el.id))).join("\n"))
        : []),
      // Kun titlerne, ikke indholdet: Properties-panelet og basens kolonne skal kunne læses på et
      // blik, og selve teksten står i AUTO-sektionen nedenfor. `false` frem for at udelade feltet,
      // så basens formel kan bruge et eksplicit `!= false` i stedet for antaget truthiness — samme
      // mønster som `litteratur` lige ovenfor.
      ...(forberedelse.length
        ? yamlBlockLines("preparation", forberedelse.map((el) => el.titel).join("\n"))
        : []),
      // #205: selve instruktionsteksten til feltet ovenfor — se kommentaren ved forberedelseTekst
      // for hvorfor den har sit eget felt. Samme `false`-mønster.
      ...(forberedelseTekst ? yamlBlockLines("preparation_text", forberedelseTekst) : []),
      // Alt vedhæftet fil-materiale der IKKE allerede står i litteratur_filer — dækker fag hvor
      // underviseren aldrig udfylder litteratur-feltet (se kommentaren ved materialeFiler ovenfor).
      // Samme false-mønster som de øvrige felter.
      ...(materialeFiler.length
        ? yamlBlockLines("material_files", materialeFiler.map((el) => fileLink(courseName, weekFolder, el.title, existingIds.has(el.id))).join("\n"))
        : []),
      ...(beskrivelse ? yamlBlockLines("description", beskrivelse) : []),
      "---",
      "",
    ].join("\n");

    const path = lektionsplanPath;
    try {
      const existingText = await readFromVault(path);
      const frontmatter = keepLocation(newFrontmatter, existingText);
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
      recordError(`Lesson plan (${weekFolder}): ${err.message}`);
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
    // OPGAVER/<opgave>/ har ingen fag-undermappe (issue #37 §2) — fag bruges kun i frontmatter her.
    const fag = courseDisplayName(task.CourseTitle ?? "ukendt-fag");

    let attachmentPath = null;
    try {
      attachmentPath = await downloadTaskAttachment(task);
    } catch (err) {
      console.error(`VIAstudyWiz opgave-vedhæftning-fejl (${folder}):`, err);
      if (err.code === "VAULT_PERMISSION") return false;
      recordError(`Assignment attachment (${folder}): ${err.message}`);
    }

    const note = [
      "---",
      "type: assignment",
      `course: ${fag}`,
      `deadline: "${toGoogleDateTime(task.Deadline).replace("T", " ")}"`,
      ...(task.TaskUrl ? [`source: "${task.TaskUrl}"`] : []),
      `fetched: "${formatNow()}"`,
      "---",
      "",
      `# ${task.TaskTitle ?? folder}`,
      "",
      `Deadline: ${task.DeadlineDisplayTime ?? task.Deadline}`,
      ...(task.TaskUrl ? ["", `[Open the assignment in itslearning](${task.TaskUrl})`] : []),
      // Link til MD-noten, ikke RAW-filen — samme regel som lektionsplan-noternes
      // materialer-liste (issue #26), af samme grund: MD er læselaget.
      ...(attachmentPath ? ["", "## Assignment description", `- [[${attachmentPath}]]`] : []),
      "",
    ].join("\n");

    const path = `${OPGAVER_ROOT}/${folder}/${folder}.md`;
    try {
      await writeToVault(path, `data:text/markdown;charset=utf-8,${encodeURIComponent(note)}`);
      await markDownloaded(noteId);
    } catch (err) {
      console.error(`VIAstudyWiz opgave-note-fejl (${path}):`, err);
      if (err.code === "VAULT_PERMISSION") return false;
      recordError(`Assignment (${folder}): ${err.message}`);
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

// Returnerer false hvis vault-tilladelsen manglede (se writePlanNotes ovenfor).
async function downloadFileElements(plans, tabId) {
  const downloadedIds = await getDownloadedIds();

  const baseElements = Object.values(plans)
    .filter(Boolean)
    .flatMap((plan) =>
      (plan.elements ?? []).map((el) => ({
        courseName: plan.courseName ?? "ukendt-fag",
        weekFolder: enhedFolder(plan),
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
  // downloadedElementIds i extensionens storage.local for at se hvad der matcher.
  console.table(
    matchingElements.map(({ element }) => ({
      titel: element.title,
      typeName: element.typeName,
      id: element.id,
      allerede_downloadet: downloadedIds.has(element.id),
    }))
  );

  // downloadedIds er en engangs-log ("blev hentet mindst én gang"), ikke en garanti for at
  // filen stadig ligger i vaulten — en ugemappe-flytning (moveDirInVault), en manuel oprydning
  // eller en Syncthing-konflikt kan have fjernet den siden. Uden dette tjek forbliver læsningen
  // tabt for evigt: flaget forhindrer for altid et nyt downloadforsøg, uanset at filen er væk
  // (live-eksempel 2026-08-29: "A Dahlbæk kap 10 Dans og bevægelse..." forsvandt fra disken,
  // men blev aldrig hentet igen, fordi id'et allerede stod i downloadedIds). Kun elementer hvis
  // titel selv bærer en kendt endelse (isPdf/isOffice) kan tjekkes her — rawPath() kræver
  // endelsen, og "unknown type"-elementers endelse kendes først efter selve download-URL'en er
  // resolvet nedenfor, så de stoler stadig kun på flaget.
  const fileElements = [];
  for (const item of matchingElements) {
    const { courseName, weekFolder, element } = item;
    if (!downloadedIds.has(element.id)) {
      fileElements.push(item);
      continue;
    }
    const titleLower = element.title.toLowerCase();
    const hasKnownExtension = titleLower.endsWith(".pdf") || OFFICE_EXTENSIONS.some((ext) => titleLower.endsWith(ext));
    if (!hasKnownExtension) continue;
    const stillOnDisk = await existsInVault(rawPath(courseName, weekFolder, element.title));
    if (!stillOnDisk) fileElements.push(item);
  }

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
          recordError(`${element.title}: could not determine file extension`);
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

const TIME_ZONE = "Europe/Copenhagen";

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


// Lås mod samtidige kørsler: skjulte vinduer og Net-lytterne er ikke skoped til én kørsel.
let isRunning = false;

// Issue #121: en kørsel dækker kun daysBack/daysForward omkring i dag (default 1/30), så et
// FRONTMATTER_VERSION-bump genskriver aldrig noter fra før i går, uanset hvor mange gange
// extensionen kører — versionsmarkøren i hashet lover en genskrivning den ikke kan holde for
// noter uden for vinduet. Fandt live 2026-08-28: beskrivelse: (version 8) stod i 0 af 36
// lektionsplan-noter, selvom koden var korrekt og havde kørt adskillige gange siden.
//
// Løsning: husk hvilken FRONTMATTER_VERSION der sidst blev gennemført. Er den forældet (eller
// aldrig sat, fx første kørsel efter en frisk installation), udvider netop DÉN ene kørsel
// tilbageblikket til BACKFILL_DAYS_BACK i stedet for settings' daysBack — bredt nok til at nå en
// hel studieuddannelse tilbage, ikke kun indeværende semester. Bagefter falder kørslerne tilbage
// til det normale, korte vindue. Ingen ekstra manuel indstilling at huske at ændre og ændre
// tilbage, og ingen risiko for det (#113s driftsfælde) hvis Valdemar glemmer det.
const FRONTMATTER_VERSION_KEY = "syncedFrontmatterVersion";
const BACKFILL_DAYS_BACK = 400;

// ─── ItsWiz: erstatninger for Chrome-API'erne ──────────────────────────────────────────────
// Alt over denne linje er kopieret fra background.js (slettet i #244), kun med de rettelser
// der er markeret "ItsWiz:". Alt herunder erstatter det Chrome gav: faner, webRequest, downloads,
// File System Access og extensionens storage.local.

// ponytail: modul-globalt plugin-objekt, samme form som background.js' globale tilstand. Én
// plugin-instans pr. Obsidian-vindue, så det holder.
let plugin = null;
let harvestWin = null; // skjult itslearning-vindue, kun under en kørsel
let net = null; // netværksopsnapning, kun under en kørsel

const VIEW_TYPE = "itswiz-browser";
// Egen partition: Electron tillader kun én webRequest-lytter pr. event pr. session, og Obsidians
// Web viewer holder allerede onBeforeRequest på sin egen partition (adblock).
const PARTITION = "persist:itswiz";
const BASE = "https://via.itslearning.com";
// Forsiden (BASE selv) er login-siden, og at indlæse den logger en aktiv session ud: REST-API'et
// svarer 401 bagefter i alle vinduer på partitionen (målt trin for trin 2026-10-12). Start derfor
// altid på en side der kræver login; er man logget ud, sender itslearning selv videre til login.
const START_URL = `${BASE}/CourseCards`;
const TEST_ROOT = "ItsWiz-test";
const WATCH_URLS = ["*://*.itslearning.com/*", "*://*.officeapps.live.com/*"];

function remote() {
  const electron = require("electron");
  return electron.remote || window.electron?.remote;
}

// itslearning/Microsoft-login kan afvise en "Electron/…"-user agent; samme strip som Obsidians Web viewer.
const UA = navigator.userAgent.split(" ").filter((t) => !/^(obsidian|electron)/i.test(t)).join(" ");

// ── Vault-I/O (afløser offscreen.js) ──
// Læsning og eksistens går gennem adapteren (filsystemet), ikke vaultens indeks: indekset kender
// ikke .obsidian/ (Hold Course' data.json), og APFS slår NFC/NFD-stier op som samme fil (#131).
// Skrivning går gennem vault-API'et, så Obsidian og andre plugins ser ændringen som modify/create.

async function ensureFolder(path) {
  const parts = path.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const sub = parts.slice(0, i).join("/");
    if (!(await plugin.app.vault.adapter.exists(sub))) await plugin.app.vault.createFolder(sub);
  }
}

async function writeVaultFile(path, data) {
  path = normalizePath(path);
  const { vault } = plugin.app;
  const binary = typeof data !== "string";
  const file = vault.getAbstractFileByPath(path);
  if (file instanceof TFile) return binary ? vault.modifyBinary(file, data) : vault.modify(file, data);
  if (await vault.adapter.exists(path)) return binary ? vault.adapter.writeBinary(path, data) : vault.adapter.write(path, data);
  const dir = path.slice(0, path.lastIndexOf("/"));
  if (dir) await ensureFolder(dir);
  return binary ? vault.createBinary(path, data) : vault.create(path, data);
}

// Samme signatur som background.js: url er enten en data:-URL (noter) eller en download-URL.
async function writeToVault(path, url) {
  if (url.startsWith("data:")) {
    const comma = url.indexOf(",");
    const meta = url.slice(5, comma);
    const payload = url.slice(comma + 1);
    if (meta.endsWith(";base64")) {
      const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
      return writeVaultFile(path, bytes.buffer);
    }
    return writeVaultFile(path, decodeURIComponent(payload));
  }
  const res = await requestUrl({ url, throw: false });
  if (res.status >= 400) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return writeVaultFile(path, res.arrayBuffer);
}

async function readFromVault(path) {
  path = normalizePath(path);
  const { adapter } = plugin.app.vault;
  return (await adapter.exists(path)) ? adapter.read(path) : null;
}

async function existsInVault(path) {
  return plugin.app.vault.adapter.exists(normalizePath(path));
}

// Afløser offscreen.js' moveDir: renameFile, så wikilinks følger med (vault-reglen i CLAUDE.md).
// Samme regel som før (#181): en mappe med flere [PLAN]-noter er delt og flyttes aldrig.
async function moveDirInVault(oldPath, newPath) {
  const { vault, fileManager } = plugin.app;
  const oldDir = vault.getAbstractFileByPath(normalizePath(oldPath));
  if (!(oldDir instanceof TFolder)) return { moved: false, reason: "missing" };
  if (oldDir.children.filter((f) => f.name.startsWith("[PLAN] ")).length > 1) return { moved: false, reason: "shared" };
  newPath = normalizePath(newPath);
  if (!vault.getAbstractFileByPath(newPath)) {
    await ensureFolder(newPath.slice(0, newPath.lastIndexOf("/")));
    await fileManager.renameFile(oldDir, newPath);
    return { moved: true };
  }
  // Målmappen findes allerede: flyt indholdet over én ad gangen og fjern den tomme kilde.
  for (const child of [...oldDir.children]) await fileManager.renameFile(child, `${newPath}/${child.name}`);
  if (oldDir.children.length === 0) await vault.delete(oldDir, true);
  return { moved: true };
}

// ── Storage (afløser extensionens storage.local) ──

async function getDownloadedIds() {
  return new Set(plugin.data.downloadedElementIds);
}

async function markDownloaded(id) {
  if (!plugin.data.downloadedElementIds.includes(id)) plugin.data.downloadedElementIds.push(id);
  await plugin.saveData(plugin.data);
}

async function getPlanNoteRecords() {
  return { ...plugin.data.planNoteContentHashes };
}

async function savePlanNoteRecord(noteId, hash, weekFolder) {
  plugin.data.planNoteContentHashes[noteId] = { hash, weekFolder };
  await plugin.saveData(plugin.data);
}

const DEFAULT_SETTINGS = {
  daysBack: 1,
  daysForward: 30,
  enableFileDownloads: true,
  enableTaskCompletionSync: false,
  alarmIntervalHours: 24,
  enableConversion: false,
  pdfableText: false,
  enableHoldCourseSync: false,
  enableCalendarSync: false,
  fagRoot: "Fag",
  opgaverRoot: "Noter/Opgaver",
  selectedCourses: [],
};

// #295: kun valgte fag høstes; standard er ingen. courseNames er kodelisten (fyldes fra kortene), så en
// eksisterende installation uden udvalg får dem den allerede kender valgt én gang, og en ny starter tom.
function migrateSelectedCourses(settings) {
  if (settings.selectedCourses != null) return false;
  settings.selectedCourses = Object.keys(settings.courseNames ?? {});
  return true;
}
// Kortets Title er kursuskoden (samme nøgle som courseNames).
const filterCourses = (cards, selected) => cards.filter((c) => (selected ?? []).includes(c.Title));

async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...plugin.data.settings };
}

// ── Kalender: personlige itslearning-events (#243) ──
// Ét event pr. lektion og pr. afleveringsfrist i itslearnings egen kalender (location "0" = personlig),
// som Outlook og telefonen abonnerer på via iCal-feedet. plan_id -> eventId ligger i data.json
// (calendarEventMap). ItsWiz rører kun event-id'er fra det kort, aldrig noget den ikke selv har oprettet.

// Farvecirkel i kalendertitlen (#270): Hold Course ejer farven (klassens colorIndex), så den sættes ét
// sted. Rækkefølgen følger Hold Courses COLOR_PALETTE: amber, teal, coral, purple, pink, green.
// Pink har ingen egen cirkel, så 🟠 er et kompromis. Uden Hold Course-synk er der intet præfiks.
const COLOR_CIRCLES = ["🟡", "🔵", "🔴", "🟣", "🟠", "🟢"];
// fag -> colorIndex ud fra Hold Courses data.json (vswFag = det fagnavn ItsWiz selv satte på klassen).
function fagColors(holdCourseData) {
  const colors = {};
  for (const sem of holdCourseData?.semesters ?? []) {
    for (const cls of sem.classes ?? []) if (cls.vswFag && Number.isInteger(cls.colorIndex)) colors[cls.vswFag] = cls.colorIndex;
  }
  return colors;
}
const colorPrefix = (fag, colors) => (fag in colors ? `${COLOR_CIRCLES[colors[fag] % COLOR_CIRCLES.length]} ` : "");
const TASK_EVENT_MINUTES = 30;
const CANCELLED_PREFIX = "CANCELLED · ";

// itslearning koder "ingen specifik tid" som 00:01–23:59 (samme regel som background.js).
function planHasSpecificTime(plan) {
  if (!plan?.start || !plan?.stop) return false;
  return (new Date(plan.stop) - new Date(plan.start)) / 3600000 < 23;
}

const escapeHtml = (t) => String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const itslLink = (url, text) => (url ? `<a href="${escapeHtml(url.startsWith("/") ? BASE + url : url)}">${escapeHtml(text)}</a>` : escapeHtml(text));

function calendarTitle(courseName, colors, ...parts) {
  const fag = courseDisplayName(courseName ?? "ukendt-fag");
  return `${colorPrefix(fag, colors)}${fag}: ${parts.filter(Boolean).join(" — ")}`;
}

// itslearning gemmer vægur-tid uden zone, så plan.start.slice(0, 19) er det rigtige format.
function lessonEvent(key, plan, colors) {
  const topic = plan.topic?.name?.trim();
  const title = (plan.title ?? "").replace(/^Uge\s*\d+\s+\S+\s*[-–:]?\s*/i, "").trim();
  const parts = [`<p>${plan.description ?? ""}</p>`];
  const lit = plan.fields?.find((f) => f.headingText?.toLowerCase().includes("litteratur"))?.text;
  if (lit) parts.push(`<p><b>▥ Tilhørende litteratur</b></p>${lit}`);
  for (const el of forberedelseElements(plan)) {
    parts.push(`<p><b>⚒ Forberedelse — ${escapeHtml(el.titel)}</b>${el.url ? " " + itslLink(el.url, "(åbn)") : ""}</p>${el.body ?? ""}`);
  }
  const mats = (plan.elements ?? []).filter((el) => el.typeName !== "Arbejdsopgave");
  if (mats.length) parts.push(`<p><b>Materialer</b></p><ul>${mats.map((el) => `<li>${itslLink(el.url, el.title)}</li>`).join("")}</ul>`);
  return { key, title: calendarTitle(plan.courseName, colors, topic, title), description: parts.join(""), start: plan.start.slice(0, 19), end: plan.stop.slice(0, 19) };
}

function taskEvent(task, colors) {
  const end = task.Deadline.slice(0, 19);
  const start = new Date(new Date(end + "Z").getTime() - TASK_EVENT_MINUTES * 60000).toISOString().slice(0, 19);
  const fag = courseDisplayName(task.CourseTitle ?? "ukendt-fag");
  const title = `${colorPrefix(fag, colors)}⚑ ${fag}: aflevering: ${task.TaskTitle}`;
  return { key: taskId(task), title, description: `<p>${itslLink(task.TaskUrl, "Åbn opgaven i itslearning")}</p>`, start, end };
}

// Alle events der skal findes, fra en høst. Planer uden tid og planer før i går springes over.
function calendarItems(result, nowIso, colors = {}) {
  const from = new Date(new Date(nowIso).getTime() - 86400e3).toISOString().slice(0, 19);
  const items = [];
  for (const [key, plan] of Object.entries({ ...result.plans, ...result.orphanPlans })) {
    if (plan && planHasSpecificTime(plan) && plan.start.slice(0, 19) >= from) items.push(lessonEvent(key, plan, colors));
  }
  for (const task of result.tasks ?? []) if (task.Deadline.slice(0, 19) >= from) items.push(taskEvent(task, colors));
  for (const it of items) it.hash = simpleHash(`${it.title}\n${it.description}`);
  return items;
}

// Ren beslutning: hvad skal der ske med hvert event. map = calendarEventMap, existing = Map eventId ->
// {title, description} for de personlige events der findes nu, seenKeys = alle plan-nøgler høsten
// så (også uden for vinduet/uden tid), okCourseIds = fag hvis planliste blev hentet uden fejl.
// Flyttet (start/end ændret): opret nyt FØR det gamle slettes, så en fejl ikke efterlader et hul.
// Aflyst: planen er væk fra et fag der blev hentet uden fejl, og lektionen ligger fremme i tiden.
function calendarActions(items, map, existing, seenKeys, okCourseIds, nowIso) {
  const actions = [];
  const itemKeys = new Set();
  for (const it of items) {
    itemKeys.add(it.key);
    const e = map[it.key];
    if (!e || !existing.has(e.eventId)) actions.push({ type: "create", item: it }); // også når du selv har slettet den
    else if (e.start !== it.start || e.end !== it.end) actions.push({ type: "move", item: it, oldEventId: e.eventId });
    else if (e.hash !== it.hash || e.cancelled) actions.push({ type: "edit", item: it, eventId: e.eventId });
  }
  const nowLocal = nowIso.slice(0, 19);
  for (const [key, e] of Object.entries(map)) {
    if (itemKeys.has(key) || seenKeys.has(key) || e.cancelled || key.startsWith("opgave:")) continue;
    if (!okCourseIds.has(key.split(":")[0]) || e.start < nowLocal || !existing.has(e.eventId)) continue;
    actions.push({ type: "cancel", key, eventId: e.eventId });
  }
  return actions;
}

// ── Fejl og opsummering (C, #240, gør det til statusbar + notifikationer) ──

let runErrorCount = 0;
let runErrorMessages = [];
let runFilesDownloaded = 0;
let runChangedNotes = [];

function recordError(message) {
  runErrorCount++;
  runErrorMessages.push(message);
}

function capped(lines, more) {
  const shown = lines.slice(0, 5);
  const rest = lines.length - shown.length;
  return shown.join("\n") + (rest > 0 ? `\n+${rest} ${more}` : "");
}

function notifyRunSummary() {
  if (runErrorCount > 0) new Notice(`ItsWiz: ${runErrorCount} element(s) failed\n${capped(runErrorMessages, "more")}`, 0);
  if (runFilesDownloaded === 0 && runChangedNotes.length === 0) return;
  const changed = runChangedNotes.length ? `\n\nChanged:\n${capped(runChangedNotes, "more note(s)")}` : "";
  new Notice(`ItsWiz: ${runFilesDownloaded} file(s) downloaded.${changed}`, 15000);
}

// ── Skjulte vinduer og netværksopsnapning (afløser Chromes tabs/webRequest/downloads) ──

// Én lytter pr. webRequest-event pr. session (Electron-reglen), fordelt til ventende kald.
// Installeres kun under en kørsel: hvert onBeforeRequest koster en IPC-rundtur gennem remote.
class Net {
  constructor(ses) {
    this.ses = ses;
    this.waiters = new Set();
    ses.webRequest.onBeforeRequest({ urls: WATCH_URLS }, (details, callback) => {
      callback({});
      this.emit("before", details);
    });
    ses.webRequest.onCompleted({ urls: WATCH_URLS }, (details) => this.emit("completed", details));
    this.onDownload = (_event, item) => {
      const url = item.getURL();
      item.cancel();
      this.emit("download", { url });
    };
    ses.on("will-download", this.onDownload);
  }

  emit(kind, details) {
    for (const w of [...this.waiters]) {
      if (w.kind !== kind) continue;
      try {
        const hit = w.match(details);
        if (hit !== undefined && hit !== null) w.done(null, hit);
      } catch (err) {
        w.done(err);
      }
    }
  }

  // Resolver med match()'s første ikke-null-resultat; en kastet fejl rejecter. cancel() fjerner ventet.
  wait(kind, match, ms, label) {
    let waiter;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => waiter.done(new Error(`Timeout: ${label} inden for ${ms}ms`)), ms);
      waiter = {
        kind,
        match,
        done: (err, value) => {
          clearTimeout(timer);
          this.waiters.delete(waiter);
          err ? reject(err) : resolve(value);
        },
      };
      this.waiters.add(waiter);
    });
    promise.catch(() => {});
    promise.cancel = () => waiter.done(new Error(`Annulleret: ${label}`));
    return promise;
  }

  dispose() {
    for (const w of [...this.waiters]) w.done(new Error("Kørslen sluttede"));
    this.ses.webRequest.onBeforeRequest(null);
    this.ses.webRequest.onCompleted(null);
    this.ses.removeListener("will-download", this.onDownload);
  }
}

function param(url, name) {
  try {
    return new URL(url).searchParams.get(name);
  } catch {
    return null;
  }
}

// Obsidian lægger en will-navigate-lytter på hvert nyt vindue, der sender enhver side-startet
// navigation (JS-videresendelse, formular-post) til standardbrowseren i stedet. itslearning laver
// den slags under almindelig indlæsning, så hver høst åbnede en CourseCards-fane i browseren
// (set 2026-10-12). Vores vinduer er skjulte og skal navigere selv, så lytteren fjernes.
function itslWindow() {
  const win = new (remote().BrowserWindow)({ show: false, webPreferences: { partition: PARTITION } });
  win.webContents.removeAllListeners("will-navigate");
  return win;
}

function hiddenWindow(url) {
  const win = itslWindow();
  win.loadURL(url, { userAgent: UA }).catch(() => {});
  return win;
}

// Afløser Chromes scripting.executeScript: kører en selvstændig funktion i itslearning-siden.
async function inPage(func, ...args) {
  return harvestWin.webContents.executeJavaScript(`(${func})(${args.map((a) => JSON.stringify(a)).join(",")})`);
}

// Kæde A: elementets side → PdfViewer/Viewer.aspx?FileDownloadUrl=…&FileName=… (se background.js).
async function resolvePdfDownloadUrl(elementUrl, timeoutMs = 20000) {
  const hit = net.wait("before", (d) => {
    if (!/platform\.itslearning\.com\/PdfViewer\/Viewer\.aspx/.test(d.url)) return null;
    const url = param(d.url, "FileDownloadUrl");
    return url ? { url, fileName: param(d.url, "FileName") } : null;
  }, timeoutMs, "intet PdfViewer/Viewer.aspx-kald");
  const win = hiddenWindow(BASE + elementUrl);
  try {
    return await hit;
  } finally {
    win.destroy();
  }
}

// Kæde B (File/View.aspx → DownloadRedirect.ashx → filecache) mod native download og WOPI-tokenet,
// samme Promise.any som background.js' resolveOfficeDownloadUrl.
async function resolveOfficeDownloadUrl(elementUrl, timeoutMs = 20000) {
  const native = net.wait("download", (d) => d.url, timeoutMs * 2, "Ingen native download opstod");
  const wopi = net.wait("before", (d) => {
    if (!/officeapps\.live\.com/.test(d.url) || !d.uploadData) return null;
    const src = param(d.url, "WOPISrc");
    const body = d.uploadData.map((p) => (p.bytes ? Buffer.from(p.bytes).toString() : "")).join("");
    const token = new URLSearchParams(body).get("access_token");
    return src && token ? `${src}/contents?access_token=${encodeURIComponent(token)}` : null;
  }, timeoutMs * 2, "Intet WOPI access_token opsnappet");
  const fileView = net.wait("before", (d) => (/resource\.itslearning\.com\/File\/View\.aspx/.test(d.url) ? d.url : null), timeoutMs, "intet File/View.aspx-kald");
  const win = hiddenWindow(BASE + elementUrl);
  const primary = (async () => {
    const viewUrl = await fileView;
    const lo = param(viewUrl, "LearningObjectId");
    const loi = param(viewUrl, "LearningObjectInstanceId");
    if (!lo || !loi) throw new Error(`Missing LearningObjectId/LearningObjectInstanceId in ${viewUrl}`);
    const cache = net.wait("before", (d) => (/filecache\.itslearning\.com/.test(d.url) ? d.url : null), timeoutMs, "intet filecache-kald");
    const refused = net.wait("completed", (d) => {
      if (/DownloadRedirect\.ashx/.test(d.url) && d.statusCode >= 400) throw new Error(`DownloadRedirect.ashx rejected by itslearning (status ${d.statusCode})`);
      return null;
    }, timeoutMs, "ingen afvisning");
    win.loadURL(`https://resource.itslearning.com/Proxy/DownloadRedirect.ashx?LearningObjectId=${lo}&LearningObjectInstanceId=${loi}`, { userAgent: UA }).catch(() => {});
    try {
      return await Promise.race([cache, refused]);
    } finally {
      cache.cancel();
      refused.cancel();
    }
  })();
  try {
    return await Promise.any([primary, native, wopi]);
  } catch (err) {
    if (err instanceof AggregateError) {
      // Foretræk itslearning-cache-fejlen (403 osv.); de to andre er generiske timeouts.
      throw err.errors.find((e) => !/^(Timeout: )?(Ingen native download|Intet WOPI)/.test(e.message)) ?? err.errors[0];
    }
    throw err;
  } finally {
    native.cancel();
    wopi.cancel();
    fileView.cancel();
    win.destroy();
  }
}

// Mapper (#24): uændret logik, fetchFolderElementsInPage kører i itslearning-siden.
async function expandFolderElement(tabId, element, depth = 0) {
  if (depth > 5) {
    console.warn(`VIAstudyWiz: Mappe "${element.title}" er over 5 niveauer dyb, stopper rekursion`);
    return [];
  }
  const children = await inPage(fetchFolderElementsInPage, `https://via.itslearning.com${element.url}`);
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

// issue #70: se toggleTaskCompletedInPage. Samme idempotens via isCompleted som i background.js.
async function completeTasks(forberedelse, tabId) {
  for (const el of forberedelse) {
    try {
      await inPage(toggleTaskCompletedInPage, el.url);
    } catch (err) {
      console.error(`VIAstudyWiz TaskCompletedToggle-fejl ("${el.titel}"):`, err);
      recordError(`Could not mark "${el.titel}" as completed in itslearning: ${err.message}`);
    }
  }
}

// Afleveringsopgave-vedhæftninger (kæde E, se kommentaren ved ASSIGNMENT_TOOL_HOST): SSO-kæden
// kører i en indlejret iframe. Vent til assignment.itslearning.com-kaldene falder til ro, og læs
// så HTML'en fra den frame. Filen hentes inde i samme frame, fordi download-URL'en kræver
// assignment-domænets session-cookie; bytes kommer tilbage som base64.
function waitForAssignmentToSettle(webContentsId, timeoutMs, quietMs = 1500) {
  return new Promise((resolve, reject) => {
    let quietTimer = null;
    let last = null;
    const settled = net.wait("before", (d) => {
      if (d.webContentsId !== webContentsId || !d.url.includes(ASSIGNMENT_TOOL_HOST)) return null;
      last = d.url;
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => {
        settled.cancel();
        resolve(last);
      }, quietMs);
      return null;
    }, timeoutMs, `intet kald til ${ASSIGNMENT_TOOL_HOST}`);
    settled.catch((err) => {
      if (last === null) reject(err);
    });
  });
}

async function downloadTaskAttachment(task, root = OPGAVER_ROOT) {
  if (!task.TaskUrl) return null;

  const win = hiddenWindow(task.TaskUrl);
  try {
    await waitForAssignmentToSettle(win.webContents.id, 20000);
    const frame = win.webContents.mainFrame.framesInSubtree.find((f) => f.url.includes(ASSIGNMENT_TOOL_HOST));
    if (!frame) throw new Error(`no ${ASSIGNMENT_TOOL_HOST} frame in the assignment page`);
    const file = extractAssignmentFile(await frame.executeJavaScript("document.documentElement.outerHTML"));
    if (!file) {
      console.warn(`VIAstudyWiz: siden landede for opgaven "${task.TaskTitle}", men fileListControl-data blev ikke fundet i HTML'en`);
      return null;
    }
    const base64 = await frame.executeJavaScript(`fetch(${JSON.stringify(file.url)}, { credentials: "include" })
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.blob(); })
      .then((b) => new Promise((ok) => { const fr = new FileReader(); fr.onload = () => ok(fr.result.split(",")[1]); fr.readAsDataURL(b); }))`);

    const folder = sanitizeFilename(task.TaskTitle ?? "opgave");
    const rawName = sanitizeFilename(file.name);
    const stem = rawName.replace(/\.[^./]+$/, "");
    await writeToVault(`${root}/${folder}/RAW/${rawName}`, `data:application/octet-stream;base64,${base64}`);
    runFilesDownloaded++;
    return `${root}/${folder}/MD/${stem}.md`;
  } catch (err) {
    console.warn(`VIAstudyWiz: ingen vedhæftning fundet for opgaven "${task.TaskTitle}":`, err);
    return null;
  } finally {
    win.destroy();
  }
}

// ── Kørslen (afløser collectAndDownload/runCollectAndDownload) ──

// Logget ud sender START_URL videre med JS (log_out.aspx), som afbryder loadURL med ERR_ABORTED.
// Det er ikke en fejl: collect() tjekker selv login bagefter.
async function loadStart() {
  await harvestWin.loadURL(START_URL, { userAgent: UA }).catch((err) => {
    if (err.code !== "ERR_ABORTED") throw err;
  });
}

async function openHarvestWindow() {
  harvestWin = itslWindow();
  await loadStart();
  net = new Net(remote().session.fromPartition(PARTITION));
}

function closeHarvestWindow() {
  net?.dispose();
  net = null;
  harvestWin?.destroy();
  harvestWin = null;
}

const LOGIN_ERROR = "Not logged in to itslearning. Log in in the ItsWiz tab and try again.";
const KEEPALIVE_MINUTES = 10;

// REST-kald direkte fra partitionens session: samme cookies som fanen, intet vindue.
async function restStatus(path, method = "GET") {
  const res = await remote().session.fromPartition(PARTITION).fetch(BASE + path, { method, credentials: "include" });
  return res.status;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isLoggedIn = async () => (await restStatus("/restapi/personal/courses/cards/starred/v1")) === 200;

// Automatisk gen-login: Microsoft husker "Forbliv logget ind" i ESTSAUTHPERSISTENT-cookien på
// partitionen. En udløbet session sender START_URL via log_out.aspx?SessionExpired=3 videre til
// itslearning.via.dk, som går direkte til Microsoft-SSO, og så længe cookien lever, kører hele
// kæden igennem uden input (målt 2026-10-12: 401 → 200 på REST uden klik). Kræver Microsoft
// input (kontovalg, MFA), giver vi op.
//
// Et webview uden for skærmen, ikke et skjult vindue: i et skjult BrowserWindow gik kæden i stå
// på Microsofts auto-postede SAML-svar ("Working…"), også uden Obsidians will-navigate-lytter.
async function relogin(timeoutMs = 45000) {
  const wv = document.createElement("webview");
  wv.setAttribute("partition", PARTITION);
  wv.setAttribute("useragent", UA);
  wv.setAttribute("src", START_URL);
  wv.style.cssText = "position:fixed;left:-10000px;top:0;width:800px;height:600px";
  document.body.appendChild(wv);
  try {
    for (const end = Date.now() + timeoutMs; Date.now() < end; ) {
      await sleep(1500);
      if (await isLoggedIn()) {
        console.log("ItsWiz: automatisk gen-login lykkedes");
        return true;
      }
    }
    console.warn(`ItsWiz: automatisk gen-login gav op på ${wv.getURL()}`);
    return false;
  } finally {
    wv.remove();
  }
}

// Udløbet login fra automatikken giver én besked og åbner fanen, ikke en ny besked hvert interval.
// Nulstilles af næste lykkedes kørsel eller keep-alive.
function notifyLoginNeeded(auto) {
  if (auto && plugin.loginNotified) return;
  plugin.loginNotified = true;
  new Notice(`ItsWiz: ${LOGIN_ERROR}`, 0);
  plugin.openView();
}

// Hvert KEEPALIVE_MINUTES: hold itslearning-sessionen varm som en åben fane gør, og start en
// planlagt kørsel når alarmIntervalHours er gået.
async function tick() {
  if (isRunning) return;
  const { alarmIntervalHours } = await getSettings();
  if (Date.now() - (plugin.lastStartedAt ?? 0) >= alarmIntervalHours * 3600e3) return runCollectAndDownload({ auto: true });
  try {
    let ok = (await restStatus("/restapi/keepalive/online/v1", "POST")) === 200 || (await isLoggedIn());
    if (!ok && !plugin.loginNotified) ok = await relogin();
    if (!ok) return notifyLoginNeeded(true);
    // Logget ind igen siden beskeden (fx manuelt i fanen): høst med det samme.
    if (plugin.loginNotified) runCollectAndDownload({ auto: true });
  } catch (err) {
    console.warn("ItsWiz: keep-alive fejlede:", err);
  }
}

async function inPageLoggedIn(func, ...args) {
  // Udløbet login svarer 401 med JSON ("Accesstoken is empty, invalid or has expired."), målt
  // 2026-10-12, ikke kun en login-side som #134 så i Chrome.
  if (!(await isLoggedIn())) {
    if (!(await relogin())) throw new Error(LOGIN_ERROR);
    await loadStart();
  }
  try {
    return await inPage(func, ...args);
  } catch (err) {
    // #134: et ikke-JSON-svar betyder næsten altid udløbet login.
    if (/Non-JSON/.test(err.message)) throw new Error(LOGIN_ERROR);
    throw err;
  }
}

// #295: henter alle kort, men resten af kørslen kun for de valgte. Uden valgte fag er resultatet tomt
// (kun allCourses), så kortene stadig kan registreres og vælges.
async function collect(startUnix, endUnix) {
  const allCourses = await inPageLoggedIn(fetchCourseCardsInPage);
  const courses = filterCourses(allCourses, plugin.data.settings.selectedCourses);
  if (!courses.length) return { allCourses, courses, events: [], plans: {}, orphanPlans: {}, okCourseIds: [], tasks: [] };
  return { allCourses, ...(await inPageLoggedIn(collectRangeInPage, startUnix, endUnix, courses)) };
}

// Ukendte kursuskoder fra en høst tilføjes til indstillingen courseNames med tomt navn (= den rå
// kode, som er det eneste itslearning kender: kortets Title er koden selv), så de dukker op i
// indstillingerne og kan få et pænt navn (#270).
async function registerCourseCodes(result) {
  const names = (plugin.data.settings.courseNames ??= {});
  const codes = [
    ...(result.allCourses ?? []).map((c) => c.Title),
    ...Object.values({ ...result.plans, ...result.orphanPlans }).map((p) => p?.courseName),
    ...(result.tasks ?? []).map((t) => t.CourseTitle),
  ].filter((c) => c && !(c in names));
  if (!codes.length) return;
  for (const code of codes) names[code] = "";
  applyCourseNames(plugin.data.settings);
  await plugin.saveData(plugin.data);
}

async function collectAndDownload(startUnix, endUnix) {
  console.log(`VIAstudyWiz: starter kørsel (${new Date(startUnix * 1000).toISOString()} → ${new Date(endUnix * 1000).toISOString()})`);
  runErrorCount = 0;
  runErrorMessages = [];
  runFilesDownloaded = 0;
  runChangedNotes = [];
  const settings = await getSettings();

  await openHarvestWindow();
  try {
    const result = await collect(startUnix, endUnix);
    console.log(
      `VIAstudyWiz: hentede ${result.courses.length} fag, ${result.events.length} events, ${Object.keys(result.plans).length} planer, ${(result.tasks ?? []).length} opgaver med deadline`
    );
    await registerCourseCodes(result);
    if (!result.courses.length) {
      new Notice("ItsWiz: no courses selected. Pick them under Settings → ItsWiz → Courses.");
      return result;
    }
    // Download FØR noteskrivning (#129): writePlanNotes linker kun til filer der findes.
    if (settings.enableFileDownloads) {
      // ItsWiz: myEvents returnerer kun begivenheder fra stjernemarkerede rum (målt 2026-10-12:
      // 0 events i september med alle 12 rum uden stjerne), og stjernerne er fjernet for kalenderens
      // skyld (#243). De "forældreløse" planer fra plans/all/v1 er derfor nu den primære kilde.
      const plans = { ...result.plans, ...result.orphanPlans };
      await downloadFileElements(plans, null);
      await writePlanNotes(plans, null, settings.enableTaskCompletionSync);
      await writeTaskNotes(result.tasks ?? []);
    }
    if (settings.enableCalendarSync) {
      try {
        await syncCalendar(result);
      } catch (err) {
        console.error("ItsWiz kalender-fejl:", err);
        recordError(`Calendar: ${err.message}`);
      }
    }
    notifyRunSummary();
    console.log("VIAstudyWiz: kørsel færdig");
    return result;
  } finally {
    closeHarvestWindow();
  }
}

// auto: startet af opstart/interval, ikke et klik. Så ingen "høster…"-besked og højst én login-besked.
async function runCollectAndDownload({ auto = false } = {}) {
  if (isRunning) {
    if (!auto) new Notice("ItsWiz: a run is already in progress.");
    return;
  }
  // Låsen sættes før første await, ellers kan to triggere begge nå forbi tjekket.
  isRunning = true;
  plugin.lastStartedAt = Date.now();
  plugin.lastRun = null;
  updateStatusBar();
  try {
    // Uden importen ville første kørsel backfille 400 dage og skrive alle lektionsplaner om (#239).
    if (plugin.data.syncedFrontmatterVersion == null && (await existsInVault(FAG_ROOT))) {
      throw new Error("The vault already has VIAstudyWiz notes. Run \"Import VIAstudyWiz data from the clipboard\" before the first harvest.");
    }
    if (!auto) new Notice("ItsWiz: harvesting…");
    const syncedVersion = plugin.data[FRONTMATTER_VERSION_KEY];
    const isBackfill = syncedVersion !== FRONTMATTER_VERSION;

    const { daysBack, daysForward } = await getSettings();
    const now = Math.floor(Date.now() / 1000);
    const start = now - (isBackfill ? BACKFILL_DAYS_BACK : daysBack) * 24 * 60 * 60;
    const end = now + daysForward * 24 * 60 * 60;
    if (isBackfill) {
      console.log(`VIAstudyWiz: frontmatter-version ${syncedVersion ?? "(ingen)"} -> ${FRONTMATTER_VERSION}, backfiller ${BACKFILL_DAYS_BACK} dage tilbage`);
    }
    const result = await collectAndDownload(start, end);
    plugin.loginNotified = false;
    // Uden valgte fag er der ikke backfillet noget, så versionen må ikke stemples (#295).
    if (isBackfill && result.courses.length) {
      plugin.data[FRONTMATTER_VERSION_KEY] = FRONTMATTER_VERSION;
      await plugin.saveData(plugin.data);
    }
  } catch (err) {
    console.error("VIAstudyWiz fejl:", err);
    if (err.message === LOGIN_ERROR) notifyLoginNeeded(auto);
    else new Notice(`ItsWiz: run failed\n${err.message ?? err}`, 0);
    plugin.lastRun = { failure: err.message };
  } finally {
    // Seneste kørsel, til C (#240, statusbar) og til at aflæse en kørsel udefra (obsidian eval).
    plugin.lastRun = { ...plugin.lastRun, finishedAt: new Date().toISOString(), files: runFilesDownloaded, errors: runErrorMessages, changed: runChangedNotes };
    isRunning = false;
    updateStatusBar();
  }
}

// #295: hent kursuslisten uden at høste, så fagene kan vælges før første kørsel.
async function fetchCourseList() {
  if (isRunning) return new Notice("ItsWiz: a run is already in progress.");
  isRunning = true;
  try {
    await openHarvestWindow();
    await registerCourseCodes({ allCourses: await inPageLoggedIn(fetchCourseCardsInPage) });
    new Notice("ItsWiz: course list updated.");
  } catch (err) {
    if (err.message === LOGIN_ERROR) notifyLoginNeeded(false);
    else new Notice(`ItsWiz: could not fetch courses\n${err.message ?? err}`, 0);
  } finally {
    closeHarvestWindow();
    isRunning = false;
  }
}

// ── Kalender-kald (#243) ──

// Kører i itslearning-siden (samme cookies). Kun sletning kræver anti-forgery-token, som står i
// Schedule.aspx; siden hentes som tekst, uden at navigere (forsiden må aldrig indlæses).
async function calendarCallInPage(method, path, body, withToken) {
  const headers = { "x-requested-with": "XMLHttpRequest", "content-type": "application/json; charset=UTF-8" };
  if (withToken) {
    const html = await (await fetch("/Calendar/Schedule.aspx", { credentials: "include" })).text();
    // Målt 2026-10-12: antiForgeryHeaderSettings = {"headerName":"__ITSL_ANTIFORGERY_TOKEN__","headerValue":"…"}.
    const raw = html.match(/antiForgeryHeaderSettings\s*=\s*(\{[^}]*\})/)?.[1];
    const { headerName, headerValue } = raw ? JSON.parse(raw) : {};
    if (!headerName || !headerValue) throw new Error("anti-forgery token not found in Schedule.aspx");
    headers[headerName] = headerValue;
  }
  const res = await fetch(path, { method, credentials: "include", headers, body: body == null ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json };
}

async function calendarCall(method, path, body, withToken = false) {
  const { status, json } = await inPage(calendarCallInPage, method, path, body, withToken);
  if (status >= 300) throw new Error(`${method} ${path.split("?")[0]} responded ${status}`);
  return json;
}

const calendarCreate = async (it) =>
  Number((await calendarCall("POST", "/RestApi/calendar/createEventWithLocation", {
    location: "0", groupId: 0, start: it.start, end: it.end, title: it.title, description: it.description,
    extraDescription: "", elementIds: "[]", nextEventId: 0, EventIdToCopy: 0,
  })).createdEvent.id);

async function calendarEdit(eventId, title, description) {
  await calendarCall("PUT", "/RestApi/calendar/editEventTitle", { EventId: eventId, Text: title, HasResources: false });
  await calendarCall("PUT", "/RestApi/calendar/editEventDescription", { EventId: eventId, Text: description, HasResources: false });
}

// Sletning er idempotent (204 også ved gentagelse). Kun id'er ItsWiz selv har oprettet kommer hertil.
const calendarDelete = (eventId) =>
  calendarCall("DELETE", `/RestApi/calendarevents/deleteevent/events/${eventId}/v1?deleteRecurringSeries=false`, null, true); // null, ikke undefined: inPage kan ikke serialisere undefined

// eventId -> {title, description} for personlige events i [fromIso, toIso].
async function calendarListPersonal(fromIso, toIso) {
  const filter = JSON.stringify({ courseIds: [], projectIds: [], personal: true, hierarchyIds: [] });
  const unix = (iso) => Math.floor(Date.parse(iso + "Z") / 1000);
  const r = await calendarCall("POST", "/RestApi/calendar/myEvents", { filter, start: unix(fromIso) - 86400, end: unix(toIso) + 86400 });
  // Målt 2026-10-12: en array af {id (streng), EventTitle, start, end, description, …}. `title` er kategorien ("Personlig").
  return new Map((r ?? []).map((e) => [Number(e.id), { title: e.EventTitle, description: e.description ?? "" }]));
}

const saveCalendar = () => plugin.saveData(plugin.data);

// Slet det der står i køen (flyttede events og "fjern alle"). Det der fejler, bliver i køen til næste gang.
async function drainCalendarDeleteQueue() {
  const queue = plugin.data.calendarDeleteQueue;
  for (const id of [...queue]) {
    try {
      await calendarDelete(id);
      queue.splice(queue.indexOf(id), 1);
      await saveCalendar();
    } catch (err) {
      recordError(`Calendar: could not delete ${id}: ${err.message}`);
    }
  }
}

async function syncCalendar(result) {
  const map = plugin.data.calendarEventMap;
  const nowIso = new Date().toISOString();
  const colors = (await getSettings()).enableHoldCourseSync ? fagColors(await readHoldCourseData()) : {};
  const items = calendarItems(result, nowIso, colors);
  plugin.lastCalendar = { items: items.length, plans: Object.keys({ ...result.plans, ...result.orphanPlans }).length, tasks: (result.tasks ?? []).length }; // aflæses udefra (obsidian eval)
  const starts = [...items, ...Object.values(map)];
  if (starts.length === 0) return;
  const existing = await calendarListPersonal(
    starts.map((i) => i.start).sort()[0],
    starts.map((i) => i.end).sort().at(-1)
  );
  const seenKeys = new Set(Object.keys({ ...result.plans, ...result.orphanPlans }));
  const actions = calendarActions(items, map, existing, seenKeys, new Set(result.okCourseIds ?? []), nowIso);
  const counts = { create: 0, edit: 0, move: 0, cancel: 0 };
  for (const a of actions) {
    try {
      if (a.type === "create" || a.type === "move") {
        // Opret FØR det gamle slettes: en fejl midt i efterlader aldrig et hul.
        const eventId = await calendarCreate(a.item);
        map[a.item.key] = { eventId, start: a.item.start, end: a.item.end, hash: a.item.hash, cancelled: false };
        if (a.oldEventId) plugin.data.calendarDeleteQueue.push(a.oldEventId);
        await saveCalendar(); // efter HVER oprettelse, så et nedbrud ikke giver dubletter
      } else if (a.type === "edit") {
        await calendarEdit(a.eventId, a.item.title, a.item.description);
        Object.assign(map[a.item.key], { hash: a.item.hash, cancelled: false });
        await saveCalendar();
      } else {
        const cur = existing.get(a.eventId);
        await calendarEdit(
          a.eventId,
          CANCELLED_PREFIX + cur.title,
          `<p>Lektionen findes ikke længere i itslearning, set ${nowIso.slice(0, 10)}.</p>${cur.description}`
        );
        map[a.key].cancelled = true;
        await saveCalendar();
      }
      counts[a.type]++;
    } catch (err) {
      recordError(`Calendar (${a.type} ${a.item?.title ?? a.key}): ${err.message}`);
    }
  }
  await drainCalendarDeleteQueue();
  Object.assign(plugin.lastCalendar, { counts, existing: existing.size });
  console.log(`ItsWiz: kalender ${JSON.stringify(counts)}, ${items.length} events i vinduet`);
}

// Vejen tilbage: sletter alt ItsWiz har oprettet, aldrig andet.
async function removeAllCalendarEvents() {
  if (isRunning) return new Notice("ItsWiz: a run is already in progress.");
  isRunning = true;
  try {
    await openHarvestWindow();
    const map = plugin.data.calendarEventMap;
    plugin.data.calendarDeleteQueue.push(...Object.values(map).map((e) => e.eventId));
    plugin.data.calendarEventMap = {};
    await saveCalendar();
    runErrorMessages = [];
    await drainCalendarDeleteQueue();
    const left = plugin.data.calendarDeleteQueue.length;
    new Notice(left ? `ItsWiz: ${left} calendar events could not be deleted, try again.` : "ItsWiz: all ItsWiz calendar events deleted.");
  } catch (err) {
    new Notice(`ItsWiz: removal failed\n${err.message ?? err}`, 0);
  } finally {
    closeHarvestWindow();
    isRunning = false;
  }
}

// ── Statusbar: sidste kørsel og antal fejl, klik viser fejllisten ──

function updateStatusBar() {
  const el = plugin.statusEl;
  if (!el) return;
  const r = plugin.lastRun;
  if (isRunning) return el.setText("ItsWiz: harvesting…");
  if (!r) return el.setText("ItsWiz: not run");
  const time = new Date(r.finishedAt).toLocaleTimeString("da-DK", { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit" });
  const errors = (r.errors?.length ?? 0) + (r.failure ? 1 : 0);
  el.setText(`ItsWiz ${time}${r.failure ? " · failed" : errors ? ` · ${errors} error(s)` : ""}`);
}

function showRunErrors() {
  const r = plugin.lastRun;
  const lines = [...(r?.failure ? [`Run failed: ${r.failure}`] : []), ...(r?.errors ?? [])];
  const modal = new Modal(plugin.app);
  modal.titleEl.setText(r ? `ItsWiz: run ${new Date(r.finishedAt).toLocaleString("da-DK", { timeZone: TIME_ZONE })}` : "ItsWiz: not run yet");
  if (r) modal.contentEl.createEl("p", { text: `${r.files ?? 0} file(s) downloaded, ${r.changed?.length ?? 0} note(s) changed.` });
  if (lines.length) modal.contentEl.createEl("pre", { text: lines.join("\n"), attr: { style: "white-space:pre-wrap" } });
  else if (r) modal.contentEl.createEl("p", { text: "No errors." });
  modal.open();
}

// ── Sti-test: én fil pr. download-vej til ItsWiz-test/, rører ikke fag- eller opgavemappen ──

function officeChain(url) {
  if (/filecache\.itslearning\.com/.test(url)) return "itslearnings filecache";
  if (url.includes("/contents?access_token=")) return "WOPI";
  return "native download";
}

async function runPathTest(daysBack = 135, daysForward = 30) {
  if (isRunning) return new Notice("ItsWiz: a run is already in progress.");
  isRunning = true;
  new Notice("ItsWiz: path test running…");
  runErrorCount = 0;
  runErrorMessages = [];
  runFilesDownloaded = 0;
  const log = [`# ItsWiz sti-test — ${new Date().toLocaleString("da-DK", { timeZone: TIME_ZONE })}`, ""];
  const step = (ok, text) => {
    log.push(`- ${ok ? "✅" : "❌"} ${text}`);
    console.log(`ItsWiz sti-test: ${ok ? "OK" : "FEJL"} ${text}`);
  };
  const save = async (label, element, url, ext) => {
    const name = sanitizeFilename(element.title.replace(/\.[a-z0-9]{2,5}$/i, "")) + ext;
    await writeToVault(`${TEST_ROOT}/${name}`, url);
    return `[[${TEST_ROOT}/${name}]]`;
  };
  try {
    await openHarvestWindow();
    const now = Math.floor(Date.now() / 1000);
    const result = await collect(now - daysBack * 86400, now + daysForward * 86400);
    const elements = Object.values({ ...result.plans, ...result.orphanPlans }).filter(Boolean).flatMap((p) => p.elements ?? []);
    const files = elements.filter((e) => !NON_FILE_TYPE_NAMES.has(e.typeName));
    const lower = (e) => e.title.toLowerCase();
    log.push(`Vindue: ${daysBack} dage tilbage, ${daysForward} frem. ${Object.keys({ ...result.plans, ...result.orphanPlans }).length} planer, ${files.length} fil-elementer, ${result.tasks.length} opgaver.`, "");

    const pdf = files.find((e) => lower(e).endsWith(".pdf"));
    if (!pdf) step(false, "PDF: intet element i vinduet");
    else {
      const { url } = await resolvePdfDownloadUrl(pdf.url);
      step(true, `PDF: "${pdf.title}" via PDF-kæden → ${await save("PDF", pdf, url, ".pdf")}`);
    }

    // Prøv Office-elementer til alle tre veje er set eller 30 er prøvet: hvilken vej der rammer,
    // afgøres af itslearning pr. dokument, ikke af os.
    const seen = new Set();
    for (const el of files.filter((e) => OFFICE_EXTENSIONS.some((x) => lower(e).endsWith(x))).slice(0, 30)) {
      try {
        const url = await resolveOfficeDownloadUrl(el.url);
        const chain = officeChain(url);
        if (seen.has(chain)) continue;
        seen.add(chain);
        step(true, `Office: "${el.title}" via ${chain} → ${await save("Office", el, url, lower(el).match(/\.[a-z]+$/)[0])}`);
      } catch (err) {
        step(false, `Office: "${el.title}": ${err.message}`);
      }
      if (seen.size === 3) break;
    }
    for (const chain of ["itslearnings filecache", "native download", "WOPI"]) {
      if (!seen.has(chain)) step(false, `Office via ${chain}: ingen af de prøvede dokumenter gik den vej`);
    }

    const unknown = files.find((e) => !/\.[a-z0-9]{2,5}$/i.test(e.title));
    if (!unknown) step(false, "Uden endelse: intet element i vinduet");
    else {
      const resolved = await resolveDownloadUrlUnknownType(unknown.url);
      const ext =
        resolved.fileName?.match(/\.[a-z0-9]{2,5}$/i)?.[0]?.toLowerCase() ||
        extractExtension(resolved.url) ||
        (resolved.url.includes("/contents?access_token=") ? await extractExtensionFromWopi(resolved.url) : "");
      step(!!ext, `Uden endelse: "${unknown.title}" → endelse "${ext || "(ingen)"}"${ext ? ` → ${await save("Ukendt", unknown, resolved.url, ext)}` : ""}`);
    }

    const folder = elements.find((e) => e.typeName === "Mappe");
    if (!folder) step(false, "Mappe: intet Mappe-element i vinduet");
    else {
      const children = await expandFolderElement(null, folder);
      step(children.length > 0, `Mappe: "${folder.title}" udpakket til ${children.length} element(er): ${children.slice(0, 3).map((c) => `"${c.title}"`).join(", ")}`);
    }

    const task = result.tasks.find((t) => t.TaskUrl);
    if (!task) step(false, "Opgave-vedhæftning: ingen opgave med deadline i vinduet");
    else {
      const md = await downloadTaskAttachment(task, TEST_ROOT);
      step(!!md, `Opgave-vedhæftning: "${task.TaskTitle}" → ${md ? `RAW-fil hentet (MD-sti ${md})` : "ingen vedhæftning fundet (se konsollen)"}`);
    }
  } catch (err) {
    step(false, `Afbrudt: ${err.message}`);
  } finally {
    closeHarvestWindow();
    isRunning = false;
  }
  const report = `${TEST_ROOT}/sti-test.md`;
  await writeVaultFile(report, log.join("\n") + "\n");
  new Notice(`ItsWiz: path test done, see ${report}`);
  plugin.app.workspace.openLinkText(report, "", "split");
}

// ── Engangs-import fra extensionen ──
// Brugt én gang ved skiftet (#239): et JSON-dump af extensionens storage.local i udklipsholderen,
// og så kommandoen "Import VIAstudyWiz data from the clipboard" her. calendarEventMap hører
// til F (#243) og tages ikke med.
async function importExtensionData() {
  let src;
  try {
    src = JSON.parse(await navigator.clipboard.readText());
  } catch {
    return new Notice("ItsWiz: the clipboard does not contain JSON from the extension. Run the snippet first.", 0);
  }
  if (!Array.isArray(src.downloadedElementIds) && !src.planNoteContentHashes) {
    return new Notice("ItsWiz: the JSON does not look like VIAstudyWiz data (missing downloadedElementIds/planNoteContentHashes).", 0);
  }
  const d = plugin.data;
  const ids = new Set([...d.downloadedElementIds, ...(src.downloadedElementIds ?? [])]);
  d.downloadedElementIds = [...ids];
  d.planNoteContentHashes = { ...(src.planNoteContentHashes ?? {}), ...d.planNoteContentHashes };
  if (src.syncedFrontmatterVersion != null && d.syncedFrontmatterVersion == null) d.syncedFrontmatterVersion = src.syncedFrontmatterVersion;
  const s = src.viastudywizSettings ?? {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) if (s[key] != null && d.settings[key] == null) d.settings[key] = s[key];
  await plugin.saveData(d);
  new Notice(
    `ItsWiz: imported ${ids.size} downloaded ids, ${Object.keys(d.planNoteContentHashes).length} plan hashes, frontmatter version ${d.syncedFrontmatterVersion ?? "(none)"}.`,
    0
  );
}

// ── Konvertering: RAW → MinerU → MD (D, #241) ──
//
// Porteret fra watchfolder/watch_viastudywiz.py; kommentarerne dér forklarer hvorfor (#42, #99, #101,
// #103, #142, #148, #186, #232). Her står kun det der er anderledes i pluginet. MinerU er et tilvalg:
// uden token og uden "Convert RAW files" slået til sker intet, og [PLAN]-noterne linker til RAW (#241).

const MINERU_API = "https://mineru.net/api/v4";
const MINERU_TOKEN_URL = "https://mineru.net/apiManage/token";
const CONVERT_SUFFIXES = [".pdf", ...OFFICE_EXTENSIONS];
const POLL_INTERVAL_MS = 8e3;
const POLL_TIMEOUT_MS = 20 * 60e3;
const UPLOAD_TIMEOUT_MS = 20 * 60e3;
const UPLOAD_RETRIES = 3;
const UPLOAD_RETRY_BACKOFF_MS = 30e3;
const CACHE_TTL_MS = 7 * 24 * 60 * 60e3;
const ANCHOR_LENGTH = 40;
const AUTO_MATERIALER_RE = /^## Materials\n([\s\S]*?)(?=\n## |\n<!-- AUTO:END|$(?![\s\S]))/m;
const HIGHLIGHT_RE = /==[^=\n]+==/;

// Nøglen ligger i Obsidians localStorage pr. enhed, ikke i data.json: plugin-data i ViaVault er
// git-tracket og pushes til GitHub, og synkes til Boox'en.
const MINERU_TOKEN_KEY = "itswiz-mineru-token";
const mineruToken = () => plugin.app.loadLocalStorage(MINERU_TOKEN_KEY) ?? "";

// MinerU har sagt nej (fx over 200 sider): markeres som fejlet. Alt andet (netværk, timeout) er
// forbigående og prøves igen ved næste start (#250).
class MineruError extends Error {}

// watcherens sanitize(): som sanitizeFilename, men UDEN at fjerne afsluttende punktum — MD-noter
// hedder allerede "…korte..md", og navnene skal blive ved med at matche.
function stemName(stem) {
  return stem.replace(/[\\/:*?"<>|]/g, "_").trim();
}

// Path.stem: alt før sidste ".", undtagen et punktum forrest.
function stemOf(name) {
  const k = name.lastIndexOf(".");
  return k > 0 ? name.slice(0, k) : name;
}

function mdTargets(rawFilePath) {
  const parts = rawFilePath.split("/");
  const i = parts.lastIndexOf("RAW", parts.length - 2);
  const mdDir = [...parts.slice(0, i), "MD", ...parts.slice(i + 1, -1)].join("/");
  const title = stemName(stemOf(parts[parts.length - 1]));
  return { mdDir, md: `${mdDir}/${title}.md`, images: `${mdDir}/_attachments/${title}`, rawRoot: parts.slice(0, i + 1).join("/"), fagFolder: parts[i - 1] ?? "" };
}

// #275: the copy a device can read (PDFable's reading copy, or a plain copy of the original) lives in
// _attachments/ next to the images, so MD/ itself only holds notes. It is a sibling of the image folder,
// which is wiped on every conversion. It gets its own name, so [[X.pdf]] links to the RAW original stay
// unambiguous on the Mac.
function copyTarget(rawFilePath) {
  const { mdDir } = mdTargets(rawFilePath);
  const name = rawFilePath.slice(rawFilePath.lastIndexOf("/") + 1);
  return `${mdDir}/_attachments/${stemName(stemOf(name))} (copy)${name.slice(stemOf(name).length)}`;
}

function inRawBranch(path) {
  // Kun de to rødder: en tilfældig RAW/-mappe andre steder i en fremmed vault sendes ikke til MinerU (#269).
  return (underRoot(path, FAG_ROOT) || underRoot(path, OPGAVER_ROOT) || EXTRA_FOLDERS.some((r) => underRoot(path, r))) && path.split("/").slice(0, -1).includes("RAW");
}

function errorMarkerPath(rawFilePath) {
  const dir = rawFilePath.slice(0, rawFilePath.lastIndexOf("/"));
  return `${dir}/.${stemName(stemOf(rawFilePath.slice(rawFilePath.lastIndexOf("/") + 1)))}.mineru-error.txt`;
}

function toWikilinks(markdown) {
  return markdown.replace(/!\[[^\]]*\]\(images\/([^)]+)\)/g, "![[$1]]");
}

function readFrontmatterField(text, key) {
  const m = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*"?([^"\\n]*?)"?\\s*$`, "m").exec(text);
  return m && m[1] ? m[1] : null;
}

// Stems i NFC, så både MD-link (X.md) og RAW-link (X.pdf, #241) tæller som at nævne materialet.
function materialerLinks(text) {
  const block = AUTO_MATERIALER_RE.exec(text);
  return block ? [...block[1].matchAll(/\[\[([^|\]]+)/g)].map((m) => stemOf(m[1].split("/").pop()).normalize("NFC")) : null;
}

// notes: [{ name, text }] for ugemappens [PLAN]-noter, sorteret efter navn.
function planNoteFor(notes, mdName) {
  if (mdName && notes.length > 1) {
    const owner = notes.find((n) => materialerLinks(n.text)?.includes(stemOf(mdName).normalize("NFC")));
    if (owner) return owner;
  }
  return notes[0];
}

function provenPlanId(notes, mdName) {
  const owner = notes.find((n) => materialerLinks(n.text)?.includes(stemOf(mdName).normalize("NFC")));
  return owner ? readFrontmatterField(owner.text, "plan_id") : null;
}

function owningPlanId(notes, mdName) {
  return notes.length ? readFrontmatterField(planNoteFor(notes, mdName).text, "plan_id") : null;
}

// Ren del af watcherens frontmatter(): planNotes er MD-ugemappens [PLAN]-noter, hentet = formatNow().
function materialeFrontmatter(rawFilePath, planNotes, fetched, extra = "") {
  const t = mdTargets(rawFilePath);
  const parts = rawFilePath.split("/");
  const folder = parts[parts.length - 2] ?? "";
  const folderEmne = folder.includes(" - ") ? folder.slice(folder.indexOf(" - ") + 3) : "";
  const fields = {};
  if (planNotes.length) {
    const text = planNoteFor(planNotes, `${stemName(stemOf(parts[parts.length - 1]))}.md`).text;
    for (const key of ["topic", "start", "stop"]) {
      const value = readFrontmatterField(text, key);
      if (value) fields[key] = value;
    }
  }
  const noFolderMeta = folder === "RAW" || /^(\d{4}-\d{2}-\d{2}|W\d{1,2}[a-zæøå]+)$/i.test(folder);
  const topic = fields.topic || folderEmne || (noFolderMeta ? "" : folder);

  const outside = EXTRA_FOLDERS.some((r) => underRoot(rawFilePath, r)) && !underRoot(rawFilePath, FAG_ROOT) && !underRoot(rawFilePath, OPGAVER_ROOT);
  const lines = [outside ? `folder: "${t.fagFolder}"\n` : `course: ${t.fagFolder}\n`];
  lines.push("type: material\n", `source: "[[${rawFilePath}]]"\n`, `fetched: "${fetched}"\n`);
  if (topic) lines.push(`topic: "${topic}"\n`);
  for (const key of ["start", "stop"]) if (key in fields) lines.push(`${key}: "${fields[key]}"\n`);
  return "---\n" + lines.join("") + extra + "---\n\n";
}

// Bevar `lesson:` og `used_in:` ved genkonvertering (#186, #148).
function carriedFields(previousText) {
  if (previousText == null) return "";
  const fm = previousText.startsWith("---") ? previousText.split("---")[1] ?? "" : "";
  let out = "";
  const lesson = readFrontmatterField(fm, "lesson");
  if (lesson) out += `lesson: "${lesson}"\n`;
  const usedIn = /^used_in:[ \t]*\n(?:[ \t]+-[^\n]*\n?)+/m.exec(fm);
  if (usedIn) out += usedIn[0].endsWith("\n") ? usedIn[0] : usedIn[0] + "\n";
  return out;
}

// Returnerer den nye tekst, eller null når plan_id allerede står der / er notens egen lektion.
function appendUsedIn(text, planId) {
  const m = /^(---\n[\s\S]*?\n)(---\n)([\s\S]*)$/.exec(text);
  if (!m) return null;
  let [, fm, close, body] = m;
  const entry = `  - "${planId}"\n`;
  if (fm.includes(entry) || readFrontmatterField(fm, "lesson") === planId) return null;
  fm = /^used_in:[ \t]*$/m.test(fm) ? fm.replace(/^(used_in:[ \t]*\n)/m, `$1${entry}`) : fm + `used_in:\n${entry}`;
  return fm + close + body;
}

// ── Sidemarkører, fodnoter og løbende sidehoved fra content_list.json (#98, #101, #103, #142) ──

const isDigits = (s) => /^[0-9]+$/.test(s);
const blockText = (b) => (b.text ?? "").trim();

function groupBlocksByPage(blocks) {
  const pages = new Map();
  for (const b of blocks) {
    if (b.page_idx == null) continue;
    if (!pages.has(b.page_idx)) pages.set(b.page_idx, []);
    pages.get(b.page_idx).push(b);
  }
  return pages;
}

function printedPageNumber(pageBlocks) {
  const numbers = [];
  const other = [];
  for (const b of pageBlocks) {
    if (b.type !== "page_number") continue;
    const text = blockText(b);
    if (!text) continue;
    if (isDigits(text)) numbers.push(Number(text));
    else other.push(text);
  }
  if (numbers.length) {
    const sorted = [...new Set(numbers)].sort((a, b) => a - b);
    return sorted.length > 1 ? `${sorted[0]}–${sorted[sorted.length - 1]}` : String(sorted[0]);
  }
  return other[0] ?? null;
}

function pageFootnotes(pageBlocks) {
  return pageBlocks.filter((b) => b.type === "page_footnote" && blockText(b)).map(blockText);
}

function bisectBlocks(pageBlocks, coordIndex, mid) {
  const halves = [[], []];
  for (const b of pageBlocks) halves[(b.bbox ? b.bbox[coordIndex] : 0) < mid ? 0 : 1].push(b);
  return halves;
}

// ponytail: kan formentlig slettes når PDFable splitter opslag før upload — måles i #241 trin 4.
function splitDoublePage(pageBlocks, pageSize) {
  const pageNums = (blocks) => new Set(blocks.filter((b) => b.type === "page_number" && isDigits(blockText(b))).map((b) => Number(blockText(b))));
  if (pageNums(pageBlocks).size !== 2) return null;
  for (const [coordIndex, dimension] of [[0, pageSize[0]], [1, pageSize[1]]]) {
    const halves = bisectBlocks(pageBlocks, coordIndex, dimension / 2);
    if (!halves[0].length || !halves[1].length) continue;
    const [a, b] = halves.map(pageNums);
    if (a.size && b.size && ![...a].some((n) => b.has(n))) return halves;
  }
  return null;
}

function pageSizes(layout) {
  const sizes = new Map();
  for (const page of layout?.pdf_info ?? []) if ("page_size" in page) sizes.set(page.page_idx, page.page_size);
  return sizes;
}

function runningHeader(blocks) {
  const texts = blocks.filter((b) => (b.type === "header" || b.type === "footer") && blockText(b)).map(blockText);
  if (!texts.length) return null;
  const counts = new Map();
  for (const t of texts) counts.set(t, (counts.get(t) ?? 0) + 1);
  let best = null;
  for (const [t, n] of counts) if (best == null || n > counts.get(best)) best = t;
  return counts.get(best) >= texts.length / 2 ? best : null;
}

function firstAnchorText(pageBlocks) {
  const skip = new Set(["page_number", "header", "footer", "aside_text"]);
  for (const b of pageBlocks) {
    if (skip.has(b.type)) continue;
    const text = blockText(b);
    if (text) return [...text].slice(0, ANCHOR_LENGTH).join("");
  }
  return null;
}

function formatPageMarker(label, footnotes, trailingRule = true) {
  const trailer = trailingRule ? "\n\n---\n\n" : "\n";
  return footnotes.length
    ? `\n\n---\n${footnotes.join("\n\n")}\n\n*— side ${label} —*${trailer}`
    : `\n\n*— side ${label} —*${trailer}`;
}

// pageOffset: bid nr. i × 100 sider (#211), så sidemarkøren uden trykt sidetal viser PDF-siden.
function insertPageMarkers(fullMd, blocks, layout, pageOffset = 0) {
  const sizes = pageSizes(layout);
  const pages = groupBlocksByPage(blocks);
  let result = fullMd;
  let searchPos = 0;
  let pendingLabel = null;
  let pendingFootnotes = [];
  for (const pageIdx of [...pages.keys()].sort((a, b) => a - b)) {
    const pageBlocks = pages.get(pageIdx);
    const size = sizes.get(pageIdx);
    const groups = (size ? splitDoublePage(pageBlocks, size) : null) ?? [pageBlocks];
    for (const group of groups) {
      const anchor = firstAnchorText(group);
      if (!anchor) continue;
      let idx = result.indexOf(anchor, searchPos);
      if (idx === -1) continue;
      const lineStart = result.lastIndexOf("\n", idx - 1) + 1;
      if (pendingLabel != null) {
        const marker = formatPageMarker(pendingLabel, pendingFootnotes);
        result = result.slice(0, lineStart) + marker + result.slice(lineStart);
        idx += marker.length;
      }
      pendingLabel = printedPageNumber(group) ?? String(pageIdx + 1 + pageOffset);
      pendingFootnotes = pageFootnotes(group);
      searchPos = idx + anchor.length;
    }
  }
  if (pendingLabel != null) result = result.replace(/\n+$/, "") + formatPageMarker(pendingLabel, pendingFootnotes, false);
  return result;
}

// Zip-indhold → { body, sektion }: det watcherens write_conversion() skriver under frontmatteren.
function conversionBody(entries, pageOffset = 0) {
  if (!entries.has("full.md")) throw new MineruError("The MinerU zip is missing full.md");
  let md = entries.get("full.md").toString("utf8");
  let sektion = null;
  const contentListName = [...entries.keys()].find((n) => !n.includes("/") && n.endsWith("_content_list.json"));
  if (contentListName) {
    let blocks = null;
    try { blocks = JSON.parse(entries.get(contentListName).toString("utf8")); } catch {}
    if (blocks) {
      let layout = null;
      try { layout = entries.has("layout.json") ? JSON.parse(entries.get("layout.json").toString("utf8")) : null; } catch {}
      md = insertPageMarkers(md, blocks, layout, pageOffset);
      sektion = runningHeader(blocks);
    }
  }
  return { body: toWikilinks(md), sektion };
}

// Bidder fra en opdelt PDF (#211) sættes sammen i sideorden. ponytail: sektion: tages fra første
// bid; et løbende sidehoved der kun dominerer senere bidder bliver ikke fundet.
function joinedBody(parts) {
  const bodies = parts.map((entries, i) => conversionBody(entries, i * MINERU_CHUNK_PAGES));
  return { body: bodies.map((b) => b.body).join("\n\n"), sektion: bodies[0].sektion };
}

// MinerU-zips bruger kun stored/deflate (målt på cachen 2026-10-12), så Nodes zlib rækker.
// ponytail: ingen zip64; tilføjes hvis en zip nogensinde passerer 4 GB.
function unzip(arrayBuffer) {
  const zlib = require("zlib");
  const buf = Buffer.from(arrayBuffer);
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("invalid zip (no end-of-central-directory)");
  const entries = new Map();
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = buf.readUInt16LE(eocd + 10); i > 0; i--) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const local = buf.readUInt32LE(p + 42);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    if (!name.endsWith("/")) {
      if (method === 0) entries.set(name, data);
      else if (method === 8) entries.set(name, zlib.inflateRawSync(data));
      else throw new Error(`zip method ${method} is not supported (${name})`);
    }
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return entries;
}

// #286: .docx and .pptx are zips of XML, so their text is read straight from the file: no OCR, no MinerU.
// ponytail: regex over the XML, not a parser (no DOM in the test runner). Covers headings, lists, bold/italic, links, tables,
// pictures and speaker notes; text boxes inside groups come out in document order. Nested tables are flattened.
const xmlText = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

function relsOf(entries, partPath) {
  const dir = partPath.slice(0, partPath.lastIndexOf("/") + 1);
  const rels = entries.get(`${dir}_rels/${partPath.slice(dir.length)}.rels`);
  const map = new Map();
  if (!rels) return map;
  for (const m of rels.toString("utf8").matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]*)"/.exec(m[0])?.[1];
    const target = /\bTarget="([^"]*)"/.exec(m[0])?.[1];
    if (!id || !target) continue;
    const external = /TargetMode="External"/.test(m[0]);
    const parts = (external || target.startsWith("/") ? target.replace(/^\//, "") : dir + target).split("/");
    const out = [];
    for (const seg of external ? [target] : parts) { if (seg === "..") out.pop(); else if (seg !== ".") out.push(seg); }
    map.set(id, external ? target : out.join("/"));
  }
  return map;
}

function officeToMarkdown(ext, entries, stem) {
  const images = [];
  const seen = new Map();
  const pictureLink = (partPath) => {
    const data = entries.get(partPath);
    if (!data) return "";
    if (!seen.has(partPath)) {
      const e = partPath.slice(partPath.lastIndexOf(".") + 1).toLowerCase();
      const name = `${stem}-${images.length + 1}.${e}`;
      images.push([name, data.buffer.slice(data.byteOffset, data.byteOffset + data.length)]);
      seen.set(partPath, name);
    }
    return `![[${seen.get(partPath)}]]`;
  };
  const body = ext === ".docx" ? docxMarkdown(entries, pictureLink) : ext === ".pptx" ? pptxMarkdown(entries, pictureLink) : null;
  if (body == null) throw new Error(`office-text does not handle ${ext}`);
  return { body, images };
}

function docxMarkdown(entries, pictureLink) {
  const doc = entries.get("word/document.xml");
  if (!doc) throw new Error("docx without word/document.xml");
  const rels = relsOf(entries, "word/document.xml");
  const xml = doc.toString("utf8");
  const paragraph = (p) => {
    let out = "";
    let link = null;
    for (const t of p.matchAll(/<w:hyperlink\b([^>]*)>|<\/w:hyperlink>|<w:r[ >][\s\S]*?<\/w:r>/g)) {
      if (t[0].startsWith("<w:hyperlink")) { link = rels.get(/r:id="([^"]*)"/.exec(t[1])?.[1]) ?? null; continue; }
      if (t[0] === "</w:hyperlink>") { link = null; continue; }
      const r = t[0];
      let text = "";
      for (const x of r.matchAll(/<w:t\b[^>]*>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>|<a:blip\b[^>]*r:embed="([^"]*)"/g)) {
        if (x[0].startsWith("<w:t ") || x[0].startsWith("<w:t>")) text += xmlText(x[1]);
        else if (x[0] === "<w:tab/>") text += " ";
        else if (x[0] === "<w:br/>") text += "\n";
        else { const img = rels.get(x[2]); if (img) out += pictureLink(img); }
      }
      if (!text.trim()) { out += text; continue; }
      const rpr = /<w:rPr>[\s\S]*?<\/w:rPr>/.exec(r)?.[0] ?? "";
      const mark = (/<w:b\/>|<w:b w:val="(1|true)"\/>/.test(rpr) ? "**" : "") + (/<w:i\/>|<w:i w:val="(1|true)"\/>/.test(rpr) ? "*" : "");
      const lead = /^\s*/.exec(text)[0], trail = /\s*$/.exec(text)[0];
      const core = text.trim();
      const wrapped = mark ? `${mark}${core}${[...mark].reverse().join("")}` : core;
      out += lead + (link ? `[${wrapped}](${link})` : wrapped) + trail;
    }
    return out.trim();
  };
  const blocks = [];
  for (const m of xml.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p[ >][\s\S]*?<\/w:p>/g)) {
    if (m[0].startsWith("<w:tbl>")) {
      const rows = [...m[0].matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)].map((tr) =>
        [...tr[0].matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map((tc) =>
          [...tc[0].matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((p) => paragraph(p[0])).filter(Boolean).join(" ").replace(/\|/g, "\\|")));
      if (rows.length) {
        const width = Math.max(...rows.map((r) => r.length));
        const line = (r) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
        blocks.push([line(rows[0]), line(Array(width).fill("---")), ...rows.slice(1).map(line)].join("\n"));
      }
      continue;
    }
    const text = paragraph(m[0]);
    if (!text) continue;
    const style = /<w:pStyle w:val="([^"]*)"/.exec(m[0])?.[1] ?? "";
    const heading = /^(?:Heading|Overskrift)\s*(\d)$/i.exec(style) ?? (/^Title$/i.test(style) ? [0, 1] : null);
    if (heading) { blocks.push(`${"#".repeat(Math.min(6, +heading[1]))} ${text.replace(/\*+/g, "")}`); continue; }
    if (m[0].includes("<w:numPr>")) {
      const lvl = +(/<w:ilvl w:val="(\d+)"/.exec(m[0])?.[1] ?? 0);
      blocks.push(`${"  ".repeat(lvl)}- ${text}`);
      continue;
    }
    blocks.push(text);
  }
  // consecutive list items stay in one block
  return blocks.reduce((acc, b, i) => acc + (i && /^\s*- /.test(b) && /^\s*- /.test(blocks[i - 1]) ? "\n" : i ? "\n\n" : "") + b, "") + "\n";
}

function pptxMarkdown(entries, pictureLink) {
  const order = [];
  const pres = entries.get("ppt/presentation.xml");
  if (pres) {
    const rels = relsOf(entries, "ppt/presentation.xml");
    for (const m of pres.toString("utf8").matchAll(/<p:sldId\b[^>]*r:id="([^"]*)"/g)) if (rels.has(m[1])) order.push(rels.get(m[1]));
  }
  if (!order.length) {
    order.push(...[...entries.keys()].filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => parseInt(a.match(/(\d+)\.xml$/)[1]) - parseInt(b.match(/(\d+)\.xml$/)[1])));
  }
  const paragraphs = (xml) => [...xml.matchAll(/<a:p>[\s\S]*?<\/a:p>|<a:p [\s\S]*?<\/a:p>/g)].map((p) => ({
    lvl: +(/<a:pPr\b[^>]*\blvl="(\d+)"/.exec(p[0])?.[1] ?? 0),
    text: [...p[0].matchAll(/<a:t>([^<]*)<\/a:t>|<a:br\/>/g)].map((t) => (t[0] === "<a:br/>" ? " " : xmlText(t[1]))).join("").trim(),
  })).filter((p) => p.text);
  const slides = [];
  order.forEach((slidePath, n) => {
    const slide = entries.get(slidePath);
    if (!slide) return;
    const rels = relsOf(entries, slidePath);
    const xml = slide.toString("utf8");
    let title = "";
    const parts = [];
    for (const m of xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>|<p:pic>[\s\S]*?<\/p:pic>|<p:graphicFrame>[\s\S]*?<\/p:graphicFrame>/g)) {
      const s = m[0];
      if (s.startsWith("<p:pic>")) { const img = rels.get(/r:embed="([^"]*)"/.exec(s)?.[1]); if (img) parts.push(pictureLink(img)); continue; }
      if (s.startsWith("<p:graphicFrame>")) {
        const rows = [...s.matchAll(/<a:tr\b[\s\S]*?<\/a:tr>/g)].map((tr) =>
          [...tr[0].matchAll(/<a:tc\b[\s\S]*?<\/a:tc>/g)].map((tc) => paragraphs(tc[0]).map((p) => p.text).join(" ").replace(/\|/g, "\\|")));
        if (rows.length) {
          const width = Math.max(...rows.map((r) => r.length));
          const line = (r) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
          parts.push([line(rows[0]), line(Array(width).fill("---")), ...rows.slice(1).map(line)].join("\n"));
        }
        continue;
      }
      const ps = paragraphs(s);
      if (!ps.length) continue;
      if (/<p:ph\b[^>]*type="(?:title|ctrTitle)"/.test(s)) { title = ps.map((p) => p.text).join(" "); continue; }
      if (/<p:ph\b[^>]*type="(?:sldNum|dt|ftr)"/.test(s)) continue;
      parts.push(ps.map((p) => `${"  ".repeat(p.lvl)}- ${p.text}`).join("\n"));
    }
    let notes = "";
    const notesPath = [...rels.values()].find((t) => /^ppt\/notesSlides\//.test(t));
    if (notesPath && entries.has(notesPath)) {
      const nx = entries.get(notesPath).toString("utf8");
      const sp = [...nx.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].map((m) => m[0]).find((x) => /<p:ph\b[^>]*type="body"/.test(x));
      if (sp) notes = paragraphs(sp).map((p) => `> ${p.text}`).join("\n");
    }
    slides.push([`## Slide ${n + 1}${title ? `: ${title}` : ""}`, ...parts, ...(notes ? [`> **Notes**\n${notes}`] : [])].join("\n\n"));
  });
  return slides.join("\n\n") + "\n";
}

// ── MinerU-API og cache ──

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`timeout after ${ms / 1000}s: ${what}`)), ms)))])
    .finally(() => clearTimeout(timer));
}

async function mineruRequest(token, method, path, body) {
  const res = await withTimeout(
    requestUrl({ url: `${MINERU_API}${path}`, method, headers: { Authorization: `Bearer ${token}` }, contentType: "application/json", body: body && JSON.stringify(body), throw: false }),
    30e3, path
  );
  if (res.status >= 400) throw new Error(`MinerU HTTP ${res.status} on ${path}`);
  return res.json;
}

// 200 = gyldig nøgle (svaret er "task not found"), 401 = ugyldig. Målt 2026-10-12.
async function testMineruToken(token) {
  const res = await requestUrl({ url: `${MINERU_API}/extract-results/batch/00000000-0000-0000-0000-000000000000`, headers: { Authorization: `Bearer ${token}` }, throw: false });
  return res.status === 200;
}

// MinerU afviser PDF'er over 200 sider (#211). Sidetallet tælles på de bytes der uploades (efter
// PDFable, som kan fordoble det ved at splitte opslag), og en lang PDF sendes som flere filer med
// hver sin page_ranges. ponytail: regex på "/Type /Page" tæller ikke sider i komprimerede object
// streams; så findes 0, filen sendes hel, og MinerU's egen afvisning markerer den som før.
const MINERU_MAX_PAGES = 200;
const MINERU_CHUNK_PAGES = 100;

function pdfPageCount(bytes) {
  return (Buffer.from(bytes).toString("latin1").match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
}

function pageRanges(pages) {
  if (pages <= MINERU_MAX_PAGES) return null;
  const ranges = [];
  for (let first = 1; first <= pages; first += MINERU_CHUNK_PAGES) ranges.push(`${first}-${Math.min(first + MINERU_CHUNK_PAGES - 1, pages)}`);
  return ranges;
}

// Returnerer én zip pr. bid, i sideorden.
async function mineruConvert(token, fileName, dataId, bytes) {
  const ranges = fileName.toLowerCase().endsWith(".pdf") ? pageRanges(pdfPageCount(bytes)) : null;
  const files = ranges
    ? ranges.map((r, i) => ({ name: fileName, data_id: `${dataId.slice(0, 120)}-${i + 1}`, page_ranges: r }))
    : [{ name: fileName, data_id: dataId }];
  if (ranges) console.log(`ItsWiz: ${fileName} sendes i ${ranges.length} bidder (${ranges.join(", ")})`);
  const resp = await mineruRequest(token, "POST", "/file-urls/batch", { files, model_version: "vlm" });
  if (resp.code !== 0) throw new MineruError(`file-urls/batch failed: ${JSON.stringify(resp)}`);
  const { batch_id: batchId, file_urls: uploadUrls } = resp.data;

  for (const uploadUrl of uploadUrls) {
    for (let attempt = 1; ; attempt++) {
      try {
        const put = await withTimeout(requestUrl({ url: uploadUrl, method: "PUT", body: bytes, throw: false }), UPLOAD_TIMEOUT_MS, "upload");
        if (put.status >= 400) throw new Error(`upload HTTP ${put.status}`);
        break;
      } catch (err) {
        if (attempt === UPLOAD_RETRIES) throw err;
        console.warn(`ItsWiz: upload-forsøg ${attempt}/${UPLOAD_RETRIES} for ${fileName} fejlede (${err.message}) — prøver igen om ${UPLOAD_RETRY_BACKOFF_MS / 1000}s`);
        await sleep(UPLOAD_RETRY_BACKOFF_MS);
      }
    }
  }

  const deadline = Date.now() + POLL_TIMEOUT_MS * files.length;
  while (Date.now() < deadline) {
    const results = (await mineruRequest(token, "GET", `/extract-results/batch/${batchId}`)).data.extract_result;
    const failed = results.find((r) => r.state === "failed");
    if (failed) throw new MineruError(`MinerU error: ${failed.err_msg}`);
    if (results.length === files.length && results.every((r) => r.state === "done")) {
      const byId = new Map(results.map((r) => [r.data_id, r]));
      const zips = [];
      for (const f of files) {
        const zip = await withTimeout(requestUrl({ url: (byId.get(f.data_id) ?? results[zips.length]).full_zip_url, throw: false }), 120e3, "zip-download");
        if (zip.status >= 400) throw new Error(`zip-download HTTP ${zip.status}`);
        zips.push(zip.arrayBuffer);
      }
      return zips;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`timeout after ${(POLL_TIMEOUT_MS * files.length) / 1000}s`);
}

// Samme mappe som watcheren, så dens zips genbruges (#99). Fejer forældede filer ved skrivning.
function cacheDir() {
  return require("path").join(require("os").homedir(), ".viastudywiz-cache");
}

// Én zip: <digest>.zip (watcherens format). Flere bidder: <digest>.p1.zip, .p2.zip …
function cachedZips(digest) {
  const fs = require("fs");
  const path = require("path");
  const names = [`${digest}.zip`];
  if (!fs.existsSync(path.join(cacheDir(), names[0]))) {
    names.length = 0;
    for (let i = 1; fs.existsSync(path.join(cacheDir(), `${digest}.p${i}.zip`)); i++) names.push(`${digest}.p${i}.zip`);
  }
  try {
    const files = names.map((n) => path.join(cacheDir(), n));
    if (!files.length) return null;
    if (files.some((f) => Date.now() - fs.statSync(f).mtimeMs > CACHE_TTL_MS)) return files.forEach((f) => fs.unlinkSync(f)), null;
    return files.map((f) => {
      const b = fs.readFileSync(f);
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
    });
  } catch {
    return null;
  }
}

function writeCache(digest, zips) {
  const fs = require("fs");
  const path = require("path");
  const dir = cacheDir();
  fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(dir)) {
    const f = path.join(dir, name);
    if (name.endsWith(".zip") && Date.now() - fs.statSync(f).mtimeMs > CACHE_TTL_MS) fs.unlinkSync(f);
  }
  zips.forEach((zip, i) => fs.writeFileSync(path.join(dir, zips.length === 1 ? `${digest}.zip` : `${digest}.p${i + 1}.zip`), Buffer.from(zip)));
}

const sha256 = (arrayBuffer) => require("crypto").createHash("sha256").update(Buffer.from(arrayBuffer)).digest("hex");

// ── PDFable før MinerU (#241 trin 3; kontrakten ligger i FasterMadman/PDFable#111) ──
//
// Retter skæve, liggende og dobbeltside-scans, som MinerU ellers læser i forkert rækkefølge (#211).
// Valgfrit som MinerU: uden programsti uploades originalen. Stien er pr. enhed (localStorage).

const PDFABLE_PATH_KEY = "itswiz-pdfable-path";
const PDFABLE_FLAGS = ["--rotate", "--crop", "--split", "auto", "--deskew"];
const PDFABLE_TIMEOUT_MS = 5 * 60e3;
const pdfablePath = () => plugin.app.loadLocalStorage(PDFABLE_PATH_KEY) ?? "";

// #275: pass 2 uses the same flags as pass 1 on the ORIGINAL, plus one --mineru per layout.json
// (in page order), so MinerU's boxes fit the output pages of pass 1 directly.
function pdfableArgs(layoutPaths, input, output) {
  return [...PDFABLE_FLAGS, ...layoutPaths.flatMap((p) => ["--mineru", p]), input, output];
}

// PDFable reports a layout.json that does not fit (page count or size) on stderr with exit 0 and an
// output without text or figures; that output is not worth keeping.
function hasMineruWarning(stderr) {
  return /^Warning: --mineru/m.test(stderr);
}

// Pass 1 (no layouts): the 1-bit PDF uploaded to MinerU. Pass 2 (layouts: layout.json contents):
// the reading copy with MinerU's text and colour figures. Returns the PDF bytes, or null (no path, not
// a PDF, no file written, failure), after which the original is used. The original in RAW is never
// touched; the work happens in a temp folder.
async function pdfable(file, bytes, layouts = []) {
  const bin = pdfablePath();
  if (!bin || file.extension.toLowerCase() !== "pdf") return null;
  const fs = require("fs");
  const path = require("path");
  const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "itswiz-pdfable-"));
  const input = path.join(dir, "in.pdf");
  const output = path.join(dir, "out.pdf");
  try {
    fs.writeFileSync(input, Buffer.from(bytes));
    const layoutPaths = layouts.map((layout, i) => {
      const p = path.join(dir, `layout-${i + 1}.json`);
      fs.writeFileSync(p, layout);
      return p;
    });
    const { code, stderr } = await new Promise((resolve) =>
      require("child_process").execFile(bin, pdfableArgs(layoutPaths, input, output), { timeout: PDFABLE_TIMEOUT_MS },
        (err, _stdout, stderr) => resolve({ code: err ? err.code ?? -1 : 0, stderr: String(stderr).trim() })));
    // Exit 2: PDF'en er skrevet, men nogle opslag blev ikke splittet. Uploades alligevel.
    if (code === 2) console.warn(`ItsWiz: PDFable usikker på sider i ${file.name}: ${stderr.split("\n").pop()}`);
    else if (code !== 0) {
      console.warn(`ItsWiz: PDFable fejlede på ${file.name} (exit ${code}), bruger originalen: ${stderr}`);
      return null;
    }
    if (hasMineruWarning(stderr)) {
      console.warn(`ItsWiz: PDFable kunne ikke bruge MinerUs layout for ${file.name}, bruger originalen: ${stderr}`);
      return null;
    }
    if (!fs.existsSync(output)) return null;
    const b = fs.readFileSync(output);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// #281: `pdfable --classify` prints one letter per page, D (digital: visible text) or S (scan). A file is digital when
// more than half of its pages are, so a cover page without text does not turn a digital PDF into a scan. Ties and
// scan-heavy files take the scan path.
// ponytail: a mixed file is judged as a whole, because PDFable turns every page into an image or none; per-page
// pass-through would need PDFable to copy the digital pages as they are.
function isDigitalPdf(letters) {
  const pages = [...String(letters).trim()];
  return pages.length > 0 && pages.filter((c) => c === "D").length * 2 > pages.length;
}

// #283: `pdfable --text` writes the note from a digital PDF's own text layer. stderr carries one tab-separated row per
// page: page label kind glyphs unmapped rotated tables image_share (PDFable docs/text-extraction.md).
const TEXT_MAX_IMAGE_SHARE = 0.15;
const TEXT_MAX_UNMAPPED = 0.01;

function parseTextReport(stderr) {
  return String(stderr).split("\n").map((l) => l.split("\t")).filter((c) => c.length >= 8 && /^\d+$/.test(c[0]))
    .map((c) => ({ page: +c[0], label: c[1], kind: c[2], glyphs: +c[3], unmapped: +c[4], imageShare: +c[7] }));
}

// letters: the `--classify` output. Only a file that is digital on every page, has no page where a picture may hold
// text (image_share), and has almost no glyphs without a Unicode mapping, takes the text route; MinerU gets the rest.
// ponytail: image_share misses some screenshots (madariaga), which is why the setting is off by default.
function textRouteOk(letters, report) {
  const pages = [...String(letters).trim()];
  if (!pages.length || pages.some((c) => c !== "D") || report.length !== pages.length) return false;
  const glyphs = report.reduce((n, r) => n + r.glyphs, 0);
  const unmapped = report.reduce((n, r) => n + r.unmapped, 0);
  return glyphs > 0 && unmapped / glyphs < TEXT_MAX_UNMAPPED && report.every((r) => r.kind === "digital" && r.imageShare < TEXT_MAX_IMAGE_SHARE);
}

// {body, images: [[name, ArrayBuffer]]} or null: no PDFable path, not a PDF, an older PDFable without --text, a file the rule sends to MinerU,
// or any failure (then MinerU as before).
async function pdfableText(file, bytes) {
  const bin = pdfablePath();
  if (!bin || file.extension.toLowerCase() !== "pdf") return null;
  const fs = require("fs");
  const path = require("path");
  const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "itswiz-pdfable-"));
  // The picture files are named after the input, and the note links them by that name: it must be the document's own name.
  const input = path.join(dir, file.name);
  const figures = path.join(dir, "figures");
  const run = (args) => new Promise((resolve) =>
    require("child_process").execFile(bin, args, { timeout: PDFABLE_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) })));
  try {
    fs.writeFileSync(input, Buffer.from(bytes));
    const classify = await run(["--classify", input]);
    if (!classify.ok) return null;
    const text = await run(["--text", "--figures", figures, input]);
    if (!text.ok || !textRouteOk(classify.stdout, parseTextReport(text.stderr)) || !text.stdout.trim()) return null;
    const images = fs.existsSync(figures)
      ? fs.readdirSync(figures).sort().map((n) => { const b = fs.readFileSync(path.join(figures, n)); return [n, b.buffer.slice(b.byteOffset, b.byteOffset + b.length)]; })
      : [];
    return { body: text.stdout, images };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// true only when PDFable ran and called the file digital. No path, not a PDF, an older PDFable without --classify
// (exit 1) or any failure: false, so the file takes the scan path as before.
async function pdfableDigital(file, bytes) {
  const bin = pdfablePath();
  if (!bin || file.extension.toLowerCase() !== "pdf") return false;
  const fs = require("fs");
  const path = require("path");
  const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "itswiz-pdfable-"));
  const input = path.join(dir, "in.pdf");
  try {
    fs.writeFileSync(input, Buffer.from(bytes));
    const { code, stdout } = await new Promise((resolve) =>
      require("child_process").execFile(bin, ["--classify", input], { timeout: PDFABLE_TIMEOUT_MS },
        (err, stdout) => resolve({ code: err ? err.code ?? -1 : 0, stdout: String(stdout) })));
    return code === 0 && isDigitalPdf(stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// layout.json of every zip in page order, or null when one is missing (then pass 2 cannot be trusted).
function layoutsOf(parts) {
  const layouts = parts.map((entries) => entries.get("layout.json"));
  return layouts.every(Boolean) ? layouts : null;
}

// ── Vault-siden ──

async function planNotesIn(mdDir) {
  const folder = plugin.app.vault.getAbstractFileByPath(normalizePath(mdDir));
  if (!(folder instanceof TFolder)) return [];
  const files = folder.children.filter((f) => f instanceof TFile && f.extension === "md" && f.name.startsWith("[PLAN] "));
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return Promise.all(files.map(async (f) => ({ name: f.name, text: await plugin.app.vault.read(f) })));
}

// Byte-dublet i samme RAW-gren, hvis MD-note er en ægte `type: material` (#136/#148).
async function existingConversion(file, bytes, digest) {
  const { rawRoot } = mdTargets(file.path);
  const suffix = file.name.slice(file.name.lastIndexOf("."));
  const others = plugin.app.vault.getFiles()
    .filter((f) => f.path.startsWith(`${rawRoot}/`) && f.name.endsWith(suffix) && f.path !== file.path && f.stat.size === bytes.byteLength)
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  for (const other of others) {
    if (sha256(await plugin.app.vault.readBinary(other)) !== digest) continue;
    const otherMd = mdTargets(other.path).md;
    const text = await readFromVault(otherMd);
    if (text != null && readFrontmatterField(text, "type") === "material") return otherMd;
  }
  return null;
}

// parts: én zip-indholds-Map pr. bid (#211), i sideorden.
async function writeConversion(file, parts) {
  const { body, sektion } = joinedBody(parts);
  const images = parts.flatMap((entries) => [...entries].filter(([n]) => n.startsWith("images/")))
    .map(([n, data]) => [n.slice("images/".length), data.buffer.slice(data.byteOffset, data.byteOffset + data.length)]);
  await writeNote(file, { body, sektion, images, converter: null });
}

// #283: converter is null for MinerU (no field), "pdfable-text" for a note written from the PDF's text layer, so a later
// forced conversion can pick MinerU instead.
async function writeNote(file, { body, sektion, images, converter }) {
  const t = mdTargets(file.path);
  const previous = await readFromVault(t.md);
  // #42: skriv ved siden af, hvis den eksisterende note har highlights.
  const protect = previous != null && HIGHLIGHT_RE.test(previous);
  const destMd = protect ? t.md.replace(/\.md$/, ".ny.md") : t.md;
  const destImages = protect ? `${t.images}.ny` : t.images;

  const planNotes = await planNotesIn(t.mdDir);
  const mdName = t.md.slice(t.md.lastIndexOf("/") + 1);
  let carried = carriedFields(previous);
  const owner = carried.includes("lesson:") ? null : provenPlanId(planNotes, mdName);
  if (owner) carried = `lesson: "${owner}"\n` + carried;
  const extra = (sektion ? `section: "${sektion}"\n` : "") + (converter ? `converter: ${converter}\n` : "") + carried;
  await writeVaultFile(destMd, materialeFrontmatter(file.path, planNotes, formatNow(), extra) + body);

  if (images.length) {
    const { adapter } = plugin.app.vault;
    if (await adapter.exists(normalizePath(destImages))) await adapter.rmdir(normalizePath(destImages), true);
    for (const [n, data] of images) await writeVaultFile(`${destImages}/${n}`, data);
  }
  if (protect) console.log(`ItsWiz: highlights i ${mdName} — ny konvertering skrevet til ${destMd.slice(destMd.lastIndexOf("/") + 1)} (#42)`);
}

async function processDocument(file, { force = false } = {}) {
  const t = mdTargets(file.path);
  const marker = errorMarkerPath(file.path);
  if (!force && ((await existsInVault(t.md)) || (await plugin.app.vault.adapter.exists(normalizePath(marker))))) return;
  const bytes = await plugin.app.vault.readBinary(file);
  const digest = sha256(bytes);

  if (!force) {
    const originalMd = await existingConversion(file, bytes, digest);
    if (originalMd) {
      const planId = owningPlanId(await planNotesIn(t.mdDir), t.md.slice(t.md.lastIndexOf("/") + 1));
      const updated = planId && appendUsedIn(await readFromVault(originalMd), planId);
      if (updated) await writeVaultFile(originalMd, updated);
      console.log(`ItsWiz: dublet af ${originalMd} — ${updated ? `${planId} tilføjet dens used_in:` : "ingen ny used_in:"}`);
      return;
    }
  }

  try {
    // #275: _attachments/ holds one copy per converted file, never overwritten (annotations made on it
    // would be lost), so pass 1 is only needed on a cache hit when that file is still missing.
    const copyPath = copyTarget(file.path);
    const needCopy = !(await existsInVault(copyPath));
    // #283: a digital PDF the rule trusts is written from its text layer, without MinerU. A forced conversion of such a
    // note goes to MinerU, so the choice can be undone per file.
    const wasText = force && readFrontmatterField((await readFromVault(t.md)) ?? "", "converter") === "pdfable-text";
    const fromText = !wasText && (await getSettings()).pdfableText ? await pdfableText(file, bytes) : null;
    if (fromText != null) {
      await writeNote(file, { body: fromText.body, sektion: null, images: fromText.images, converter: "pdfable-text" });
      if (needCopy) await writeVaultFile(copyPath, bytes);
      if (await plugin.app.vault.adapter.exists(normalizePath(marker))) await plugin.app.vault.adapter.remove(normalizePath(marker));
      console.log(`ItsWiz: written from the PDF's text layer, no MinerU: ${file.name}`);
      return;
    }
    // #286: docx and pptx are read straight from the file. A file that cannot be read falls through to MinerU.
    const ext = `.${file.extension.toLowerCase()}`;
    if (ext === ".docx" || ext === ".pptx") {
      let office = null;
      try { office = officeToMarkdown(ext, unzip(bytes), stemName(stemOf(file.name))); } catch (err) { console.warn(`ItsWiz: ${file.name} could not be read directly (${err.message}), trying MinerU`); }
      if (office && office.body.trim()) {
        await writeNote(file, { body: office.body, sektion: null, images: office.images, converter: "office-text" });
        if (needCopy) await writeVaultFile(copyPath, bytes);
        if (await plugin.app.vault.adapter.exists(normalizePath(marker))) await plugin.app.vault.adapter.remove(normalizePath(marker));
        console.log(`ItsWiz: written from the ${ext.slice(1)} text, no MinerU: ${file.name}`);
        return;
      }
    }
    if (!mineruToken()) return;
    let zips = cachedZips(digest);
    // #281: a digital PDF keeps its own text: no 1-bit pass, the original goes to MinerU and is copied as it is.
    const digital = (!zips || needCopy) && await pdfableDigital(file, bytes);
    if (digital) console.log(`ItsWiz: digital PDF, left untouched: ${file.name}`);
    // null: no PDFable, digital, nothing to do on a cache hit, or PDFable failed or wrote no file (not smaller).
    const oneBit = digital || (zips && !needCopy) ? null : await pdfable(file, bytes);
    if (zips) console.log(`ItsWiz: cache-hit, springer MinerU over: ${file.name}`);
    else {
      console.log(`ItsWiz: uploader til MinerU: ${file.name}${oneBit ? ` (1-bit, ${oneBit.byteLength} B; original ${bytes.byteLength} B)` : ` (${bytes.byteLength} B)`}`);
      // #250: MinerU afviser data_id over 128 bytes.
      const dataId = Buffer.from(stemName(file.basename)).subarray(0, 128).toString("utf8").replace(/�+$/, "");
      zips = await mineruConvert(mineruToken(), file.name, dataId, oneBit ?? bytes);
      writeCache(digest, zips);
    }
    const parts = zips.map(unzip);
    await writeConversion(file, parts);
    if (needCopy) {
      // A scanned PDF gets pass 2 (text layer + colour figures); anything else (a digital PDF, docx, pptx, or
      // a failed pass 2) gets a plain copy of the original, so it can be read when RAW is not synced.
      const layouts = oneBit && layoutsOf(parts);
      const reading = layouts ? await pdfable(file, bytes, layouts) : null;
      await writeVaultFile(copyPath, reading ?? bytes);
      console.log(`ItsWiz: ${reading ? `læsekopi (${reading.byteLength} B)` : `kopi af originalen (${bytes.byteLength} B)`} skrevet til ${copyPath}`);
    }
    // En gammel fejlmarkør (fx fra før opdelingen, #211) må ikke stå tilbage, når MD'en findes.
    if (await plugin.app.vault.adapter.exists(normalizePath(marker))) await plugin.app.vault.adapter.remove(normalizePath(marker));
    console.log(`ItsWiz: færdig: ${file.name}`);
  } catch (err) {
    if (!(err instanceof MineruError)) {
      console.warn(`ItsWiz: forbigående fejl ved ${file.name} (prøves igen ved næste start): ${err.message}`);
      return;
    }
    console.error(`ItsWiz: fejl ved ${file.name}: ${err.message}`);
    await plugin.app.vault.adapter.write(normalizePath(marker), err.message);
  }
}

// Én fil ad gangen, som watcheren: MinerU-kø og upload-båndbredde deles alligevel.
let conversionQueue = Promise.resolve();
const queuedConversions = new Set();

function isConvertible(file) {
  return file instanceof TFile && inRawBranch(file.path) && CONVERT_SUFFIXES.includes(`.${file.extension.toLowerCase()}`);
}

async function queueConversion(file) {
  const { enableConversion, pdfableText: useText } = await getSettings();
  if (!enableConversion || !(mineruToken() || useText || /^(docx|pptx)$/i.test(file.extension)) || !isConvertible(file) || queuedConversions.has(file.path)) return;
  queuedConversions.add(file.path);
  conversionQueue = conversionQueue
    .then(() => processDocument(file))
    .catch((err) => console.error(`ItsWiz: konvertering af ${file.path} fejlede:`, err))
    .finally(() => queuedConversions.delete(file.path));
}

// Syncthing-konflikter blev løst af watcheren, den eneste proces der så hele vaulten. Scriptet
// ligger i vaulten selv og findes kun hos Valdemar; mangler det, sker intet.
function resolveSyncConflict(file) {
  const path = require("path");
  const base = plugin.app.vault.adapter.getBasePath();
  const script = path.join(base, ".scripts", "resolve_sync_conflict.py");
  if (!require("fs").existsSync(script)) return;
  require("child_process").execFile("python3", [script, path.join(base, file.path)], (err, stdout, stderr) => {
    if (stdout) console.log(stdout.trim());
    if (err || stderr) console.error(`ItsWiz: resolve_sync_conflict.py fejlede: ${stderr || err.message}`);
  });
}

async function onVaultCreate(file) {
  if (!(file instanceof TFile) || !(await getSettings()).enableConversion) return;
  // Lad Syncthing/downloadet skrive færdigt, som watcheren (2 s).
  await sleep(2000);
  if (file.name.includes("sync-conflict-")) return resolveSyncConflict(file);
  queueConversion(file);
}

function scanExisting() {
  const files = plugin.app.vault.getFiles().filter(isConvertible).sort((a, b) => (a.path < b.path ? -1 : 1));
  for (const f of files) queueConversion(f);
}

// ── Hold Course-synk (E, #242): port af watchfolder/sync_hold_course.py ──
//
// 1:1 port, så ItsWiz giver samme data.json som Python-synken (plugin/test/hcsync.test.js afspiller
// alle Python-selvtjekkets kald). Beslutningerne bag hver regel står i Python-filens kommentarer og
// i ValdiVault 14-hold-course-synk.md; de gentages ikke her. Ejerskabsreglen håndhæves også af Hold
// Course selv (hold-course#84: api.update() ruller felter tilbage, synken ikke ejer).
//
// I/O er skilt ud: patchPendingMateriale/readPlans/readTasks tager et `vault` ({ list, read, write }),
// mens syncData/syncTaskCompletion/pruneDeadLinks er synkrone, fordi Hold Course' update() kræver
// en synkron funktion — fil-opslag gives med som opslagsfunktioner bygget på forhånd.

const HC_KNOWN_DATA_VERSION = 2;
const HC_COLOR_PALETTE_SIZE = 6;
const HC_COURSE_URL = "https://via.itslearning.com/Course/Course.aspx?CourseId=";
const FORLOEB_HEADER = "> Generated file — do not edit; edit in Hold Course.";
const PREP_DAY_RE = /sat\s+af\s+til[^.\n]{0,60}forbere/i;

const nfc = (s) => s.normalize("NFC");
const dirOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const baseOf = (p) => p.slice(p.lastIndexOf("/") + 1);
const pathStem = (p) => { const b = baseOf(p); const i = b.lastIndexOf("."); return i > 0 ? b.slice(0, i) : b; };

// Python sammenligner strenge på kodepunkter, JS på UTF-16-enheder; forskellen viser sig kun ved
// tegn uden for BMP (emoji), men sorteringen skal give samme rækkefølge som Python.
function cmpStr(a, b) {
  if (a === b) return 0;
  const x = [...a], y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i].codePointAt(0) - y[i].codePointAt(0);
  }
  return x.length - y.length;
}
const cmpTuple = (a, b) => { for (let i = 0; i < a.length; i++) { const c = typeof a[i] === "number" ? a[i] - b[i] : cmpStr(a[i], b[i]); if (c) return c; } return 0; };
// sorted() på pathlib.Path: del for del, ikke hele strengen.
function cmpParts(a, b) {
  const x = a.split("/"), y = b.split("/");
  for (let i = 0; i < Math.min(x.length, y.length); i++) { const c = cmpStr(x[i], y[i]); if (c) return c; }
  return x.length - y.length;
}

function parseFrontmatter(text) {
  if (!text.startsWith("---\n")) return {};
  const end = text.indexOf("\n---\n", 3);
  if (end === -1) return {};
  const fields = {};
  let key = null, block = [];
  for (const line of text.slice(4, end).split("\n")) {
    if (key !== null && (line.startsWith("  ") || !line.trim())) {
      block.push(line.slice(2));
      continue;
    }
    if (key !== null) {
      fields[key] = block.join("\n").trim();
      key = null;
      block = [];
    }
    const m = /^([A-Za-z_][A-Za-z0-9_]*): ?(.*)$/.exec(line);
    if (!m) continue;
    if (m[2] === "|") key = m[1];
    else fields[m[1]] = m[2].trim().replace(/^"+|"+$/g, "");
  }
  if (key !== null) fields[key] = block.join("\n").trim();
  return fields;
}

// One entry per non-empty line of a block-scalar field (literature, preparation, *_files).
function fieldLines(value) {
  return value ? value.split("\n").map((l) => l.trim()).filter(Boolean) : [];
}

// [NOTE]-stubben hvis den findes, ellers selve planen. `exists` er et synkront opslag (se øverst).
function hcNoteStubPath(planPath, exists) {
  const m = /^(.*)\/MD\/([^/]+)\/\[PLAN\] (.+)\.md$/.exec(planPath);
  if (!m) return planPath;
  const stub = `${m[1]}/NOTER/${m[2]}/[NOTE] ${m[3]}.md`;
  return exists(stub) ? stub : planPath;
}

function wikilinkTarget(line) {
  const m = /^\[\[([^|\]]+)(?:\|.*)?\]\]$/.exec(line);
  return m ? m[1] : null;
}

const wikilinkFor = (rel) => `[[${rel}|${baseOf(rel)}]]`;

// Appends links to the `key: |` block, or creates the key just before the closing `---` when the
// field is absent (fields are only written when they have content, #271).
function appendFileListField(text, key, newLinks) {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === `${key}: |`) {
      let j = i + 1;
      while (j < lines.length && lines[j].startsWith("  ")) j++;
      return [...lines.slice(0, j), ...newLinks.map((l) => `  ${l}`), ...lines.slice(j)].join("\n");
    }
  }
  const close = lines.indexOf("---", 1);
  if (lines[0] !== "---" || close === -1) return text;
  return [...lines.slice(0, close), `${key}: |`, ...newLinks.map((l) => `  ${l}`), ...lines.slice(close)].join("\n");
}

function ownedTargets(text, fields) {
  const m = AUTO_MATERIALER_RE.exec(text);
  const owned = new Set(m ? [...m[1].matchAll(/\[\[([^|\]]+)/g)].map((x) => nfc(x[1])) : []);
  for (const l of fieldLines(fields.literature_files)) {
    const t = wikilinkTarget(l);
    if (t) owned.add(nfc(t));
  }
  return owned;
}

function isPrepDay(fields) {
  return !fields.preparation_text && PREP_DAY_RE.test(fields.description || "");
}

function removeFileListLines(text, key, drop) {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== `${key}: |`) continue;
    let j = i + 1;
    while (j < lines.length && lines[j].startsWith("  ")) j++;
    const kept = lines.slice(i + 1, j).filter((l) => !drop.has(nfc(wikilinkTarget(l.trim()) || "")));
    return [...lines.slice(0, i), ...(kept.length ? [`${key}: |`, ...kept] : []), ...lines.slice(j)].join("\n");
  }
  return text;
}

const isMaterialeName = (name) => !name.startsWith("[PLAN] ") && !name.startsWith("[NOTE] ") && !name.startsWith("_");
const mdIn = (files, dir) => files.filter((f) => f.endsWith(".md") && dirOf(f) === dir).sort(cmpParts);
const planFiles = (files) => files.filter((f) => baseOf(f).startsWith("[PLAN] ") && f.endsWith(".md")).sort(cmpParts);

// {materiale-sti (NFC): plan_id} for mappens materialer med et `lektion:`-stempel.
async function declaredOwners(vault, files, dir) {
  const declared = {};
  for (const md of mdIn(files, dir)) {
    if (!isMaterialeName(baseOf(md))) continue;
    const pid = parseFrontmatter(await vault.read(md)).lesson;
    if (pid) declared[nfc(md)] = pid;
  }
  return declared;
}

async function patchPendingMateriale(vault, apply) {
  const files = await vault.list();
  const folders = new Map();
  for (const planPath of planFiles(files)) {
    const text = await vault.read(planPath);
    const fields = parseFrontmatter(text);
    if (fields.type !== "lesson-plan") continue;
    const dir = dirOf(planPath);
    if (!folders.has(dir)) folders.set(dir, []);
    folders.get(dir).push({ planPath, text, fields });
  }
  const patched = [];
  for (const [dir, siblings] of folders) {
    const owned = new Map(siblings.map((s) => [s.planPath, ownedTargets(s.text, s.fields)]));
    const declared = await declaredOwners(vault, files, dir);
    for (const s of siblings) {
      for (const [t, pid] of Object.entries(declared)) if (pid === s.fields.plan_id) owned.get(s.planPath).add(t);
    }
    for (const { planPath, text, fields } of siblings) {
      const mine = owned.get(planPath);
      const claimedElsewhere = new Set();
      for (const [p, ts] of owned) if (p !== planPath) for (const t of ts) if (!mine.has(t)) claimedElsewhere.add(t);
      const linked = new Set();
      for (const key of ["material_files", "literature_files"]) {
        for (const l of fieldLines(fields[key])) {
          const t = wikilinkTarget(l);
          if (t) linked.add(nfc(t));
        }
      }
      let orphans = [];
      for (const md of mdIn(files, dir)) {
        const name = baseOf(md);
        if (nfc(name) === nfc(baseOf(planPath)) || !isMaterialeName(name) || name.includes(".sync-conflict-")) continue;
        if (parseFrontmatter(await vault.read(md)).type === "dublet") continue;
        orphans.push(nfc(md));
      }
      orphans = orphans.filter((o) => !linked.has(o) && !claimedElsewhere.has(o));
      if (isPrepDay(fields)) orphans = [];
      const foreign = new Set();
      for (const l of fieldLines(fields.material_files)) {
        const t = nfc(wikilinkTarget(l) || "");
        if (claimedElsewhere.has(t)) foreign.add(t);
      }
      if (!orphans.length && !foreign.size) continue;
      let updated = orphans.length ? appendFileListField(text, "material_files", orphans.map(wikilinkFor)) : text;
      if (foreign.size) updated = removeFileListLines(updated, "material_files", foreign);
      if (updated === text) continue;
      patched.push(planPath);
      if (apply) await vault.write(planPath, updated);
    }
  }
  return patched;
}

async function readTasks(vault) {
  const tasks = [];
  for (const path of (await vault.list()).filter((f) => f.endsWith(".md") && underRoot(f, OPGAVER_ROOT)).sort(cmpParts)) {
    const fields = parseFrontmatter(await vault.read(path));
    if (fields.type !== "assignment" || !fields.course || !fields.deadline) continue;
    const m = /ElementID=(\d+)/.exec(fields.source ?? "");
    if (!m) continue;
    tasks.push({ ...fields, _element_id: m[1], _path: nfc(path), _title: pathStem(path) });
  }
  return tasks;
}

async function readPlans(vault) {
  const files = await vault.list();
  const plans = [], udenPlanId = [];
  const declaredByFolder = new Map();
  for (const path of planFiles(files)) {
    const text = await vault.read(path);
    const fields = parseFrontmatter(text);
    if (fields.type !== "lesson-plan" || !fields.course) continue;
    if (!fields.plan_id) {
      udenPlanId.push(path);
      continue;
    }
    fields._path = nfc(path);
    const dir = dirOf(path);
    if (!declaredByFolder.has(dir)) declaredByFolder.set(dir, await declaredOwners(vault, files, dir));
    const declared = declaredByFolder.get(dir);
    const autoOwned = ownedTargets(text, fields);
    for (const t of autoOwned) {
      const pid = declared[t];
      if (pid && pid !== fields.plan_id) console.log(`Advarsel: ${t} står i ${fields.plan_id}s Materials, men lesson: siger ${pid}`);
    }
    for (const [t, pid] of Object.entries(declared)) if (pid === fields.plan_id) autoOwned.add(t);
    fields._owned = [...autoOwned].sort(cmpStr);
    plans.push(fields);
  }
  return [plans, udenPlanId];
}

// ── data.json-hjælpere ──

let hcIdCounter = 0;
const hcGenerateId = () => `${Date.now().toString(16)}v${(++hcIdCounter).toString(16).padStart(3, "0")}`;
const findStamped = (items, key, value) => items.find((it) => it[key] === value) ?? null;
const listOf = (obj, name) => (obj[name] ??= []);

function relocateStamped(data, listName, key, value, targetCls) {
  const own = listOf(targetCls, listName);
  const ownMatches = own.filter((it) => it[key] === value);
  for (const extra of ownMatches.slice(1)) own.splice(own.indexOf(extra), 1);
  const already = ownMatches[0] ?? null;
  for (const sem of data.semesters ?? []) {
    for (const cls of sem.classes ?? []) {
      if (cls === targetCls) continue;
      const item = findStamped(cls[listName] ?? [], key, value);
      if (item) {
        cls[listName].splice(cls[listName].indexOf(item), 1);
        if (!already) listOf(targetCls, listName).push(item);
        return;
      }
    }
  }
}

const termYearForDate = (date) => [Number(date.slice(5, 7)) >= 7 ? "Fall" : "Spring", Number(date.slice(0, 4))];
const semesterNameForTermYear = (term, year) => (term === "Fall" ? `Efterår ${year}` : term === "Spring" ? `Forår ${year}` : `${term} ${year}`);

function ensureAllSemesters(data, plans, tasks, newId) {
  listOf(data, "semesters");
  const needed = new Map();
  const need = (d) => { const ty = termYearForDate(d.slice(0, 10)); needed.set(ty.join("|"), ty); };
  for (const p of plans) if (p.start) need(p.start);
  for (const t of tasks) if (t.deadline) need(t.deadline);
  if (!needed.size) { const n = new Date(); const ty = [n.getMonth() + 1 >= 7 ? "Fall" : "Spring", n.getFullYear()]; needed.set(ty.join("|"), ty); }
  const termYearToSem = new Map();
  for (const [k, [term, year]] of [...needed].sort((a, b) => cmpTuple(a[1], b[1]))) {
    let sem = data.semesters.find((s) => s.term === term && s.year === year);
    if (!sem) {
      sem = { id: newId(), name: semesterNameForTermYear(term, year), term, year, classes: [], resources: [] };
      data.semesters.push(sem);
    }
    termYearToSem.set(k, sem);
  }
  if (!data.currentSemesterId && data.semesters.length) data.currentSemesterId = data.semesters[0].id;
  return termYearToSem;
}

const courseUrl = (courseId) => (courseId ? HC_COURSE_URL + courseId : "");

function ensureClass(sem, fag, newId, courseId = "") {
  const url = courseUrl(courseId);
  let cls = findStamped(sem.classes, "vswFag", fag);
  if (cls) {
    if (url && ["", cls.vswCourseUrl ?? ""].includes(cls.courseUrl ?? "")) {
      cls.courseUrl = url;
      cls.vswCourseUrl = url;
    }
    return cls;
  }
  // code, colorIndex og name sættes kun ved oprettelsen (#270), så brugerens egne rettelser i Hold Course overlever.
  const code = Object.keys(COURSE_NAMES).find((k) => COURSE_NAMES[k] === fag) ?? fag;
  cls = {
    id: newId(), colorIndex: sem.classes.length % HC_COLOR_PALETTE_SIZE,
    code, name: fag, courseUrl: url, vswCourseUrl: url, meetingLink: "",
    professorName: "", professorEmail: "", officeHours: "",
    taName: "", taEmail: "", taOfficeHours: "",
    meetingDays: [], location: "", startDate: "", endDate: "",
    meetingStartTime: "", meetingEndTime: "",
    lectures: [], assignments: [], exams: [], resources: [],
    vswFag: fag,
  };
  sem.classes.push(cls);
  return cls;
}

const hhmm = (datetimeStr) => (datetimeStr.length >= 16 ? datetimeStr.slice(11, 16) : "");

function setDeviationField(lec, field, clsDefault, itslearningValue) {
  const stamp = `vsw${field[0].toUpperCase()}${field.slice(1)}`;
  const syncOwned = !(stamp in lec) || (lec[field] ?? "") === (lec[stamp] ?? "");
  if (!syncOwned) return;
  const target = itslearningValue && itslearningValue !== clsDefault ? itslearningValue : "";
  lec[field] = target;
  lec[stamp] = target;
}

function ensureLecture(cls, plan, newId, stubFor = (p) => p) {
  let lec = findStamped(listOf(cls, "lectures"), "vswPlanId", plan.plan_id);
  if (!lec) {
    lec = {
      id: newId(), title: "", date: "", status: "not-started",
      notes: "", description: "", vaultLink: "", assignments: [],
      meetingStartTime: "", meetingEndTime: "", location: "", professorName: "",
      vswPlanId: plan.plan_id,
    };
    cls.lectures.push(lec);
  }
  lec.title = plan.topic || (plan.start || "").slice(0, 10) || "Lesson";
  lec.date = (plan.start || "").slice(0, 10);
  setDeviationField(lec, "meetingStartTime", cls.meetingStartTime ?? "", hhmm(plan.start ?? ""));
  setDeviationField(lec, "meetingEndTime", cls.meetingEndTime ?? "", hhmm(plan.stop ?? ""));
  setDeviationField(lec, "location", cls.location ?? "", plan.room ?? "");
  setDeviationField(lec, "professorName", cls.professorName ?? "", plan.teacher ?? "");
  const planDescription = plan.description ?? "";
  const prepText = plan.preparation_text ?? "";
  const description = [planDescription, prepText ? `**Preparation**\n\n${prepText}` : ""].filter(Boolean).join("\n\n---\n\n");
  if (description) {
    lec.description = description;
    lec.vswDescription = description;
  }
  const stub = nfc(stubFor(plan._path));
  const syncOwned = !("vswVaultLink" in lec) || ["", lec.vswVaultLink].includes(lec.vaultLink);
  if (syncOwned) {
    lec.vaultLink = stub;
    lec.vswVaultLink = stub;
  }
  lec.vaultLink = nfc(lec.vaultLink);
  return lec;
}

function migrateNotesToDescription(data) {
  let moved = 0;
  for (const sem of data.semesters ?? []) for (const cls of sem.classes ?? []) for (const lec of cls.lectures ?? []) {
    if (!("vswNotes" in lec)) continue;
    const stamp = lec.vswNotes;
    delete lec.vswNotes;
    if ((lec.notes ?? "") === stamp) {
      lec.description = stamp;
      lec.vswDescription = stamp;
      lec.notes = "";
      moved++;
    }
  }
  return moved;
}

function stableKey(vaultPath) {
  const parts = vaultPath.split("/");
  return parts.length >= 5 ? [...parts.slice(0, 3), ...parts.slice(4)].join("/") : vaultPath;
}

function ensureResource(sem, cls, vaultPath, newId) {
  const key = stableKey(vaultPath);
  let res = findStamped(listOf(sem, "resources"), "vswResKey", key);
  if (!res) {
    res = { id: newId(), title: pathStem(vaultPath), author: "", type: "", classIds: [], status: "unread", vaultLink: vaultPath, url: "", notes: "", vswResKey: key };
    sem.resources.push(res);
  }
  res.vaultLink = nfc(vaultPath);
  if (!listOf(res, "classIds").includes(cls.id)) res.classIds.push(cls.id);
  return res;
}

function pruneStaleResourceClasses(data, seen, touchedClasses) {
  const orphaned = [];
  for (const sem of data.semesters ?? []) for (const res of sem.resources ?? []) {
    const still = seen.get(res.id) ?? new Set();
    res.classIds = (res.classIds ?? []).filter((c) => !touchedClasses.has(c) || still.has(c));
    if (!res.classIds.length) orphaned.push(`${res.title ?? ""} (${res.vaultLink ?? ""})`);
  }
  return orphaned;
}

function ensureAssignment(owner, key, title, atype, due, linkedBook, newId, linkedNote = "") {
  let a = findStamped(listOf(owner, "assignments"), "vswKey", key);
  if (!a) {
    a = { id: newId(), title: "", type: atype, dueDate: "", status: "not-started", notes: "", grade: "", linkedBook: "", linkedNote: "", vswKey: key };
    owner.assignments.push(a);
  }
  a.title = title;
  a.type = atype;
  a.dueDate = due;
  if (linkedBook) a.linkedBook = linkedBook;
  if (linkedNote && !a.linkedNote) a.linkedNote = linkedNote;
  a.linkedNote = nfc(a.linkedNote ?? "");
  return a;
}

// `exists(sti)` er et synkront opslag: Python spurgte filsystemet direkte (`.exists()`).
function pruneDeadLinks(data, exists) {
  let removedRes = 0, removedAssign = 0;
  for (const sem of data.semesters ?? []) {
    const aliveResIds = new Set(), seenByLink = new Map(), idRemap = new Map(), kept = [];
    for (const res of sem.resources ?? []) {
      const link = res.vaultLink;
      if (link && !exists(link)) { removedRes++; continue; }
      if (link && seenByLink.has(link)) {
        const first = seenByLink.get(link);
        idRemap.set(res.id, first.id);
        for (const cid of res.classIds ?? []) if (!listOf(first, "classIds").includes(cid)) first.classIds.push(cid);
        removedRes++;
        continue;
      }
      if (link) seenByLink.set(link, res);
      aliveResIds.add(res.id);
      kept.push(res);
    }
    sem.resources = kept;
    for (const cls of sem.classes ?? []) {
      for (const owner of [...(cls.lectures ?? []), cls]) {
        const keptA = [];
        for (const a of owner.assignments ?? []) {
          if (a.linkedNote && !exists(a.linkedNote)) { removedAssign++; continue; }
          if (idRemap.has(a.linkedBook)) a.linkedBook = idRemap.get(a.linkedBook);
          if (a.linkedBook && !aliveResIds.has(a.linkedBook)) a.linkedBook = "";
          keptA.push(a);
        }
        owner.assignments = keptA;
      }
    }
  }
  return [removedRes, removedAssign];
}

// stubFor(planSti) -> [NOTE]-stubbens sti (hcNoteStubPath med et færdigbygget fil-opslag).
function syncData(data, plans, newId = null, tasks = null, droppedOut = null, report = null, stubFor = (p) => p) {
  newId = newId ?? hcGenerateId;
  listOf(data, "semesters");
  data.dataVersion ??= HC_KNOWN_DATA_VERSION;
  tasks = tasks ?? [];
  migrateNotesToDescription(data);
  if (!plans.length && !tasks.length) return data;

  const termYearToSem = ensureAllSemesters(data, plans, tasks, newId);
  const semFor = (date) => termYearToSem.get(termYearForDate(date.slice(0, 10)).join("|")) ?? termYearToSem.values().next().value;
  const touched = new Map(); // "semId|clsId" -> Set(plan_id)
  const seenRes = new Map();
  const fallbackClaimed = new Map();
  const markSeen = (res, cls) => { if (!seenRes.has(res.id)) seenRes.set(res.id, new Set()); seenRes.get(res.id).add(cls.id); };

  for (const plan of [...plans].sort((a, b) => cmpTuple([a.course, a.start ?? ""], [b.course, b.start ?? ""]))) {
    if (!plan.start) continue;
    const sem = semFor(plan.start);
    if (!sem) continue;
    const cls = ensureClass(sem, plan.course, newId, plan.plan_id.split(":")[0]);
    relocateStamped(data, "lectures", "vswPlanId", plan.plan_id, cls);
    const lec = ensureLecture(cls, plan, newId, stubFor);
    const tk = `${sem.id}|${cls.id}`;
    if (!touched.has(tk)) touched.set(tk, new Set());
    touched.get(tk).add(plan.plan_id);
    const due = lec.date;
    const akey = lec.id;
    const stub = lec.vswVaultLink || lec.vaultLink;
    const validFileKeys = new Set();

    const targets = fieldLines(plan.literature_files).map(wikilinkTarget).filter(Boolean).map(nfc);
    if (targets.length) {
      for (const target of targets) {
        const res = ensureResource(sem, cls, target, newId);
        markSeen(res, cls);
        const key = `${akey}|lit|${stableKey(target)}`;
        ensureAssignment(lec, key, res.title, "Reading", due, res.id, newId, target);
        validFileKeys.add(key);
      }
    } else {
      const litText = fieldLines(plan.literature);
      if (litText.length) {
        const key = `${akey}|lit|`;
        ensureAssignment(lec, key, [...litText.join(" ")].slice(0, 200).join(""), "Reading", due, "", newId, stub);
        validFileKeys.add(key);
      }
    }
    for (const titel of fieldLines(plan.preparation)) {
      ensureAssignment(lec, `${akey}|forb|${titel}`, titel, "Preparation", due, "", newId, stub);
    }
    for (const line of fieldLines(plan.material_files)) {
      const target = nfc(wikilinkTarget(line) || "");
      if (!target) continue;
      if ("_owned" in plan && !plan._owned.includes(target)) {
        const ck = `${cls.id}|${target}`;
        if (!fallbackClaimed.has(ck)) fallbackClaimed.set(ck, plan.plan_id);
        if (fallbackClaimed.get(ck) !== plan.plan_id) continue;
      }
      const res = ensureResource(sem, cls, target, newId);
      markSeen(res, cls);
      const key = `${akey}|mat|${stableKey(target)}`;
      ensureAssignment(lec, key, res.title, "Reading", due, res.id, newId, target);
      validFileKeys.add(key);
    }
    lec.assignments = lec.assignments.filter((a) => {
      const k = a.vswKey ?? "";
      return !(k.startsWith(`${akey}|lit|`) || k.startsWith(`${akey}|mat|`)) || validFileKeys.has(k);
    });
  }

  const touchedTasks = new Map();
  for (const task of [...tasks].sort((a, b) => cmpTuple([a.course, a.deadline ?? ""], [b.course, b.deadline ?? ""]))) {
    if (!task.deadline) continue;
    const sem = semFor(task.deadline);
    if (!sem) continue;
    const cls = ensureClass(sem, task.course, newId);
    const key = `opgave|${task._element_id}`;
    relocateStamped(data, "assignments", "vswKey", key, cls);
    ensureAssignment(cls, key, task._title, "Writing", task.deadline.slice(0, 10), "", newId, task._path);
    if (!touchedTasks.has(cls.id)) touchedTasks.set(cls.id, new Set());
    touchedTasks.get(cls.id).add(key);
  }

  if (droppedOut) {
    for (const sem of data.semesters) for (const cls of sem.classes ?? []) {
      const seen = touched.get(`${sem.id}|${cls.id}`);
      if (!seen) continue;
      for (const lec of cls.lectures ?? []) {
        if (lec.vswPlanId && !seen.has(lec.vswPlanId)) droppedOut.push(`${cls.vswFag || cls.name || ""} ${lec.date ?? ""} ${lec.title ?? ""}`);
      }
    }
  }

  if (report) {
    const touchedSems = new Set([...touched.keys()].map((k) => k.split("|")[0]));
    const touchedClasses = new Set([...touched.keys()].map((k) => k.split("|")[1]));
    const push = (k, line) => listOf(report, k).push(line);
    for (const sem of data.semesters) {
      if (!touchedSems.has(sem.id)) continue;
      for (const cls of sem.classes ?? []) {
        if (!touchedClasses.has(cls.id)) {
          push("dropped_classes", `${sem.name ?? ""}: ${cls.vswFag || cls.name || ""}`);
          continue;
        }
        const seenKeys = touchedTasks.get(cls.id);
        if (!seenKeys) continue;
        for (const a of cls.assignments ?? []) {
          const k = a.vswKey ?? "";
          if (k.startsWith("opgave|") && !seenKeys.has(k)) push("dropped_tasks", `${cls.vswFag || cls.name || ""} ${a.dueDate ?? ""} ${a.title ?? ""}`);
        }
      }
    }
    const orphaned = pruneStaleResourceClasses(data, seenRes, touchedClasses);
    if (orphaned.length) listOf(report, "orphaned_resources").push(...orphaned);
  }
  return data;
}

// Vault -> Hold Course: en Forberedelse krydset direkte i [NOTE]-stubben bliver `done`.
// `readText(sti)` er et synkront opslag (null = findes ikke).
function syncTaskCompletion(data, readText) {
  const markedDone = [];
  for (const sem of data.semesters ?? []) for (const cls of sem.classes ?? []) for (const lec of cls.lectures ?? []) {
    const stubRel = lec.vswVaultLink || lec.vaultLink;
    if (!stubRel) continue;
    const text = readText(stubRel);
    if (text == null) continue;
    for (const a of lec.assignments ?? []) {
      const key = a.vswKey ?? "";
      if (!key.includes("|forb|") || a.status !== "not-started") continue;
      const titel = key.slice(key.indexOf("|forb|") + 6);
      if (text.split("\n").some((line) => line.trim() === `- [x] ${titel}`)) {
        a.status = "done";
        markedDone.push(`${titel} (${stubRel})`);
      }
    }
  }
  return markedDone;
}

// ── _forløb.md: holdbarheds-spejl (#152) ──

function isoWeekOf(date) {
  const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec((date ?? "").slice(0, 10));
  if (!m) return "—";
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCMonth() !== +m[2] - 1) return "—";
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d - yearStart) / 864e5 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function enhedFromLink(link) {
  const parts = (link || "").split("/");
  const i = parts.indexOf("MD");
  return i !== -1 && i + 2 < parts.length ? parts[i + 1] : "—";
}

const cell = (text) => (text || "—").replaceAll("|", "\\|").replaceAll("\n", " ");

function renderForloeb(sem, cls, genereret) {
  const fag = cls.vswFag || cls.name || "";
  const out = [
    "---", `course: ${fag}`, `semester: ${sem.name ?? ""}`,
    `generated: ${genereret}`, "source: hold-course-sync", "---", "",
    FORLOEB_HEADER, "",
    "| date | week | unit | title | status | materials | tasks + due |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const lec of [...(cls.lectures ?? [])].sort((a, b) => cmpTuple([a.date ?? "", a.title ?? ""], [b.date ?? "", b.title ?? ""]))) {
    const readings = [], opgaver = [];
    for (const a of lec.assignments ?? []) {
      if (a.type === "Reading") {
        const tgt = a.linkedNote || "";
        if (tgt) readings.push(`[[${tgt}|${pathStem(tgt)}]]`);
      } else {
        const due = a.dueDate ?? "";
        opgaver.push(due ? `${a.title ?? ""} — ${due} (${a.status ?? ""})` : `${a.title ?? ""} (${a.status ?? ""})`);
      }
    }
    const row = [lec.date ?? "", isoWeekOf(lec.date ?? ""), enhedFromLink(lec.vaultLink || lec.vswVaultLink || ""),
      lec.title ?? "", lec.status ?? "", [...new Set(readings)].join("<br>"), opgaver.join("<br>")];
    out.push(`| ${row.map(cell).join(" | ")} |`);
  }
  if (cls.assignments?.length) {
    out.push("", "## Assignments (without lesson)", "", "| title | due | status | note |", "| --- | --- | --- | --- |");
    for (const a of [...cls.assignments].sort((x, y) => cmpTuple([x.dueDate ?? "", x.title ?? ""], [y.dueDate ?? "", y.title ?? ""]))) {
      const note = a.linkedNote || "";
      out.push(`| ${[a.title ?? "", a.dueDate ?? "", a.status ?? "", note ? `[[${note}|${pathStem(note)}]]` : ""].map(cell).join(" | ")} |`);
    }
  }
  return `${out.join("\n")}\n`;
}

const stripGenereret = (text) => text.replace(/^generated: .*$/m, "generated:");

// `isDir(sti)` er et synkront opslag. null = faget har ingen mappe (mappenavn = fagnavn, #270).
function forloebPath(sem, cls, multi, isDir) {
  const fag = cls.vswFag || cls.name || "";
  if (!fag) return null;
  const fagDir = `${FAG_ROOT}/${sanitizeFilename(fag)}`;
  if (!isDir(fagDir)) return null;
  return multi ? `${fagDir}/_HoldCourse/${nfc(`${sem.name ?? "ukendt"}.md`)}` : `${fagDir}/${nfc("_forløb.md")}`;
}

// [sti, tekst] for hvert spejl der skal skrives (indhold uændret på nær tidsstemplet = spring over).
function forloebMirrors(data, genereret, isDir, readText) {
  const fagCount = {};
  for (const sem of data.semesters ?? []) for (const cls of sem.classes ?? []) {
    const fag = cls.vswFag || cls.name || "";
    fagCount[fag] = (fagCount[fag] ?? 0) + 1;
  }
  const writes = [];
  for (const sem of data.semesters ?? []) for (const cls of sem.classes ?? []) {
    const path = forloebPath(sem, cls, fagCount[cls.vswFag || cls.name || ""] > 1, isDir);
    if (!path) continue;
    const text = renderForloeb(sem, cls, genereret);
    const old = readText(path);
    if (old != null && stripGenereret(old) === stripGenereret(text)) continue;
    writes.push([path, text]);
  }
  return writes;
}

// ── Hold Course-synken i drift (#242): afløser watcherens minut-tick og sync() ──

const HC_API_VERSION = 1;
const HC_ONYX_DIR = ".obsidian-onyx/plugins/hold-course";
const HC_ONYX_DATA = `${HC_ONYX_DIR}/data.json`;
const BOOX_TICK_MS = 60e3;

const holdCourse = () => plugin.app.plugins.plugins["hold-course"];

function holdCourseApi() {
  const api = holdCourse()?.api;
  if (api?.version >= HC_API_VERSION) return api;
  if (!plugin.hcApiWarned) {
    plugin.hcApiWarned = true;
    new Notice(`ItsWiz: Hold Course sync needs Hold Course with API version ${HC_API_VERSION} (hold-course#84). Update Hold Course.`, 0);
  }
  return null;
}

const obsidianVault = () => ({
  list: async () => plugin.app.vault.getFiles().map((f) => f.path),
  read: (p) => plugin.app.vault.adapter.read(normalizePath(p)),
  write: (p, text) => writeVaultFile(p, text),
});

// Læser filerne på forhånd, så syncData/syncTaskCompletion kan slå dem op synkront inde i update().
async function readAll(paths) {
  const texts = new Map();
  for (const p of new Set(paths)) {
    const text = await readFromVault(p);
    if (text != null) texts.set(nfc(p), text);
  }
  return (p) => texts.get(nfc(p)) ?? null;
}

const localTimestamp = () => {
  const d = new Date(), z = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`;
};

function logLines(heading, lines) {
  if (lines?.length) console.log(`ItsWiz: ${lines.length} ${heading}:\n  ${lines.join("\n  ")}`);
}

async function runHoldCourseSync() {
  const api = holdCourseApi();
  if (!api) return;
  const vault = obsidianVault();
  logLines("lektionsplan-note(r) fik materiale_filer opdateret (#141/#183)", await patchPendingMateriale(vault, true));
  const [plans, udenPlanId] = await readPlans(vault);
  const tasks = await readTasks(vault);

  const files = plugin.app.vault.getAllLoadedFiles();
  const paths = new Set(files.map((f) => nfc(f.path)));
  const dirs = new Set(files.filter((f) => f instanceof TFolder).map((f) => nfc(f.path)));
  const exists = (p) => paths.has(nfc(p));
  const stubFor = (p) => hcNoteStubPath(p, exists);
  const lectureLinks = (holdCourse().data.semesters ?? []).flatMap((s) => (s.classes ?? []).flatMap((c) => (c.lectures ?? []).map((l) => l.vswVaultLink || l.vaultLink)));
  const readText = await readAll([...lectureLinks, ...plans.map((p) => stubFor(p._path))].filter((p) => p && exists(p)));

  const { result: r, restored } = await api.update((data) => {
    const dropped = [], report = {};
    syncData(data, plans, null, tasks, dropped, report, stubFor);
    const marked = syncTaskCompletion(data, readText);
    const [removedRes, removedAssign] = pruneDeadLinks(data, exists);
    return { dropped, report, marked, removedRes, removedAssign };
  });

  logLines("lektionsplan-note(r) uden plan_id springes over (ret dem i vaulten)", udenPlanId);
  logLines("lektion(er) i Hold Course er ikke længere i itslearning (#173)", r.dropped);
  logLines("fag fik ingen lektioner i et ellers aktivt semester", r.report.dropped_classes);
  logLines("afleveringsopgave(r) er ikke længere i itslearning", r.report.dropped_tasks);
  logLines("materiale(r) i Library bruges ikke længere af nogen klasse", r.report.orphaned_resources);
  logLines("Forberedelse-opgave(r) krydset af i vaulten, markeret Done", r.marked);
  if (r.removedRes || r.removedAssign) console.log(`ItsWiz: ryddet op: ${r.removedRes} død(e) Library-post(er), ${r.removedAssign} død(e) opgave(r).`);
  logLines("felt(er) rullet tilbage af Hold Course (synken ejer dem ikke)", restored);

  const mirrorPaths = [...paths].filter((p) => p.startsWith(`${FAG_ROOT}/`) && (p.endsWith("/_forløb.md") || p.includes("/_HoldCourse/")));
  const mirrorText = await readAll(mirrorPaths);
  const writes = forloebMirrors(holdCourse().data, localTimestamp(), (p) => dirs.has(nfc(p)), mirrorText);
  for (const [p, text] of writes) await writeVaultFile(p, text);
  if (writes.length) console.log(`ItsWiz: skrev ${writes.length} _forløb.md (holdbarheds-spejl, #152).`);

  await syncBoox();
}

// Én kørsel ad gangen; hændelser under en kørsel giver én kørsel mere bagefter, ikke en pr. hændelse.
let hcSyncTimer = null, hcSyncRunning = null, hcSyncAgain = false;
function scheduleHoldCourseSync(delayMs = 5000) {
  clearTimeout(hcSyncTimer);
  hcSyncTimer = setTimeout(async () => {
    if (!(await getSettings()).enableHoldCourseSync) return;
    if (hcSyncRunning) return void (hcSyncAgain = true);
    hcSyncRunning = runHoldCourseSync()
      .catch((err) => {
        console.error("ItsWiz: Hold Course-synk fejlede:", err);
        new Notice(`ItsWiz: Hold Course sync failed\n${err.message}`);
      })
      .finally(() => {
        hcSyncRunning = null;
        if (hcSyncAgain) (hcSyncAgain = false), scheduleHoldCourseSync();
      });
  }, delayMs);
}

const touchesHoldCourseInput = (path) => path.endsWith(".md") && (underRoot(path, FAG_ROOT) || underRoot(path, OPGAVER_ROOT));

// ── Boox (.obsidian-onyx): Boox' Hold Course har sin egen data.json (#146, hold-course#10) ──
//
// Python-reconcilen overskrev Boox' kopi hvert minut, så noget krydset af på Boox gik tabt, og
// Mac og Boox skrev den samme fil (5 Syncthing-konflikter 1/9–1/10). Nu en tre-vejs-fletning mod
// den kopi ItsWiz sidst skrev (`base`): hvad Boox har ændret siden (status, karakter, noter, nye
// egne opgaver), hentes ind på Mac'en først, og kopien skrives kun når indholdet er anderledes.
// ponytail: noget slettet på Boox kommer igen fra Mac'en; fletning af sletninger når det savnes.

const BOOX_USER_FIELDS = ["status", "grade", "notes"];

function eachItem(obj, fn) {
  for (const [list, v] of Object.entries(obj)) {
    if (!Array.isArray(v)) continue;
    for (const item of v) if (item && typeof item === "object" && item.id) fn(item, obj, list), eachItem(item, fn);
  }
}

// Fletter Boox' ændringer siden `base` ind i `mac` (muterer). Returnerer hvad der blev flettet.
function mergeBooxEdits(mac, boox, base) {
  const macById = new Map(), baseById = new Map();
  eachItem(mac, (item) => macById.set(item.id, item));
  eachItem(base, (item) => baseById.set(item.id, item));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const merged = [], added = new Set();
  eachItem(boox, (item, parent, list) => {
    const own = macById.get(item.id), old = baseById.get(item.id);
    if (own && old) {
      for (const f of BOOX_USER_FIELDS) {
        if (!same(item[f], old[f]) && !same(item[f], own[f])) {
          own[f] = structuredClone(item[f]);
          merged.push(`${item.title ?? item.id}: ${f}`);
        }
      }
      return;
    }
    // Oprettet på Boox: ikke i base (så ikke slettet på Mac), intet vsw-stempel (brugerens eget).
    if (own || old || added.has(parent.id) || Object.keys(item).some((k) => k.startsWith("vsw"))) return;
    const macParent = parent === boox ? mac : macById.get(parent.id);
    if (!macParent) return;
    (macParent[list] ??= []).push(structuredClone(item));
    added.add(item.id);
    merged.push(`ny: ${item.title ?? item.id}`);
  });
  return merged;
}

const booxContent = (data) => `${JSON.stringify(Object.fromEntries(Object.entries(data).filter(([k]) => k !== "settings")), null, 2)}\n`;
const onyxBasePath = () => `${plugin.manifest.dir}/onyx-base.json`;

async function syncBoox() {
  const api = holdCourseApi();
  const { adapter } = plugin.app.vault;
  if (!api || !(await adapter.exists(HC_ONYX_DATA))) return;

  const conflicts = (await adapter.list(HC_ONYX_DIR)).files.filter((f) => f.includes(".sync-conflict-"));
  const known = (plugin.data.knownOnyxConflicts ??= []);
  const fresh = conflicts.filter((f) => !known.includes(f));
  if (fresh.length) {
    new Notice(`ItsWiz: ${fresh.length} Syncthing conflict(s) in the Boox Hold Course data:\n${fresh.map((f) => f.split("/").pop()).join("\n")}`, 0);
    known.push(...fresh);
    await plugin.saveData(plugin.data);
  }

  const text = await adapter.read(HC_ONYX_DATA);
  // Uden base (første kørsel) flettes intet: Python-reconcilen har netop overskrevet Boox' kopi
  // med Mac'ens, så Boox har intet eget at give.
  const base = (await adapter.exists(onyxBasePath())) ? await adapter.read(onyxBasePath()) : null;
  if (base && text !== base) {
    const boox = JSON.parse(text);
    const { result } = await api.update((data) => mergeBooxEdits(data, boox, JSON.parse(base)), { userEdits: true });
    logLines("ændring(er) fra Boox hentet ind i Hold Course", result);
  }
  const desired = booxContent(holdCourse().data);
  if (desired !== text) await adapter.write(HC_ONYX_DATA, desired);
  if (desired !== base) await adapter.write(onyxBasePath(), desired);
}

// ── Obsidian-delen ──

class ItsWizView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "ItsWiz"; }
  getIcon() { return "wand-sparkles"; }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.style.cssText = "display:flex;flex-direction:column;padding:0;height:100%";
    const bar = root.createDiv({ attr: { style: "display:flex;gap:6px;align-items:center;padding:6px" } });
    bar.createEl("button", { text: "←" }).onclick = () => this.webview.canGoBack() && this.webview.goBack();
    bar.createEl("button", { text: "⟳" }).onclick = () => this.webview.reload();
    bar.createEl("button", { text: "Harvest now", cls: "mod-cta" }).onclick = () => runCollectAndDownload();
    bar.createEl("button", { text: "Path test" }).onclick = () => runPathTest();
    this.urlEl = bar.createSpan({ attr: { style: "opacity:.6;font-size:12px;overflow:hidden;white-space:nowrap" } });
    this.webview = document.createElement("webview");
    this.webview.setAttribute("partition", PARTITION);
    this.webview.setAttribute("useragent", UA);
    this.webview.setAttribute("allowpopups", "");
    this.webview.setAttribute("src", START_URL);
    this.webview.style.cssText = "flex:1;width:100%";
    this.webview.addEventListener("did-navigate", (e) => (this.urlEl.textContent = e.url));
    root.appendChild(this.webview);
  }
}

// Ny rod: gem, og flyt den gamle mappe hvis den findes og den nye ikke gør (renameFile, så wikilinks følger med).
async function changeRoot(key, value) {
  const s = plugin.data.settings;
  const old = key === "fagRoot" ? FAG_ROOT : OPGAVER_ROOT;
  const next = normRoot(value, DEFAULT_SETTINGS[key]);
  if (next === old) return;
  const { vault, fileManager } = plugin.app;
  const oldDir = vault.getAbstractFileByPath(normalizePath(old));
  if (oldDir instanceof TFolder && !vault.getAbstractFileByPath(normalizePath(next))) {
    try {
      if (next.includes("/")) await ensureFolder(next.slice(0, next.lastIndexOf("/")));
      await fileManager.renameFile(oldDir, normalizePath(next));
    } catch (err) {
      return new Notice(`ItsWiz: could not move ${old} to ${next}: ${err.message}`, 0);
    }
  }
  s[key] = next;
  await plugin.saveData(plugin.data);
  applyRoots(s);
  scheduleHoldCourseSync();
}

class ItsWizSettingTab extends PluginSettingTab {
  display() {
    const { containerEl } = this;
    const s = this.plugin.data.settings;
    const save = () => this.plugin.saveData(this.plugin.data);
    containerEl.empty();
    for (const [key, name, desc] of [
      ["daysBack", "Days back", "How far back each run looks."],
      ["daysForward", "Days ahead", "How far ahead each run looks."],
      ["alarmIntervalHours", "Interval (hours)", "Runs automatically at Obsidian start and then at this interval."],
    ]) {
      new Setting(containerEl).setName(name).setDesc(desc).addText((t) =>
        t.setValue(String(s[key] ?? DEFAULT_SETTINGS[key])).onChange((v) => {
          if (Number.isFinite(Number(v)) && v.trim() !== "") (s[key] = Number(v)), save();
        })
      );
    }
    for (const [key, name, desc] of [
      ["enableFileDownloads", "Download materials and write notes", "Off: a run only fetches data from itslearning."],
      ["enableTaskCompletionSync", "Mark preparation tasks as completed in itslearning", "Ticked in the NOTER stub note or Done in Hold Course (#70, #202)."],
    ]) {
      new Setting(containerEl).setName(name).setDesc(desc).addToggle((t) =>
        t.setValue(s[key] ?? DEFAULT_SETTINGS[key]).onChange((v) => ((s[key] = v), save()))
      );
    }

    containerEl.createEl("h3", { text: "Folders" });
    for (const [key, name, desc] of [
      ["fagRoot", "Courses folder", "Holds one folder per course (RAW, MD, NOTER). Default: Fag. If you change it and the old folder exists, it is moved (links follow)."],
      ["opgaverRoot", "Assignments folder", "The full path to the assignments, e.g. Noter/Opgaver. If you change it and the old folder exists, it is moved (links follow)."],
    ]) {
      new Setting(containerEl).setName(name).setDesc(desc).addText((t) =>
        t.setPlaceholder(DEFAULT_SETTINGS[key]).setValue(s[key] ?? DEFAULT_SETTINGS[key]).onChange((v) => {
          clearTimeout(this.rootTimer);
          // Vent til der er holdt op med at skrive, ellers flyttes mappen for hvert tastetryk.
          this.rootTimer = setTimeout(() => changeRoot(key, v), 1500);
        })
      );
    }

    containerEl.createEl("h3", { text: "Extra folders" });
    containerEl.createEl("p", { text: "Folders outside the courses folder whose RAW/ subfolders are converted too, e.g. almind/SFF (RAW sits directly inside). Their notes get `folder:` with the folder name instead of `course:`.", cls: "setting-item-description" });
    s.extraFolders ??= [];
    s.extraFolders.forEach((folder, i) => {
      new Setting(containerEl)
        .addText((t) => t.setPlaceholder("almind/SFF").setValue(folder).onChange((v) => {
          clearTimeout(this.extraTimer);
          this.extraTimer = setTimeout(() => ((s.extraFolders[i] = v.trim()), applyRoots(s), save(), s.enableConversion && scanExisting()), 1500);
        }))
        .addExtraButton((b) => b.setIcon("trash").setTooltip("Remove").onClick(() => ((s.extraFolders.splice(i, 1), applyRoots(s), save(), this.display()))));
    });
    new Setting(containerEl).addButton((b) => b.setButtonText("+").setTooltip("Add folder").onClick(() => ((s.extraFolders.push(""), this.display()))));

    containerEl.createEl("h3", { text: "Courses" });
    containerEl.createEl("p", { text: "Tick the itslearning courses ItsWiz should harvest. None are ticked at first. The name is used for the folder, `course:` in the notes, the calendar and Hold Course; empty = the course code itself. A name change only applies to new notes; existing folders are not renamed. Unticking a course stops new harvests; what is already in the vault stays.", cls: "setting-item-description" });
    new Setting(containerEl)
      .setName("Fetch course list")
      .setDesc("Looks up your courses in itslearning without harvesting anything. Needs a login.")
      .addButton((b) => b.setButtonText("Fetch").onClick(async () => (await fetchCourseList(), this.display())));
    s.courseNames ??= {};
    s.selectedCourses ??= [];
    for (const code of Object.keys(s.courseNames)) {
      new Setting(containerEl)
        .setName(code)
        .addToggle((t) =>
          t.setValue(s.selectedCourses.includes(code)).onChange((v) => {
            s.selectedCourses = s.selectedCourses.filter((c) => c !== code);
            if (v) s.selectedCourses.push(code);
            save();
          })
        )
        .addText((t) =>
          t.setPlaceholder(code).setValue(s.courseNames[code]).onChange((v) => {
            s.courseNames[code] = v.trim();
            applyCourseNames(s);
            save();
          })
        );
    }

    containerEl.createEl("h3", { text: "Conversion to markdown (MinerU)" });
    new Setting(containerEl)
      .setName("Convert RAW files")
      .setDesc("Sends new PDF and Office files under RAW/ to MinerU and writes the MD note. Optional: when off, the lesson plans link to the original file.")
      .addToggle((t) => t.setValue(s.enableConversion ?? false).onChange((v) => ((s.enableConversion = v), save(), v && scanExisting())));
    new Setting(containerEl)
      .setName("Use PDF text for digital PDFs")
      .setDesc("Needs the PDFable program. A PDF that is digital on every page, with no picture-heavy pages, gets its note straight from the PDF's text layer: instant, no upload, no MinerU key needed. Everything else still goes to MinerU. Experimental, so off by default; \"force\" on such a note converts it with MinerU instead.")
      .addToggle((t) => t.setValue(s.pdfableText ?? false).onChange((v) => ((s.pdfableText = v), save(), v && scanExisting())));
    containerEl.createEl("h3", { text: "Calendar" });
    new Setting(containerEl)
      .setName("Personal calendar events in itslearning")
      .setDesc("One event per lesson and assignment deadline, with the full lesson plan. ItsWiz only touches events it created itself. The command \"Remove all ItsWiz calendar events\" deletes them again. Only shows events from courses you have starred in itslearning.")
      .addToggle((t) => t.setValue(s.enableCalendarSync ?? false).onChange((v) => ((s.enableCalendarSync = v), save())));
    containerEl.createEl("h3", { text: "Hold Course" });
    new Setting(containerEl)
      .setName("Sync to Hold Course")
      .setDesc("Lesson plans, materials and assignments are written into Hold Course, and the Boox copy is kept up to date.")
      .addToggle((t) => t.setValue(s.enableHoldCourseSync ?? false).onChange((v) => ((s.enableHoldCourseSync = v), save(), v && scheduleHoldCourseSync(0))));
    const tokenDesc = createFragment((f) => {
      f.appendText("Get one at ");
      f.createEl("a", { text: "mineru.net", href: MINERU_TOKEN_URL });
      f.appendText(" (log in → API → token).");
    });
    new Setting(containerEl)
      .setName("MinerU key")
      .setDesc(tokenDesc)
      .addText((t) => {
        t.inputEl.type = "password";
        t.setValue(mineruToken()).onChange((v) => this.app.saveLocalStorage(MINERU_TOKEN_KEY, v.trim() || null));
      })
      .addButton((b) =>
        b.setButtonText("Test key").onClick(async () => {
          const ok = mineruToken() && (await testMineruToken(mineruToken()).catch(() => false));
          new Notice(ok ? "ItsWiz: the MinerU key works." : "ItsWiz: MinerU rejected the key.");
        })
      );
    new Setting(containerEl)
      .setName("PDFable-program")
      .setDesc("Optional. Path to the PDFable program (the pdfable file), which straightens skewed, rotated and double-page scans before MinerU and writes a small reading copy to _attachments/ next to the note. Empty: the original is uploaded and copied to _attachments/.")
      .addText((t) => t.setPlaceholder("/path/to/pdfable").setValue(pdfablePath()).onChange((v) => this.app.saveLocalStorage(PDFABLE_PATH_KEY, v.trim() || null)));
  }
}

class ItsWizPlugin extends Plugin {
  async onload() {
    plugin = this;
    this.data = Object.assign(
      { downloadedElementIds: [], planNoteContentHashes: {}, syncedFrontmatterVersion: null, settings: {}, calendarEventMap: {}, calendarDeleteQueue: [] },
      await this.loadData()
    );
    if (migrateSelectedCourses(this.data.settings)) await this.saveData(this.data);
    applyRoots(this.data.settings);
    applyCourseNames(this.data.settings);
    this.registerView(VIEW_TYPE, (leaf) => new ItsWizView(leaf, this));
    this.addRibbonIcon("wand-sparkles", "ItsWiz", () => this.openView());
    this.addCommand({ id: "open", name: "Open itslearning", callback: () => this.openView() });
    this.addCommand({ id: "harvest", name: "Harvest now", callback: () => runCollectAndDownload() });
    this.addCommand({ id: "path-test", name: "Path test (one file per download route into ItsWiz-test/)", callback: () => runPathTest() });
    this.addCommand({ id: "remove-calendar", name: "Remove all ItsWiz calendar events", callback: () => removeAllCalendarEvents() });
    this.addCommand({ id: "import", name: "Import VIAstudyWiz data from the clipboard", callback: () => importExtensionData() });
    this.addSettingTab(new ItsWizSettingTab(this.app, this));
    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("mod-clickable");
    this.statusEl.onClickEvent(() => showRunErrors());
    updateStatusBar();
    this.app.workspace.onLayoutReady(() => {
      // Efter layout-ready: før det fyrer Obsidian "create" for hver eksisterende fil.
      this.registerEvent(this.app.vault.on("create", (f) => onVaultCreate(f)));
      // Moving a file into a RAW folder fires "rename", not "create". processDocument skips files that already have a note.
      this.registerEvent(this.app.vault.on("rename", (f) => onVaultCreate(f)));
      getSettings().then((st) => st.enableConversion && scanExisting());
      for (const ev of ["create", "modify", "delete"]) {
        this.registerEvent(this.app.vault.on(ev, (f) => touchesHoldCourseInput(f.path) && scheduleHoldCourseSync()));
      }
      this.registerEvent(this.app.vault.on("rename", (f, old) => (touchesHoldCourseInput(f.path) || touchesHoldCourseInput(old)) && scheduleHoldCourseSync()));
      scheduleHoldCourseSync();
      runCollectAndDownload({ auto: true });
    });
    this.convert = (path, opts) => processDocument(this.app.vault.getAbstractFileByPath(path), opts);
    this.syncHoldCourse = () => runHoldCourseSync();
    this.registerInterval(window.setInterval(() => tick(), KEEPALIVE_MINUTES * 60e3));
    this.registerInterval(window.setInterval(async () => {
      if ((await getSettings()).enableHoldCourseSync && !hcSyncRunning) syncBoox().catch((err) => console.error("ItsWiz: Boox sync failed:", err));
    }, BOOX_TICK_MS));
  }

  onunload() {
    closeHarvestWindow();
  }

  async openView() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
    return leaf.view;
  }
}

module.exports = ItsWizPlugin;

// Til node --test (test/_bootstrap.js): kun ren logik, ingen Obsidian/Electron.
Object.assign(module.exports, {
  sanitizeFilename,
  filterCourses,
  migrateSelectedCourses,
  extractExtension,
  enhedFolder,
  planNoteName,
  weekFolderName,
  courseFolderName,
  rawPath,
  mdPath,
  fileLink,
  mdTargets,
  copyTarget,
  pdfableArgs,
  hasMineruWarning,
  isDigitalPdf,
  parseTextReport,
  textRouteOk,
  layoutsOf,
  inRawBranch,
  applyRoots,
  applyCourseNames,
  courseDisplayName,
  ensureClass,
  forloebPath,
  fagColors,
  touchesHoldCourseInput,
  errorMarkerPath,
  materialeFrontmatter,
  carriedFields,
  appendUsedIn,
  provenPlanId,
  insertPageMarkers,
  runningHeader,
  conversionBody,
  joinedBody,
  pageRanges,
  pdfPageCount,
  unzip,
  officeToMarkdown,
  noteStubPath,
  planLiteratureText,
  matchLiteratureElements,
  forberedelseElements,
  holdCourseDoneForbTitles,
  spliceAutoSection,
  summarizeAutoChange,
  simpleHash,
  stripHtml,
  extractAssignmentFile,
  taskId,
  calendarItems,
  calendarActions,
  parseFrontmatter,
  fieldLines,
  keepLocation,
  wikilinkTarget,
  isPrepDay,
  appendFileListField,
  removeFileListLines,
  patchPendingMateriale,
  readPlans,
  readTasks,
  hhmm,
  ensureLecture,
  migrateNotesToDescription,
  stableKey,
  syncData,
  syncTaskCompletion,
  pruneDeadLinks,
  isoWeekOf,
  enhedFromLink,
  renderForloeb,
  stripGenereret,
  forloebMirrors,
  mergeBooxEdits,
});
