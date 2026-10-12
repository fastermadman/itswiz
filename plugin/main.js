// ItsWiz: VIAstudyWiz' itslearning-høst som Obsidian-plugin (milestone "ItsWiz: fra Chrome til Obsidian").
// Kun desktop. Ingen build, ingen dependencies. Logikken nedenfor er kopieret fra background.js
// (#239, plan i issue-kommentaren); background.js er frosset til den slettes i #244.

const { Plugin, ItemView, Modal, PluginSettingTab, Setting, Notice, TFile, TFolder, normalizePath, requestUrl } = require("obsidian");

// Vaultens to rodmapper hedder faktisk "🎓 FAG" og "📝 NOTER" (omdøbt manuelt i Finder for at
// gøre dem nemmere at få øje på), men var tidligere hardcodet som literal "FAG"/"NOTER" i hver
// enkelt sti-byggende funktion. getDirectoryHandle(navn, {create:true}) opretter en NY mappe hvis
// navnet ikke matcher præcis — uden disse konstanter ville næste kørsel altså have oprettet tomme
// "FAG"/"NOTER"-mapper ved siden af de rigtige, og fremtidigt indhold ville splittes over to
// steder (issue #63). Ret navnene her, ét sted, hvis rødderne nogensinde omdøbes igen.
const FAG_ROOT = "§ FAG";
const NOTER_ROOT = "✎ NOTER";

// #202: Hold Course-pluginets egen data.json, ikke en vaultsti under FAG_ROOT/NOTER_ROOT — læst
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
const FRONTMATTER_VERSION = 11; // 2 = forberedelse-feltet (#59), 3 = fjernet dato:-felt, 4 = plan_id: (#96), 5 = litteratur-case-fix (#44), 6 = litteratur_filer (#44), 7 = materiale_filer (#113), 8 = beskrivelse (#113), 9 = kun linke downloadede elementer (#129), 10 = [PLAN]-note pr. lektion (#184), 11 = forberedelse_tekst (#205)

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

  const courses = await fetchCourses();
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
    if (res.status >= 400) throw new Error(`CheckFileInfo svarede ${res.status}`);
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
// Bruges til `dato:`-frontmatterfeltet og til NOTER-grenens "<dato> - <emne>".
function weekFolderBase(plan) {
  return plan.start.slice(0, 10);
}

// Frontmatter-tid (issue #154): tre adskilte felter afledt af plan.start, i stedet for det gamle
// sammenblandede "uge: W38fre". Date.UTC(y,m,d) er tidszone-sikkert (i modsætning til
// new Date(<lokal streng>), jf. #135) — vi regner kun på kalenderdato, aldrig klokkeslæt.
const DAYS_DA = ["søndag", "mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag"];

function ymd(plan) {
  return plan.start.slice(0, 10).split("-").map(Number); // [y, m, d]
}

