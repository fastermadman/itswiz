// ItsWiz spike: can Obsidian replace Chrome for the VIAstudyWiz harvest?
// Go/no-go test only. It proves (1) itslearning login inside an Obsidian webview, (2) the REST API
// with that session, (3) the PDF chain, (4) the Office chain (itslearning cache, native download or
// WOPI) — the four things background.js needs Chrome for. Writes only to ItsWiz-test/ in the vault.

const { Plugin, ItemView, Notice, requestUrl } = require('obsidian');

const VIEW_TYPE = 'itswiz-browser';
// Own partition: Electron allows one webRequest listener per event per session, and Obsidian's Web
// viewer already holds onBeforeRequest on its own partition (adblock), so sharing it would replace that.
const PARTITION = 'persist:itswiz';
const BASE = 'https://via.itslearning.com';
const OUT = 'ItsWiz-test';
const OFFICE_EXT = ['.docx', '.pptx', '.xlsx', '.doc', '.ppt', '.xls'];
const NON_FILE = new Set(['Link', 'Mappe', 'Arbejdsopgave', 'Afleveringsopgave']);
const WATCH_URLS = ['*://*.itslearning.com/*', '*://*.officeapps.live.com/*'];

function remote() {
  const electron = require('electron');
  return electron.remote || window.electron?.remote;
}

// Microsoft/itslearning login may refuse an "Electron/…" user agent; same stripping Obsidian's Web viewer does.
const UA = navigator.userAgent.split(' ').filter((t) => !/^(obsidian|electron)/i.test(t)).join(' ');