function isoWeek(plan) {
  const [y, m, d] = ymd(plan);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dayNum = dt.getUTCDay() || 7; // man=1 … søn=7
  dt.setUTCDate(dt.getUTCDate() + 4 - dayNum); // ISO: uge tilhører sin torsdag
  const yearStart = Date.UTC(dt.getUTCFullYear(), 0, 1);
  const week = Math.ceil((dt.getTime() - yearStart) / 86400000 / 7 + 1 / 7);
  return `${dt.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function weekdayDa(plan) {
  const [y, m, d] = ymd(plan);
  return DAYS_DA[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

// De tre tids-linjer der før var "uge: <dato>" — samme tre linjer i [PLAN]- og [NOTE]-frontmatter.
function timeFrontmatterLines(plan) {
  return [`uge: ${isoWeek(plan)}`, `ugedag: ${weekdayDa(plan)}`, `dato: ${weekFolderBase(plan)}`];
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
// TOPIC_DISPLAY_NAMES normaliserer forurenede topics (underviser-navne, logistik) — samme
// hånd-vedligeholdte mønster som COURSE_DISPLAY_NAMES.
function enhedFolder(plan) {
  const topic = plan.topic?.name?.trim();
  if (!topic) return weekFolderBase(plan);
  return sanitizeFilename(TOPIC_DISPLAY_NAMES[topic] ?? topic);
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
const FORB_HEADING = "## ⚒ Forberedelse";

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
  const labels = forberedelse.map((el) => `⚒ ${el.titel}`);
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
          !el.isCompleted && (afkrydsede.has(`⚒ ${el.titel}`) || holdCourseDone.has(el.titel))
        );
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
      ...timeFrontmatterLines(plan),
      ...(topic ? [`emne: "${topic}"`] : []),
      // uge er ISO (2026-W38), årstals-unik; ugedag/dato er egne felter (#154). start er stadig
      // den universelle kronologiske nøgle, samme lærepenge som Seminarium.base's sorteringsfejl (#65).
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

// issue #70: CustomActivity-siden er en almindelig WebForms-postback uden UpdatePanel, så et rent
// form-POST med de skjulte felter er nok — samme GET som fetchActivityBody allerede laver.
// Selvstændig funktion (ingen closures over ydre scope) fordi den injiceres i itslearning-fanen
// via chrome.scripting.executeScript, samme grund som fetchActivityBody kun kan køre i selve
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
    // Symbol-navnet er kun til selve mappestien — fag:-feltet nedenfor skal blive ved den rene
    // værdi (courseDisplayName), da Seminarium.base filtrerer eksakt på den (issue #63).
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
          recordError(`Lektion flyttet (${fagField}, ${prevRecord.weekFolder} → ${weekFolder}): `
            + `materialet blev IKKE flyttet — mappen deles med andre lektioner i samme enhed. Flyt manuelt i Obsidian hvis det skal følge med.`);
        } else {
          await moveDirInVault(`${FAG_ROOT}/${fag}/RAW/${prevRecord.weekFolder}`, `${FAG_ROOT}/${fag}/RAW/${weekFolder}`);
          runChangedNotes.push(`${prevRecord.weekFolder} → ${weekFolder} (${fagField}): lektion flyttet, vault-materialer fulgte med`);
        }
        await savePlanNoteRecord(noteId, prevRecord.hash, weekFolder);
        prevRecord = { hash: prevRecord.hash, weekFolder };
      } catch (err) {
        console.error(`VIAstudyWiz vault-flytning fejlede (${prevRecord.weekFolder} → ${weekFolder}):`, err);
        recordError(`Lektion flyttet (${fagField}, ${prevRecord.weekFolder} → ${weekFolder}): vault-materialer kunne ikke flyttes automatisk — ${err.message}`);
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
        if (el.typeName === "Link") return `- ${el.title} (link — åbn selve lektionsplanen i itslearning for at følge det)`;
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

    const frontmatter = [
      "---",
      `fag: ${fagField}`,
      ...timeFrontmatterLines(plan),
      ...(topic ? [`emne: "${topic}"`] : []),
      // uge/ugedag/dato er adskilte felter afledt af plan.start (#154). start/stop nedenfor har
      // klokkeslættet oveni og er den universelle kronologiske nøgle til Bases.
      // Lektionens rigtige tidspunkt (ikke lokale-bookingens) — se toGoogleDateTime/syncCalendar
      // for hvorfor plan.start/stop er den pålidelige kilde.
      `start: "${toGoogleDateTime(plan.start ?? "").replace("T", " ")}"`,
      `stop: "${toGoogleDateTime(plan.stop ?? "").replace("T", " ")}"`,
      // Kun til stede når kalenderevent'ets beskrivelse rent faktisk havde feltet (issue #118/
      // #124) — sync_hold_course.py skriver dem videre til Hold Course KUN når de afviger fra
      // klassens standard, så en manglende linje her er ikke tabt information, bare "ingen
      // afvigelse at rapportere".
      ...(plan.room ? [`lokale: "${plan.room}"`] : []),
      ...(plan.teacher ? [`underviser: "${plan.teacher}"`] : []),
      `hentet: "${formatNow()}"`,
      "type: lektionsplan",
      // Samme stabile id som weekFolder-flytningen (issue #96) sporer på — synligt her frem for
      // kun i chrome.storage.local, så identiteten overlever en nulstillet extension-storage og
      // kan slås op direkte i vaulten (fx grep efter planKey for at rekonstruere cachen manuelt).
      `plan_id: "${planKey}"`,
      ...(literature ? yamlBlockLines("litteratur", `▥ ${literature}`) : ["litteratur: false"]),
      // Separat felt fra litteratur selv (issue #44, spørgsmål 1+3): litteratur-teksten er ofte en
      // ren grundbogshenvisning uden fil, så et match mod plan.elements er ikke garanteret — basen
      // skal kunne skelne "har litteratur OG en fundet fil" fra "har kun litteratur-tekst" uden at
      // parse brødteksten. `false` når matchLiteratureElements ikke fandt noget, samme mønster som
      // litteratur/forberedelse ovenfor.
      ...(literatureFiles.length
        ? yamlBlockLines("litteratur_filer", literatureFiles.map((el) => `📎 ${fileLink(courseName, weekFolder, el.title, existingIds.has(el.id))}`).join("\n"))
        : ["litteratur_filer: false"]),
      // Kun titlerne, ikke indholdet: Properties-panelet og basens kolonne skal kunne læses på et
      // blik, og selve teksten står i AUTO-sektionen nedenfor. `false` frem for at udelade feltet,
      // så basens formel kan bruge et eksplicit `!= false` i stedet for antaget truthiness — samme
      // mønster som `litteratur` lige ovenfor.
      ...(forberedelse.length
        ? yamlBlockLines("forberedelse", forberedelse.map((el) => `⚒ ${el.titel}`).join("\n"))
        : ["forberedelse: false"]),
      // #205: selve instruktionsteksten til feltet ovenfor — se kommentaren ved forberedelseTekst
      // for hvorfor den har sit eget felt. Samme `false`-mønster.
      ...(forberedelseTekst ? yamlBlockLines("forberedelse_tekst", forberedelseTekst) : ["forberedelse_tekst: false"]),
      // Alt vedhæftet fil-materiale der IKKE allerede står i litteratur_filer — dækker fag hvor
      // underviseren aldrig udfylder litteratur-feltet (se kommentaren ved materialeFiler ovenfor).
      // Samme false-mønster som de øvrige felter.
      ...(materialeFiler.length
        ? yamlBlockLines("materiale_filer", materialeFiler.map((el) => `📎 ${fileLink(courseName, weekFolder, el.title, existingIds.has(el.id))}`).join("\n"))
        : ["materiale_filer: false"]),
      ...(beskrivelse ? yamlBlockLines("beskrivelse", beskrivelse) : ["beskrivelse: false"]),
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
  // downloadedElementIds i chrome.storage.local for at se hvad der matcher.
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

// itslearning-topic -> mappenavn i RAW/MD (enhedFolder). Kun til at rydde op i forurenede
// topics — Musik har underviser-navne og logistik i topic-listen. Tom entry = brug topic som det er.
// Kandidater fundet i dry-run (migrate_to_enhed_mapper.py), Valdemar udfylder de rigtige mål:
//   "Underviser Klaus Glüsing", "Underviser Lone Sonne", "Anne Katrine Christensen" (underviser-navne)
//   "LMS KULTURFESTIVAL Silkeborg 2025", "Studietur", "Selvstudie", "Opfinderdag", "JEPPEs undervisning"
// Samme tabel speciles ind i migrate_to_enhed_mapper.py's TOPIC_OVERRIDES så migrering og
// fremadrettet skrivning er enige.
const TOPIC_DISPLAY_NAMES = {};

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

// ─── ItsWiz: erstatninger for chrome.* ──────────────────────────────────────────────────────────
// Alt over denne linje er kopieret fra background.js (frosset indtil #244), kun med de rettelser
// der er markeret "ItsWiz:". Alt herunder erstatter det Chrome gav: faner, webRequest, downloads,
// File System Access og chrome.storage.local.

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
  if (res.status >= 400) throw new Error(`HTTP ${res.status} ved hentning af ${url}`);
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

// ── Storage (afløser chrome.storage.local) ──

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
};

async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...plugin.data.settings };
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
  if (runErrorCount > 0) new Notice(`ItsWiz: ${runErrorCount} element(er) fejlede\n${capped(runErrorMessages, "mere")}`, 0);
  if (runFilesDownloaded === 0 && runChangedNotes.length === 0) return;
  const changed = runChangedNotes.length ? `\n\nÆndret:\n${capped(runChangedNotes, "note(r) mere")}` : "";
  new Notice(`ItsWiz: ${runFilesDownloaded} fil(er) hentet.${changed}`, 15000);
}

// ── Skjulte vinduer og netværksopsnapning (afløser chrome.tabs/webRequest/downloads) ──

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

// Afløser chrome.scripting.executeScript: kører en selvstændig funktion i itslearning-siden.
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
    if (!lo || !loi) throw new Error(`Mangler LearningObjectId/LearningObjectInstanceId i ${viewUrl}`);
    const cache = net.wait("before", (d) => (/filecache\.itslearning\.com/.test(d.url) ? d.url : null), timeoutMs, "intet filecache-kald");
    const refused = net.wait("completed", (d) => {
      if (/DownloadRedirect\.ashx/.test(d.url) && d.statusCode >= 400) throw new Error(`DownloadRedirect.ashx afvist af itslearning (status ${d.statusCode})`);
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
      recordError(`Kunne ikke markere "${el.titel}" som fuldført i itslearning: ${err.message}`);
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

async function downloadTaskAttachment(task, root = NOTER_ROOT) {
  if (!task.TaskUrl) return null;

  const win = hiddenWindow(task.TaskUrl);
  try {
    await waitForAssignmentToSettle(win.webContents.id, 20000);
    const frame = win.webContents.mainFrame.framesInSubtree.find((f) => f.url.includes(ASSIGNMENT_TOOL_HOST));
    if (!frame) throw new Error(`ingen ${ASSIGNMENT_TOOL_HOST}-frame i opgavesiden`);
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
    await writeToVault(`${root}/OPGAVER/${folder}/RAW/${rawName}`, `data:application/octet-stream;base64,${base64}`);
    runFilesDownloaded++;
    return `${root}/OPGAVER/${folder}/MD/${stem}.md`;
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

const LOGIN_ERROR = "Ikke logget ind på itslearning. Log ind i ItsWiz-fanen og prøv igen.";
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

async function collect(startUnix, endUnix) {
  // Udløbet login svarer 401 med JSON ("Accesstoken is empty, invalid or has expired."), målt
  // 2026-10-12, ikke kun en login-side som #134 så i Chrome.
  if (!(await isLoggedIn())) {
    if (!(await relogin())) throw new Error(LOGIN_ERROR);
    await loadStart();
  }
  try {
    return await inPage(collectRangeInPage, startUnix, endUnix);
  } catch (err) {
    // #134: et ikke-JSON-svar betyder næsten altid udløbet login.
    if (/Ikke-JSON/.test(err.message)) throw new Error(LOGIN_ERROR);
    throw err;
  }
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
    if (!auto) new Notice("ItsWiz: en kørsel er allerede i gang.");
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
      throw new Error("Vaulten har allerede VIAstudyWiz-noter. Kør \"Importér VIAstudyWiz-data fra udklipsholderen\" før første høst.");
    }
    if (!auto) new Notice("ItsWiz: høster…");
    const syncedVersion = plugin.data[FRONTMATTER_VERSION_KEY];
    const isBackfill = syncedVersion !== FRONTMATTER_VERSION;

    const { daysBack, daysForward } = await getSettings();
    const now = Math.floor(Date.now() / 1000);
    const start = now - (isBackfill ? BACKFILL_DAYS_BACK : daysBack) * 24 * 60 * 60;
    const end = now + daysForward * 24 * 60 * 60;
    if (isBackfill) {
      console.log(`VIAstudyWiz: frontmatter-version ${syncedVersion ?? "(ingen)"} -> ${FRONTMATTER_VERSION}, backfiller ${BACKFILL_DAYS_BACK} dage tilbage`);
    }
    await collectAndDownload(start, end);
    plugin.loginNotified = false;
    if (isBackfill) {
      plugin.data[FRONTMATTER_VERSION_KEY] = FRONTMATTER_VERSION;
      await plugin.saveData(plugin.data);
    }
  } catch (err) {
    console.error("VIAstudyWiz fejl:", err);
    if (err.message === LOGIN_ERROR) notifyLoginNeeded(auto);
    else new Notice(`ItsWiz: kørsel fejlede\n${err.message ?? err}`, 0);
    plugin.lastRun = { failure: err.message };
  } finally {
    // Seneste kørsel, til C (#240, statusbar) og til at aflæse en kørsel udefra (obsidian eval).
    plugin.lastRun = { ...plugin.lastRun, finishedAt: new Date().toISOString(), files: runFilesDownloaded, errors: runErrorMessages, changed: runChangedNotes };
    isRunning = false;
    updateStatusBar();
  }
}

// ── Statusbar: sidste kørsel og antal fejl, klik viser fejllisten ──

function updateStatusBar() {
  const el = plugin.statusEl;
  if (!el) return;
  const r = plugin.lastRun;
  if (isRunning) return el.setText("ItsWiz: høster…");
  if (!r) return el.setText("ItsWiz: ikke kørt");
  const time = new Date(r.finishedAt).toLocaleTimeString("da-DK", { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit" });
  const errors = (r.errors?.length ?? 0) + (r.failure ? 1 : 0);
  el.setText(`ItsWiz ${time}${r.failure ? " · fejlede" : errors ? ` · ${errors} fejl` : ""}`);
}

function showRunErrors() {
  const r = plugin.lastRun;
  const lines = [...(r?.failure ? [`Kørslen fejlede: ${r.failure}`] : []), ...(r?.errors ?? [])];
  const modal = new Modal(plugin.app);
  modal.titleEl.setText(r ? `ItsWiz: kørsel ${new Date(r.finishedAt).toLocaleString("da-DK", { timeZone: TIME_ZONE })}` : "ItsWiz: ikke kørt endnu");
  if (r) modal.contentEl.createEl("p", { text: `${r.files ?? 0} fil(er) hentet, ${r.changed?.length ?? 0} note(r) ændret.` });
  if (lines.length) modal.contentEl.createEl("pre", { text: lines.join("\n"), attr: { style: "white-space:pre-wrap" } });
  else if (r) modal.contentEl.createEl("p", { text: "Ingen fejl." });
  modal.open();
}

// ── Sti-test: én fil pr. download-vej til ItsWiz-test/, rører ikke § FAG eller ✎ NOTER ──

function officeChain(url) {
  if (/filecache\.itslearning\.com/.test(url)) return "itslearnings filecache";
  if (url.includes("/contents?access_token=")) return "WOPI";
  return "native download";
}

async function runPathTest(daysBack = 135, daysForward = 30) {
  if (isRunning) return new Notice("ItsWiz: en kørsel er allerede i gang.");
  isRunning = true;
  new Notice("ItsWiz: sti-test kører…");
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
  new Notice(`ItsWiz: sti-test færdig, se ${report}`);
  plugin.app.workspace.openLinkText(report, "", "split");
}

// ── Engangs-import fra extensionen ──
// Kør i extensionens service worker-konsol (chrome://extensions → VIAstudyWiz → service worker):
//   chrome.storage.local.get(null).then((d) => copy(JSON.stringify(d)))
// og så kommandoen "Importér VIAstudyWiz-data fra udklipsholderen" her. calendarEventMap hører
// til F (#243) og tages ikke med.
async function importExtensionData() {
  let src;
  try {
    src = JSON.parse(await navigator.clipboard.readText());
  } catch {
    return new Notice("ItsWiz: udklipsholderen indeholder ikke JSON fra extensionen. Kør snippet'et først.", 0);
  }
  if (!Array.isArray(src.downloadedElementIds) && !src.planNoteContentHashes) {
    return new Notice("ItsWiz: JSON'en ligner ikke VIAstudyWiz-data (mangler downloadedElementIds/planNoteContentHashes).", 0);
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
    `ItsWiz: importeret ${ids.size} hentede id'er, ${Object.keys(d.planNoteContentHashes).length} plan-hashes, frontmatter-version ${d.syncedFrontmatterVersion ?? "(ingen)"}.`,
    0
  );
}

// ── Konvertering: RAW → MinerU → MD (D, #241) ──
//
// Porteret fra watchfolder/watch_viastudywiz.py; kommentarerne dér forklarer hvorfor (#42, #99, #101,
// #103, #142, #148, #186, #232). Her står kun det der er anderledes i pluginet. MinerU er et tilvalg:
// uden token og uden "Konvertér RAW-filer" slået til sker intet, og [PLAN]-noterne linker til RAW (#241).

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
const AUTO_MATERIALER_RE = /^## Materialer\n([\s\S]*?)(?=\n## |\n<!-- AUTO:END|$(?![\s\S]))/m;
const HIGHLIGHT_RE = /==[^=\n]+==/;
const DAYS_DA_MON = ["mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag", "søndag"];

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

function inRawBranch(path) {
  return path.split("/").slice(0, -1).includes("RAW");
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

function timeFieldsFromStart(start) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/.exec(start.trim());
  if (!m) return {};
  const day = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const wd = (day.getUTCDay() + 6) % 7;
  const thursday = new Date(day.getTime() + (3 - wd) * 864e5);
  const week = Math.floor((thursday - Date.UTC(thursday.getUTCFullYear(), 0, 1)) / 864e5 / 7) + 1;
  return { uge: `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`, ugedag: DAYS_DA_MON[wd], dato: `${m[1]}-${m[2]}-${m[3]}` };
}