// Runs inside the itslearning page (same origin, same cookies) — a trimmed collectRangeInPage.
async function collectInPage(daysBack, daysForward) {
  const base = location.origin;
  async function json(url, opts) {
    const res = await fetch(url, opts);
    const type = res.headers.get('content-type') ?? '';
    if (!type.includes('application/json')) throw new Error(`Ikke-JSON fra ${url} (status ${res.status})`);
    return res.json();
  }
  const [starred, unstarred] = await Promise.all([
    json(`${base}/restapi/personal/courses/cards/starred/v1`),
    json(`${base}/restapi/personal/courses/cards/unstarred/v1`),
  ]);
  const courses = [...starred.EntityArray, ...unstarred.EntityArray];
  const now = Math.floor(Date.now() / 1000);
  const filter = JSON.stringify({ courseIds: courses.map((c) => c.CourseId), projectIds: [], personal: true, hierarchyIds: [] });
  const events = await json(`${base}/RestApi/calendar/myEvents`, {
    method: 'POST',
    headers: { 'x-requested-with': 'XMLHttpRequest', 'content-type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ filter, start: now - daysBack * 86400, end: now + daysForward * 86400 }),
  });
  const keys = new Set();
  for (const e of events) for (const id of e.PlanIds ?? []) keys.add(`${e.courseId}:${id}`);
  const plans = [];
  for (const key of keys) {
    const [courseId, planId] = key.split(':');
    try {
      plans.push(await json(`${base}/restapi/personal/course/${courseId}/plans/${planId}/v2?ChildId=0`));
    } catch {}
  }
  return {
    courseCount: courses.length,
    eventCount: events.length,
    elements: plans.flatMap((p) =>
      (p?.elements ?? []).map((e) => ({ id: e.id, title: e.title, typeName: e.typeName, url: e.url, courseName: p.courseName }))
    ),
  };
}

// One listener per webRequest event per session (Electron rule), fanned out to waiters.
// Installed only for the duration of a test run: each onBeforeRequest round-trips to this renderer.
class Net {
  constructor(ses) {
    this.ses = ses;
    this.waiters = new Set();
    ses.webRequest.onBeforeRequest({ urls: WATCH_URLS }, (details, callback) => {
      callback({});
      this.emit('before', details);
    });
    ses.webRequest.onCompleted({ urls: WATCH_URLS }, (details) => this.emit('completed', details));
    this.onDownload = (_event, item) => {
      const url = item.getURL();
      item.cancel();
      this.emit('download', { url });
    };
    ses.on('will-download', this.onDownload);
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

  // Resolves with match()'s first non-null result; a thrown error rejects.
  wait(kind, match, ms, label) {
    let waiter;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => waiter.done(new Error(`Timeout: ${label}`)), ms);
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
    return promise;
  }

  dispose() {
    this.ses.webRequest.onBeforeRequest(null);
    this.ses.webRequest.onCompleted(null);
    this.ses.removeListener('will-download', this.onDownload);
  }
}

function param(url, name) {
  try {
    return new URL(url).searchParams.get(name);
  } catch {
    return null;
  }
}

function hiddenWindow(url) {
  const win = new (remote().BrowserWindow)({ show: false, webPreferences: { partition: PARTITION } });
  win.loadURL(url, { userAgent: UA }).catch(() => {});
  return win;
}

// Kæde A: element page → PdfViewer/Viewer.aspx?FileDownloadUrl=…
async function resolvePdf(net, elementUrl, ms = 20000) {
  const hit = net.wait('before', (d) => (/platform\.itslearning\.com\/PdfViewer\/Viewer\.aspx/.test(d.url) ? param(d.url, 'FileDownloadUrl') : null), ms, 'intet PdfViewer-kald');
  const win = hiddenWindow(BASE + elementUrl);
  try {
    return { url: await hit, chain: 'PDF-kæden' };
  } finally {
    win.destroy();
  }
}

// Kæde B plus the two fallbacks background.js races: native download and the WOPI access_token.
async function resolveOffice(net, elementUrl, ms = 20000) {
  const native = net.wait('download', (d) => d.url, ms * 2, 'ingen native download');
  const wopi = net.wait('before', (d) => {
    if (!/officeapps\.live\.com/.test(d.url) || !d.uploadData) return null;
    const src = param(d.url, 'WOPISrc');
    const body = d.uploadData.map((p) => (p.bytes ? Buffer.from(p.bytes).toString() : '')).join('');
    const token = new URLSearchParams(body).get('access_token');
    return src && token ? `${src}/contents?access_token=${encodeURIComponent(token)}` : null;
  }, ms * 2, 'intet WOPI access_token');
  const fileView = net.wait('before', (d) => (/resource\.itslearning\.com\/File\/View\.aspx/.test(d.url) ? d.url : null), ms, 'intet File/View.aspx-kald');
  const win = hiddenWindow(BASE + elementUrl);
  const primary = (async () => {
    const viewUrl = await fileView;
    const lo = param(viewUrl, 'LearningObjectId');
    const loi = param(viewUrl, 'LearningObjectInstanceId');
    if (!lo || !loi) throw new Error(`Mangler LearningObjectId i ${viewUrl}`);
    const cache = net.wait('before', (d) => (/filecache\.itslearning\.com/.test(d.url) ? d.url : null), ms, 'intet filecache-kald');
    const refused = net.wait('completed', (d) => {
      if (/DownloadRedirect\.ashx/.test(d.url) && d.statusCode >= 400) throw new Error(`DownloadRedirect afvist (status ${d.statusCode})`);
      return null;
    }, ms, 'ingen afvisning');
    win.loadURL(`https://resource.itslearning.com/Proxy/DownloadRedirect.ashx?LearningObjectId=${lo}&LearningObjectInstanceId=${loi}`, { userAgent: UA }).catch(() => {});
    return Promise.race([cache, refused]);
  })();
  try {
    return await Promise.any([
      primary.then((url) => ({ url, chain: 'itslearnings filecache' })),
      native.then((url) => ({ url, chain: 'native download' })),
      wopi.then((url) => ({ url, chain: 'WOPI' })),
    ]);
  } catch (err) {
    throw new Error((err.errors ?? [err]).map((e) => e.message).join(' / '));
  } finally {
    win.destroy();
  }
}

function extensionFrom(url, fallbackTitle) {
  const fromTitle = fallbackTitle.toLowerCase().match(/\.[a-z0-9]{2,5}$/)?.[0];
  if (fromTitle) return fromTitle;
  const disposition = param(url, 'response-content-disposition') ?? '';
  return disposition.match(/filename="[^"]*(\.[a-z0-9]{2,5})"/i)?.[1]?.toLowerCase() ?? '';
}

class ItsWizView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'ItsWiz'; }
  getIcon() { return 'graduation-cap'; }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.style.cssText = 'display:flex;flex-direction:column;padding:0;height:100%';
    const bar = root.createDiv({ attr: { style: 'display:flex;gap:6px;align-items:center;padding:6px' } });
    bar.createEl('button', { text: '←' }).onclick = () => this.webview.canGoBack() && this.webview.goBack();
    bar.createEl('button', { text: '⟳' }).onclick = () => this.webview.reload();
    bar.createEl('button', { text: 'Kør test', cls: 'mod-cta' }).onclick = () => this.plugin.runTest();
    this.urlEl = bar.createSpan({ attr: { style: 'opacity:.6;font-size:12px;overflow:hidden;white-space:nowrap' } });
    this.webview = document.createElement('webview');
    this.webview.setAttribute('partition', PARTITION);
    this.webview.setAttribute('useragent', UA);
    this.webview.setAttribute('allowpopups', '');
    this.webview.setAttribute('src', BASE);
    this.webview.style.cssText = 'flex:1;width:100%';
    this.webview.addEventListener('did-navigate', (e) => (this.urlEl.textContent = e.url));
    root.appendChild(this.webview);
  }
}