function plainFag(folderName) {
  for (const [name, symbol] of Object.entries(FOLDER_SYMBOLS)) if (folderName === `${symbol} ${name}`) return name;
  return folderName;
}

// Ren del af watcherens frontmatter(): planNotes er MD-ugemappens [PLAN]-noter, hentet = formatNow().
function materialeFrontmatter(rawFilePath, planNotes, hentet, extra = "") {
  const t = mdTargets(rawFilePath);
  const parts = rawFilePath.split("/");
  const folder = parts[parts.length - 2] ?? "";
  const folderEmne = folder.includes(" - ") ? folder.slice(folder.indexOf(" - ") + 3) : "";
  const fields = {};
  if (planNotes.length) {
    const text = planNoteFor(planNotes, `${stemName(stemOf(parts[parts.length - 1]))}.md`).text;
    for (const key of ["emne", "uge", "ugedag", "dato", "start", "stop"]) {
      const value = readFrontmatterField(text, key);
      if (value) fields[key] = value;
    }
  }
  const noFolderMeta = folder === "RAW" || /^(\d{4}-\d{2}-\d{2}|W\d{1,2}[a-zæøå]+)$/i.test(folder);
  const emne = fields.emne || folderEmne || (noFolderMeta ? "" : folder);
  let timeFields = Object.fromEntries(["uge", "ugedag", "dato"].filter((k) => k in fields).map((k) => [k, fields[k]]));
  if (!Object.keys(timeFields).length && fields.start) timeFields = timeFieldsFromStart(fields.start);

  const lines = [`fag: ${plainFag(t.fagFolder)}\n`];
  for (const k of ["uge", "ugedag", "dato"]) if (k in timeFields) lines.push(`${k}: ${timeFields[k]}\n`);
  lines.push("type: materiale\n", `kilde: "[[${rawFilePath}]]"\n`, `hentet: "${hentet}"\n`);
  if (emne) lines.push(`emne: "${emne}"\n`);
  for (const key of ["start", "stop"]) if (key in fields) lines.push(`${key}: "${fields[key]}"\n`);
  return "---\n" + lines.join("") + extra + "---\n\n";
}

// Bevar `lektion:` og `used_in:` ved genkonvertering (#186, #148).
function carriedFields(previousText) {
  if (previousText == null) return "";
  const fm = previousText.startsWith("---") ? previousText.split("---")[1] ?? "" : "";
  let out = "";
  const lektion = readFrontmatterField(fm, "lektion");
  if (lektion) out += `lektion: "${lektion}"\n`;
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
  if (fm.includes(entry) || readFrontmatterField(fm, "lektion") === planId) return null;
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

function insertPageMarkers(fullMd, blocks, layout) {
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
      pendingLabel = printedPageNumber(group) ?? String(pageIdx + 1);
      pendingFootnotes = pageFootnotes(group);
      searchPos = idx + anchor.length;
    }
  }
  if (pendingLabel != null) result = result.replace(/\n+$/, "") + formatPageMarker(pendingLabel, pendingFootnotes, false);
  return result;
}

// Zip-indhold → { body, sektion }: det watcherens write_conversion() skriver under frontmatteren.
function conversionBody(entries) {
  if (!entries.has("full.md")) throw new MineruError("MinerU-zippen mangler full.md");
  let md = entries.get("full.md").toString("utf8");
  let sektion = null;
  const contentListName = [...entries.keys()].find((n) => !n.includes("/") && n.endsWith("_content_list.json"));
  if (contentListName) {
    let blocks = null;
    try { blocks = JSON.parse(entries.get(contentListName).toString("utf8")); } catch {}
    if (blocks) {
      let layout = null;
      try { layout = entries.has("layout.json") ? JSON.parse(entries.get("layout.json").toString("utf8")) : null; } catch {}
      md = insertPageMarkers(md, blocks, layout);
      sektion = runningHeader(blocks);
    }
  }
  return { body: toWikilinks(md), sektion };
}