module.exports = class ItsWizPlugin extends Plugin {
  async onload() {
    this.registerView(VIEW_TYPE, (leaf) => new ItsWizView(leaf, this));
    this.addRibbonIcon('graduation-cap', 'ItsWiz', () => this.openView());
    this.addCommand({ id: 'open', name: 'Åbn itslearning', callback: () => this.openView() });
    this.addCommand({ id: 'test', name: 'Kør go/no-go-test', callback: () => this.runTest() });
  }

  async openView() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeaf('tab');
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
    return leaf.view;
  }

  async runTest() {
    const view = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]?.view;
    let current = '';
    try {
      current = view?.webview?.getURL() ?? '';
    } catch {} // throws until the webview has emitted dom-ready
    if (!current.startsWith(BASE)) {
      new Notice('ItsWiz: åbn itslearning-fanen og log ind først.');
      this.openView();
      return;
    }
    const log = [`# ItsWiz go/no-go — ${new Date().toLocaleString('da-DK')}`, '', `Obsidian-UA: \`${UA}\``, ''];
    const step = (ok, text) => {
      log.push(`- ${ok ? '✅' : '❌'} ${text}`);
      console.log(`ItsWiz: ${ok ? 'OK' : 'FEJL'} ${text}`);
    };
    new Notice('ItsWiz: test kører…');
    let net;
    try {
      net = new Net(remote().session.fromPartition(PARTITION));
      step(true, 'Netværksopsnapning installeret på egen session (session.webRequest via remote)');
    } catch (err) {
      step(false, `Netværksopsnapning: ${err.message}`);
    }
    try {
      let data = await view.webview.executeJavaScript(`(${collectInPage})(14, 14)`);
      if (!data.elements.length) data = await view.webview.executeJavaScript(`(${collectInPage})(90, 30)`);
      step(true, `Login + REST API: ${data.courseCount} fag, ${data.eventCount} kalender-events, ${data.elements.length} plan-elementer`);
      const files = data.elements.filter((e) => !NON_FILE.has(e.typeName));
      const pdf = files.find((e) => e.title.toLowerCase().endsWith('.pdf'));
      const office = files.find((e) => OFFICE_EXT.some((x) => e.title.toLowerCase().endsWith(x)));
      const unknown = files.find((e) => !/\.[a-z0-9]{2,5}$/i.test(e.title));
      log.push('', `Fil-elementer fundet: ${files.length} (PDF: ${pdf ? 'ja' : 'nej'}, Office: ${office ? 'ja' : 'nej'}, uden endelse: ${unknown ? 'ja' : 'nej'})`, '');
      if (net) {
        await this.tryFile(log, step, 'PDF', pdf, () => resolvePdf(net, pdf.url));
        await this.tryFile(log, step, 'Office', office, () => resolveOffice(net, office.url));
        await this.tryFile(log, step, 'Uden endelse', unknown, () => resolvePdf(net, unknown.url, 10000).catch(() => resolveOffice(net, unknown.url)));
      }
    } catch (err) {
      step(false, `Login/REST API: ${err.message}`);
    } finally {
      net?.dispose();
    }
    const report = `${OUT}/rapport.md`;
    await this.ensureFolder(OUT);
    await this.app.vault.adapter.write(report, log.join('\n') + '\n');
    new Notice('ItsWiz: test færdig — se ItsWiz-test/rapport.md');
    this.app.workspace.openLinkText(report, '', 'split');
  }

  async tryFile(log, step, label, element, resolve) {
    if (!element) return step(false, `${label}: intet element af den type i vinduet, ikke testet`);
    try {
      const { url, chain } = await resolve();
      const res = await requestUrl({ url, throw: false });
      if (res.status >= 400) throw new Error(`hentning gav status ${res.status} (via ${chain})`);
      const ext = extensionFrom(url, element.title);
      const name = element.title.replace(/[\\/:*?"<>|]/g, '_').replace(/\.[a-z0-9]{2,5}$/i, '') + ext;
      await this.ensureFolder(OUT);
      await this.app.vault.adapter.writeBinary(`${OUT}/${name}`, res.arrayBuffer);
      step(true, `${label}: "${element.title}" hentet via ${chain}, ${res.arrayBuffer.byteLength} bytes → [[${OUT}/${name}]]`);
    } catch (err) {
      step(false, `${label}: "${element.title}" — ${err.message}`);
    }
  }

  async ensureFolder(path) {
    if (!(await this.app.vault.adapter.exists(path))) await this.app.vault.adapter.mkdir(path);
  }
};