// MinerU-zips bruger kun stored/deflate (målt på cachen 2026-10-12), så Nodes zlib rækker.
// ponytail: ingen zip64; tilføjes hvis en zip nogensinde passerer 4 GB.
function unzip(arrayBuffer) {
  const zlib = require("zlib");
  const buf = Buffer.from(arrayBuffer);
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("ugyldig zip (ingen end-of-central-directory)");
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
      else throw new Error(`zip-metode ${method} understøttes ikke (${name})`);
    }
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return entries;
}

// ── MinerU-API og cache ──

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`timeout efter ${ms / 1000}s: ${what}`)), ms)))])
    .finally(() => clearTimeout(timer));
}

async function mineruRequest(token, method, path, body) {
  const res = await withTimeout(
    requestUrl({ url: `${MINERU_API}${path}`, method, headers: { Authorization: `Bearer ${token}` }, contentType: "application/json", body: body && JSON.stringify(body), throw: false }),
    30e3, path
  );
  if (res.status >= 400) throw new Error(`MinerU HTTP ${res.status} på ${path}`);
  return res.json;
}

// 200 = gyldig nøgle (svaret er "task not found"), 401 = ugyldig. Målt 2026-10-12.
async function testMineruToken(token) {
  const res = await requestUrl({ url: `${MINERU_API}/extract-results/batch/00000000-0000-0000-0000-000000000000`, headers: { Authorization: `Bearer ${token}` }, throw: false });
  return res.status === 200;
}

async function mineruConvert(token, fileName, dataId, bytes) {
  const resp = await mineruRequest(token, "POST", "/file-urls/batch", { files: [{ name: fileName, data_id: dataId }], model_version: "vlm" });
  if (resp.code !== 0) throw new MineruError(`file-urls/batch fejlede: ${JSON.stringify(resp)}`);
  const { batch_id: batchId, file_urls: [uploadUrl] } = resp.data;

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

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = (await mineruRequest(token, "GET", `/extract-results/batch/${batchId}`)).data.extract_result[0];
    if (result.state === "done") {
      const zip = await withTimeout(requestUrl({ url: result.full_zip_url, throw: false }), 120e3, "zip-download");
      if (zip.status >= 400) throw new Error(`zip-download HTTP ${zip.status}`);
      return zip.arrayBuffer;
    }
    if (result.state === "failed") throw new MineruError(`MinerU-fejl: ${result.err_msg}`);
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`timeout efter ${POLL_TIMEOUT_MS / 1000}s`);
}

// Samme mappe som watcheren, så dens zips genbruges (#99). Fejer forældede filer ved skrivning.
function cacheDir() {
  return require("path").join(require("os").homedir(), ".viastudywiz-cache");
}

function cachedZip(digest) {
  const fs = require("fs");
  const file = require("path").join(cacheDir(), `${digest}.zip`);
  try {
    if (Date.now() - fs.statSync(file).mtimeMs > CACHE_TTL_MS) return fs.unlinkSync(file), null;
    const b = fs.readFileSync(file);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
  } catch {
    return null;
  }
}

function writeCache(digest, arrayBuffer) {
  const fs = require("fs");
  const path = require("path");
  const dir = cacheDir();
  fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(dir)) {
    const f = path.join(dir, name);
    if (name.endsWith(".zip") && Date.now() - fs.statSync(f).mtimeMs > CACHE_TTL_MS) fs.unlinkSync(f);
  }
  fs.writeFileSync(path.join(dir, `${digest}.zip`), Buffer.from(arrayBuffer));
}

const sha256 = (arrayBuffer) => require("crypto").createHash("sha256").update(Buffer.from(arrayBuffer)).digest("hex");

// ── PDFable før MinerU (#241 trin 3; kontrakten ligger i FasterMadman/bitonalPDF#111) ──
//
// Retter skæve, liggende og dobbeltside-scans, som MinerU ellers læser i forkert rækkefølge (#211).
// Valgfrit som MinerU: uden programsti uploades originalen. Stien er pr. enhed (localStorage).

const PDFABLE_PATH_KEY = "itswiz-pdfable-path";
const PDFABLE_FLAGS = ["--rotate", "--crop", "--split", "auto", "--deskew"];
const PDFABLE_TIMEOUT_MS = 5 * 60e3;
const pdfablePath = () => plugin.app.loadLocalStorage(PDFABLE_PATH_KEY) ?? "";

// Den forbehandlede PDF, eller null (ingen sti, ikke en PDF, ingen fil skrevet, fejl), hvorefter
// originalen uploades. Originalen i RAW røres aldrig; kopien lever kun i en temp-mappe.
async function pdfable(file, bytes) {
  const bin = pdfablePath();
  if (!bin || file.extension.toLowerCase() !== "pdf") return null;
  const fs = require("fs");
  const path = require("path");
  const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "itswiz-pdfable-"));
  const input = path.join(dir, "in.pdf");
  const output = path.join(dir, "out.pdf");
  try {
    fs.writeFileSync(input, Buffer.from(bytes));
    const { code, stderr } = await new Promise((resolve) =>
      require("child_process").execFile(bin, [...PDFABLE_FLAGS, input, output], { timeout: PDFABLE_TIMEOUT_MS },
        (err, _stdout, stderr) => resolve({ code: err ? err.code ?? -1 : 0, stderr: String(stderr).trim() })));
    // Exit 2: PDF'en er skrevet, men nogle opslag blev ikke splittet. Uploades alligevel.
    if (code === 2) console.warn(`ItsWiz: PDFable usikker på sider i ${file.name}: ${stderr.split("\n").pop()}`);
    else if (code !== 0) {
      console.warn(`ItsWiz: PDFable fejlede på ${file.name} (exit ${code}), uploader originalen: ${stderr}`);
      return null;
    }
    if (!fs.existsSync(output)) return null;
    const b = fs.readFileSync(output);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── Vault-siden ──

async function planNotesIn(mdDir) {
  const folder = plugin.app.vault.getAbstractFileByPath(normalizePath(mdDir));
  if (!(folder instanceof TFolder)) return [];
  const files = folder.children.filter((f) => f instanceof TFile && f.extension === "md" && f.name.startsWith("[PLAN] "));
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return Promise.all(files.map(async (f) => ({ name: f.name, text: await plugin.app.vault.read(f) })));
}

// Byte-dublet i samme RAW-gren, hvis MD-note er en ægte `type: materiale` (#136/#148).
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
    if (text != null && readFrontmatterField(text, "type") === "materiale") return otherMd;
  }
  return null;
}

async function writeConversion(file, entries) {
  const t = mdTargets(file.path);
  const { body, sektion } = conversionBody(entries);
  const previous = await readFromVault(t.md);
  // #42: skriv ved siden af, hvis den eksisterende note har highlights.
  const protect = previous != null && HIGHLIGHT_RE.test(previous);
  const destMd = protect ? t.md.replace(/\.md$/, ".ny.md") : t.md;
  const destImages = protect ? `${t.images}.ny` : t.images;

  const planNotes = await planNotesIn(t.mdDir);
  const mdName = t.md.slice(t.md.lastIndexOf("/") + 1);
  let carried = carriedFields(previous);
  const owner = carried.includes("lektion:") ? null : provenPlanId(planNotes, mdName);
  if (owner) carried = `lektion: "${owner}"\n` + carried;
  const extra = (sektion ? `sektion: "${sektion}"\n` : "") + carried;
  await writeVaultFile(destMd, materialeFrontmatter(file.path, planNotes, formatNow(), extra) + body);

  const images = [...entries].filter(([n]) => n.startsWith("images/"));
  if (images.length) {
    const { adapter } = plugin.app.vault;
    if (await adapter.exists(normalizePath(destImages))) await adapter.rmdir(normalizePath(destImages), true);
    for (const [n, data] of images) await writeVaultFile(`${destImages}/${n.slice("images/".length)}`, data.buffer.slice(data.byteOffset, data.byteOffset + data.length));
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
    let zip = cachedZip(digest);
    if (zip) console.log(`ItsWiz: cache-hit, springer MinerU over: ${file.name}`);
    else {
      console.log(`ItsWiz: uploader til MinerU: ${file.name}`);
      // #250: MinerU afviser data_id over 128 bytes.
      const dataId = Buffer.from(stemName(file.basename)).subarray(0, 128).toString("utf8").replace(/�+$/, "");
      zip = await mineruConvert(mineruToken(), file.name, dataId, (await pdfable(file, bytes)) ?? bytes);
      writeCache(digest, zip);
    }
    await writeConversion(file, unzip(zip));
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
  const { enableConversion } = await getSettings();
  if (!enableConversion || !mineruToken() || !isConvertible(file) || queuedConversions.has(file.path)) return;
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

// ── Obsidian-delen ──

class ItsWizView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "ItsWiz"; }
  getIcon() { return "graduation-cap"; }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.style.cssText = "display:flex;flex-direction:column;padding:0;height:100%";
    const bar = root.createDiv({ attr: { style: "display:flex;gap:6px;align-items:center;padding:6px" } });
    bar.createEl("button", { text: "←" }).onclick = () => this.webview.canGoBack() && this.webview.goBack();
    bar.createEl("button", { text: "⟳" }).onclick = () => this.webview.reload();
    bar.createEl("button", { text: "Høst nu", cls: "mod-cta" }).onclick = () => runCollectAndDownload();
    bar.createEl("button", { text: "Sti-test" }).onclick = () => runPathTest();
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

class ItsWizSettingTab extends PluginSettingTab {
  display() {
    const { containerEl } = this;
    const s = this.plugin.data.settings;
    const save = () => this.plugin.saveData(this.plugin.data);
    containerEl.empty();
    for (const [key, name, desc] of [
      ["daysBack", "Dage tilbage", "Hvor langt tilbage hver kørsel kigger."],
      ["daysForward", "Dage frem", "Hvor langt frem hver kørsel kigger."],
      ["alarmIntervalHours", "Interval (timer)", "Automatisk kørsel ved Obsidian-start og derefter med dette interval."],
    ]) {
      new Setting(containerEl).setName(name).setDesc(desc).addText((t) =>
        t.setValue(String(s[key] ?? DEFAULT_SETTINGS[key])).onChange((v) => {
          if (Number.isFinite(Number(v)) && v.trim() !== "") (s[key] = Number(v)), save();
        })
      );
    }
    for (const [key, name, desc] of [
      ["enableFileDownloads", "Hent materialer og skriv noter", "Slået fra: kørslen henter kun data fra itslearning."],
      ["enableTaskCompletionSync", "Markér Forberedelse som fuldført i itslearning", "Afkrydset i [NOTE]-stubben eller Done i Hold Course (#70, #202)."],
    ]) {
      new Setting(containerEl).setName(name).setDesc(desc).addToggle((t) =>
        t.setValue(s[key] ?? DEFAULT_SETTINGS[key]).onChange((v) => ((s[key] = v), save()))
      );
    }

    containerEl.createEl("h3", { text: "Konvertering til markdown (MinerU)" });
    new Setting(containerEl)
      .setName("Konvertér RAW-filer")
      .setDesc("Sender nye PDF- og Office-filer under RAW/ til MinerU og skriver MD-noten. Valgfrit: slået fra linker lektionsplanerne til originalfilen. Slå først til, når watch_viastudywiz.py er stoppet, ellers konverteres hver fil to gange.")
      .addToggle((t) => t.setValue(s.enableConversion ?? false).onChange((v) => ((s.enableConversion = v), save(), v && scanExisting())));
    const tokenDesc = createFragment((f) => {
      f.appendText("Hentes på ");
      f.createEl("a", { text: "mineru.net", href: MINERU_TOKEN_URL });
      f.appendText(" (log ind → API → token).");
    });
    new Setting(containerEl)
      .setName("MinerU-nøgle")
      .setDesc(tokenDesc)
      .addText((t) => {
        t.inputEl.type = "password";
        t.setValue(mineruToken()).onChange((v) => this.app.saveLocalStorage(MINERU_TOKEN_KEY, v.trim() || null));
      })
      .addButton((b) =>
        b.setButtonText("Test nøgle").onClick(async () => {
          const ok = mineruToken() && (await testMineruToken(mineruToken()).catch(() => false));
          new Notice(ok ? "ItsWiz: MinerU-nøglen virker." : "ItsWiz: MinerU afviste nøglen.");
        })
      );
    new Setting(containerEl)
      .setName("PDFable-program")
      .setDesc("Valgfrit. Sti til PDFable (bitonalpdf), som retter skæve, liggende og dobbeltside-scans før MinerU. Tom: originalen uploades.")
      .addText((t) => t.setPlaceholder("/sti/til/bitonalpdf").setValue(pdfablePath()).onChange((v) => this.app.saveLocalStorage(PDFABLE_PATH_KEY, v.trim() || null)));
  }
}

class ItsWizPlugin extends Plugin {
  async onload() {
    plugin = this;
    this.data = Object.assign(
      { downloadedElementIds: [], planNoteContentHashes: {}, syncedFrontmatterVersion: null, settings: {} },
      await this.loadData()
    );
    this.registerView(VIEW_TYPE, (leaf) => new ItsWizView(leaf, this));
    this.addRibbonIcon("graduation-cap", "ItsWiz", () => this.openView());
    this.addCommand({ id: "open", name: "Åbn itslearning", callback: () => this.openView() });
    this.addCommand({ id: "harvest", name: "Høst nu", callback: () => runCollectAndDownload() });
    this.addCommand({ id: "path-test", name: "Sti-test (én fil pr. download-vej til ItsWiz-test/)", callback: () => runPathTest() });
    this.addCommand({ id: "import", name: "Importér VIAstudyWiz-data fra udklipsholderen", callback: () => importExtensionData() });
    this.addSettingTab(new ItsWizSettingTab(this.app, this));
    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("mod-clickable");
    this.statusEl.onClickEvent(() => showRunErrors());
    updateStatusBar();
    this.app.workspace.onLayoutReady(() => {
      // Efter layout-ready: før det fyrer Obsidian "create" for hver eksisterende fil.
      this.registerEvent(this.app.vault.on("create", (f) => onVaultCreate(f)));
      getSettings().then((st) => st.enableConversion && scanExisting());
      runCollectAndDownload({ auto: true });
    });
    this.convert = (path, opts) => processDocument(this.app.vault.getAbstractFileByPath(path), opts);
    this.registerInterval(window.setInterval(() => tick(), KEEPALIVE_MINUTES * 60e3));
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
  extractExtension,
  isoWeek,
  weekdayDa,
  enhedFolder,
  planNoteName,
  weekFolderName,
  courseFolderName,
  rawPath,
  mdPath,
  fileLink,
  mdTargets,
  errorMarkerPath,
  timeFieldsFromStart,
  materialeFrontmatter,
  carriedFields,
  appendUsedIn,
  provenPlanId,
  insertPageMarkers,
  runningHeader,
  conversionBody,
  unzip,
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
});
