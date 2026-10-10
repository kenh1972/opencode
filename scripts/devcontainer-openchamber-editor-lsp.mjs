import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import http from 'node:http';
import { once } from 'node:events';

// Chromium emits Fetch Metadata for trustworthy origins. Keep the browser on
// localhost without security-disabling flags, and forward through real Core
// Ingress with the original Host/Origin intact. This is test-only transport,
// bound to loopback and limited to this Ingress prefix; not an auth bypass.
export async function checkEditorLsp(options) {
  assert.match(options.base, /^\/api\/hassio_ingress\/[^/]+\/$/);
  const core = new URL(options.page.url());
  assert.equal(core.hostname, 'homeassistant');
  assert.equal(core.protocol, 'http:');
  const proxy = http.createServer((req, res) => {
    if (!req.url.startsWith(options.base)) { res.writeHead(404); res.end(); return; }
    const upstream = http.request({ hostname: core.hostname, port: core.port || 80,
      method: req.method, path: req.url, headers: req.headers }, (response) => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  try {
    await runEditorLsp({ ...options, origin: `http://127.0.0.1:${proxy.address().port}` });
  } finally {
    proxy.closeAllConnections();
    await new Promise((resolve) => proxy.close(resolve));
  }
}

// Render the actual pinned FilesView and CodeMirror build. Only the file provider,
// project/session list and preference persistence are fixtures: live-mode LSP
// POSTs must traverse Core Ingress and reach the real worker. No file is created.
// Call after the app is built/started by the main acceptance driver. This helper
// never starts/stops a service, toggles app options or obtains credentials.
async function runEditorLsp({ browser, page, base, session, origin, mode = 'live', artifactDirectory }) {
  assert.ok(['live', 'unavailable'].includes(mode), 'Editor acceptance mode must be live or unavailable');
  assert.match(base, /^\/api\/hassio_ingress\/[^/]+\/$/);
  const fixturePath = `/homeassistant/ha_editor_i1_${randomBytes(8).toString('hex')}.yaml`;
  const missing = `sensor.__ha_editor_i1_missing_${randomBytes(8).toString('hex')}`;
  const fixtureText = `entity_id: ${missing}`;
  const baseline = await page.evaluate(async (base) => {
    const response = await fetch(base + 'api/config/settings?surface=web', { signal: AbortSignal.timeout(10000) });
    return response.ok ? response.json() : null;
  }, base);
  assert.ok(baseline && typeof baseline === 'object' && !Array.isArray(baseline), 'Editor fixture needs readable settings');
  if (artifactDirectory) await mkdir(artifactDirectory, { recursive: true });

  async function createCase(readOnly = false) {
    const context = await browser.createBrowserContext();
    const isolated = await context.newPage();
    await isolated.setViewport({ width: 1440, height: 1000 });
    await context.setCookie({ name: 'ingress_session', value: session, domain: new URL(origin).hostname, path: '/' });
    const project = { id: 'ha-editor-i1-fixture', path: '/homeassistant', label: 'HA editor acceptance' };
    let settings = { ...baseline, projects: [project], activeProjectId: project.id,
      autoSaveEnabled: false, showOpenCodeUpdateNotifications: false, settingsDefaultFileViewerPreview: false };
    let simulateUnavailable = false;
    let blockedWrites = 0;
    const blockedWriteKinds = new Set();
    let interceptionFailed = false;
    const errors = [];
    const responses = [];
    const requests = [];
    const responseTasks = new Set();

    await isolated.evaluateOnNewDocument(({ fixturePath, fixtureText, project, readOnly }) => {
      const root = '/homeassistant';
      const tabId = `file:${fixturePath}`;
      const now = Date.now();
      localStorage.setItem('openchamber.i18n.v1', JSON.stringify({ locale: 'en' }));
      localStorage.setItem('lastDirectory', root);
      localStorage.setItem('homeDirectory', root);
      localStorage.setItem('projects', JSON.stringify([project]));
      localStorage.setItem('activeProjectId', project.id);
      localStorage.setItem('ui-store', JSON.stringify({ version: 21, state: {
        autoSaveEnabled: false, isSidebarOpen: false, contextEditorVisible: true,
        contextEditorTreeVisible: false, showOpenCodeUpdateNotifications: false,
        contextPanelByDirectory: { [root]: { isOpen: true, expanded: true, activeTabId: tabId,
          tabs: [{ id: tabId, mode: 'file', targetPath: fixturePath, dedupeKey: fixturePath,
            targetDirectory: null, projectPlanId: null, projectPlanRef: null,
            label: null, sessionTitleFallback: null, readOnly, stagedDiff: false, diffScope: 'working', touchedAt: now }],
          widthByMode: { file: 1000 }, widthFractionByMode: { file: 0.8 }, touchedAt: now } },
      } }));
      localStorage.setItem('files-view-tabs-store', JSON.stringify({ version: 3, state: {
        activeRuntimeKey: 'local', runtimeSnapshots: { local: { updatedAt: now, byRoot: {
          [root]: { openPaths: [fixturePath], selectedPath: fixturePath, expandedPaths: [], touchedAt: now },
        } } },
      } }));

      // Upstream web/main assigns this before mounting the real React app.
      // Replacing only FilesAPI avoids disk writes and exercises the genuine
      // canEdit=false path when writeFile is unavailable in the read-only case.
      window.__haEditorFixture = { installed: false, reads: 0, writes: 0 };
      let runtime;
      const deniedWrite = async () => { window.__haEditorFixture.writes++; throw new Error('Acceptance fixture is read-only'); };
      const checkPath = (path) => { if (path !== fixturePath) throw new Error('Outside acceptance fixture'); };
      Object.defineProperty(window, '__OPENCHAMBER_RUNTIME_APIS__', {
        configurable: true,
        get: () => runtime,
        set: (apis) => {
          runtime = { ...apis, files: {
            listDirectory: async (directory) => ({ directory, entries: directory === root
              ? [{ path: fixturePath, name: fixturePath.split('/').pop(), isDirectory: false, size: fixtureText.length }] : [] }),
            search: async () => [{ path: fixturePath }],
            readFile: async (path) => { checkPath(path); window.__haEditorFixture.reads++; return { path, content: fixtureText }; },
            statFile: async (path) => { checkPath(path); return { path, isFile: true, size: fixtureText.length, mtimeMs: 1 }; },
            createDirectory: deniedWrite, delete: deniedWrite, rename: deniedWrite, uploadFile: deniedWrite, execCommands: deniedWrite,
            ...(!readOnly ? { writeFile: deniedWrite } : {}),
          } };
          window.__haEditorFixture.installed = true;
        },
      });
    }, { fixturePath, fixtureText, project, readOnly });

    isolated.on('pageerror', (error) => errors.push(error.name));
    isolated.on('response', (response) => {
      const path = new URL(response.url()).pathname;
      if (![base + 'api/ha-editor-lsp/diagnostics', base + 'api/ha-editor-lsp/completions'].includes(path)) return;
      const task = (async () => {
        const body = JSON.parse(response.request().postData() || '{}');
        // Error bodies forwarded by Core need not be JSON or fully buffered.
        // The unavailable contract is the HTTP status, not an error-body read.
        const reply = response.ok() ? await response.json().catch(() => null) : null;
        responses.push({ operation: path.endsWith('/diagnostics') ? 'diagnostics' : 'completions',
          status: response.status(), text: body.text, version: body.version, editorId: body.editorId, reply });
      })().catch(() => { interceptionFailed = true; });
      responseTasks.add(task);
      void task.finally(() => responseTasks.delete(task));
    });
    await isolated.setRequestInterception(true);
    isolated.on('request', (request) => {
      void (async () => {
        const url = new URL(request.url());
        const method = request.method();
        const sameOrigin = url.origin === origin;
        if (sameOrigin && url.pathname === base + 'api/config/settings') {
          if (method === 'PUT') settings = { ...settings, ...JSON.parse(request.postData() || '{}'), autoSaveEnabled: false };
          else if (method !== 'GET') throw new Error('Unexpected settings fixture method');
          return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(settings) });
        }
        if (sameOrigin && method === 'GET' && url.pathname === base + 'api/session') {
          return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) });
        }
        // The app shell announces page visibility and attempts to mint asset URL
        // tokens even for this virtual text file. Keep both inside the fixture:
        // no server visibility mutation and no real or synthetic credential.
        if (sameOrigin && method === 'POST' && [base + 'api/push/visibility', base + 'api/tracked-items/interest'].includes(url.pathname)) {
          return request.respond({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
        }
        if (sameOrigin && method === 'POST' && url.pathname === base + 'auth/url-token') {
          return request.respond({ status: 403, contentType: 'application/json', body: '{"error":"Asset URL tokens are disabled in the isolated editor fixture"}' });
        }
        if (sameOrigin && method === 'POST' && [base + 'api/ha-editor-lsp/diagnostics', base + 'api/ha-editor-lsp/completions'].includes(url.pathname)) {
          const body = JSON.parse(request.postData() || '{}');
          assert.equal(body.path, fixturePath, 'Only the virtual fixture may reach the worker');
          assert.equal(typeof body.text, 'string', 'The editor must send its draft');
          assert.equal(readOnly, false, 'Read-only FilesView must not issue LSP requests');
          requests.push({ operation: url.pathname.endsWith('/diagnostics') ? 'diagnostics' : 'completions', text: body.text });
          if (simulateUnavailable) return request.respond({ status: 503, contentType: 'application/json',
            headers: { 'Cache-Control': 'no-store' }, body: '{"error":"Editor language service unavailable or request rejected"}' });
          return request.continue();
        }
        // Fail closed on every other mutating request. Even unexpected startup
        // writes cannot escape this isolated test into settings/files/app state.
        if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
          blockedWrites++;
          const relative = sameOrigin && url.pathname.startsWith(base) ? url.pathname.slice(base.length) : '[other-origin]';
          blockedWriteKinds.add(method + ' ' + relative.split('/').slice(0, 4).map((part) => /^[a-z][a-z-]{0,30}$/.test(part) ? part : '[id]').join('/'));
          return request.abort();
        }
        // FilesAPI is virtual; never allow fallback reads of user files either.
        if (sameOrigin && url.pathname.startsWith(base + 'api/fs/')) {
          return request.respond({ status: 403, contentType: 'application/json', body: '{"error":"Outside editor fixture"}' });
        }
        return request.continue();
      })().catch(async () => { interceptionFailed = true; await request.abort().catch(() => {}); });
    });

    async function close() {
      // Closing first aborts incomplete response bodies (including error/SSE
      // responses) so cleanup cannot hide an assertion behind a driver timeout.
      await context.close();
      await Promise.all([...responseTasks]);
    }
    try {
      const response = await isolated.goto(origin + base, { waitUntil: 'domcontentloaded', timeout: 30000 });
      assert.equal(response.status(), 200, 'Editor fixture must load through Core Ingress');
      // 2.2.0 starts a Chat draft independently of the selected project. Select
      // the fixture through the rendered picker so its context panel is active.
      const chooseProject = await isolated.waitForSelector('::-p-text(Choose project)', { timeout: 25000 });
      await chooseProject.evaluate(element => element.closest('button').focus());
      await isolated.keyboard.press('Enter');
      console.log('CHECK: editor project picker opened');
      await isolated.waitForFunction(() => [...document.querySelectorAll('[role="option"]')]
        .some(element => element.textContent.includes('HA editor acceptance')), { timeout: 10000 });
      await isolated.evaluate(() => [...document.querySelectorAll('[role="option"]')]
        .find(element => element.textContent.includes('HA editor acceptance')).click());
      console.log('CHECK: editor fixture project selected');
      await isolated.waitForFunction(() => window.__haEditorFixture?.installed && window.__haEditorFixture.reads > 0,
        { timeout: 25000 });
      return { isolated, requests, responses, close,
        unavailable: (value) => { simulateUnavailable = value; },
        verifyNoWrites: async () => {
          assert.equal(await isolated.evaluate(() => window.__haEditorFixture.writes), 0, 'Editor acceptance attempted a file write');
          if (blockedWrites) console.log('CHECK: editor blocked write kinds ' + JSON.stringify([...blockedWriteKinds]));
          assert.equal(blockedWrites, 0, 'Unexpected server write was blocked during editor acceptance');
          assert.equal(interceptionFailed, false, 'Editor fixture interception failed');
          assert.equal(errors.length, 0, `Editor page raised ${errors.length} JavaScript errors`);
        },
      };
    } catch (error) {
      const state = await isolated.evaluate(() => ({
        fixture: window.__haEditorFixture,
        editors: document.querySelectorAll('.cm-editor').length,
        rootChildren: document.querySelector('#root')?.children.length || 0,
        uiVersion: JSON.parse(localStorage.getItem('ui-store') || '{}').version,
        fixtureDirectorySelected: localStorage.getItem('lastDirectory') === '/homeassistant',
        projectSelected: localStorage.getItem('activeProjectId') === 'ha-editor-i1-fixture',
        fixturePanelPresent: Boolean(JSON.parse(localStorage.getItem('ui-store') || '{}').state?.contextPanelByDirectory?.['/homeassistant']),
      })).catch(() => null);
      if (artifactDirectory) await isolated.screenshot({ path: join(artifactDirectory, 'editor-initialization.png') }).catch(() => {});
      console.log('CHECK: editor initialization state ' + JSON.stringify({ ...state, errors, blockedWriteKinds: [...blockedWriteKinds] }));
      await close();
      // Do not include URLs, cookies, response bodies or backend errors in logs.
      throw new Error('Rendered editor fixture did not initialize; verify the pinned FilesView/store contracts', { cause: new Error(error.name) });
    }
  }

  const current = await createCase();
  console.log('CHECK: editor isolated file fixture loaded');
  try {
    const isolated = current.isolated;
    // The app may also mount unrelated CodeMirror instances (for example its
    // composer). Bind every interaction/assertion to the HA-enabled file editor.
    const content = await isolated.waitForSelector('.cm-editor:has(.cm-ha-lsp-status) .cm-content[contenteditable="true"]', { visible: true, timeout: 15000 });
    const editor = (await content.evaluateHandle((element) => element.closest('.cm-editor'))).asElement();
    assert.ok(editor, 'Visible editor must have a CodeMirror root');
    const textOfEditor = () => content.evaluate((element) =>
      [...element.querySelectorAll('.cm-line')].map((line) => line.textContent).join('\n'));
    async function draft(text) {
      await content.click();
      await isolated.keyboard.down('Control'); await isolated.keyboard.press('KeyA'); await isolated.keyboard.up('Control');
      await isolated.keyboard.sendCharacter(text);
      try {
        await isolated.waitForFunction((content, text) =>
          [...content.querySelectorAll('.cm-line')].map((line) => line.textContent).join('\n') === text,
        { timeout: 5000 }, content, text);
      } catch (error) {
        const state = await isolated.evaluate((expected) => {
          const editors = [...document.querySelectorAll('.cm-editor .cm-content[contenteditable="true"]')];
          return { activeTag: document.activeElement?.tagName, activeClass: document.activeElement?.className,
            editors: editors.map((editor) => { const lines = [...editor.querySelectorAll('.cm-line')]; const text = lines.map((line) => line.textContent).join('\n');
              return { lines: lines.length, length: text.length, expectedLength: expected.length, startsExpected: text.startsWith(expected), endsExpected: text.endsWith(expected) }; }) };
        }, text);
        console.log('CHECK: editor draft interaction ' + JSON.stringify(state));
        throw error;
      }
    }
    async function status(value) {
      try {
        await isolated.waitForFunction((editor, value) => [...editor.querySelectorAll('.cm-ha-lsp-status')].some((node) => node.textContent.includes(value)),
          { timeout: 22000 }, editor, value);
      } catch (error) {
        const state = await isolated.evaluate((selected) => ({ selectedConnected: selected.isConnected,
          editors: [...document.querySelectorAll('.cm-editor')].map((root) => ({ selected: root === selected,
            visible: root.getBoundingClientRect().width > 0 && root.getBoundingClientRect().height > 0,
            statuses: [...root.querySelectorAll('.cm-ha-lsp-status')].map((node) => node.textContent) })) }), editor);
        console.log('CHECK: editor status state ' + JSON.stringify({ ...state,
          responses: current.responses.map(({ operation, status, version }) => ({ operation, status, version })) }));
        throw error;
      }
    }
    async function screenshot(name) {
      if (artifactDirectory) await isolated.screenshot({ path: join(artifactDirectory, `editor-lsp-${name}.png`) });
    }
    async function completion(text, pattern, name) {
      await draft(text);
      await isolated.keyboard.down('Control'); await isolated.keyboard.press('Space'); await isolated.keyboard.up('Control');
      await editor.waitForSelector('.cm-tooltip-autocomplete .cm-completionLabel', { visible: true, timeout: 22000 });
      const labels = await editor.$$('.cm-tooltip-autocomplete .cm-completionLabel');
      let selected;
      for (const label of labels) {
        const value = await label.evaluate((node) => node.textContent);
        if (pattern.test(value)) { selected = { label, value }; break; }
      }
      assert.ok(selected, `No rendered live ${name} completion matched the requested value type`);
      await screenshot(name);
      await selected.label.click();
      return selected.value;
    }

    if (mode === 'unavailable') {
      await status('HA YAML: unavailable');
      console.log('CHECK: editor unavailable status rendered');
      console.log('CHECK: unavailable editor HTTP responses ' + JSON.stringify(current.responses.map(({ operation, status }) => ({ operation, status }))));
      assert.ok(current.responses.some((entry) => entry.operation === 'diagnostics' && entry.status === 503),
        'Unavailable mode requires a real HTTP 503 from the bridge, not a fixture response');
      await screenshot('worker-unavailable');
      console.log('PASS: rendered FilesView reports a real unavailable worker without saving its draft');
    } else {
      await status('HA YAML: checked');
      await editor.waitForSelector('.cm-lintRange-warning, .cm-lintRange-error', { visible: true, timeout: 5000 });
      assert.ok(current.responses.some((entry) => entry.operation === 'diagnostics' && entry.text === fixtureText && entry.status === 200
        && entry.reply?.items?.some((item) => item.message?.includes(missing))), 'Unknown-entity diagnostic must come from the live draft request');
      await screenshot('diagnostic');

      const entity = await completion('entity_id: ', /^[a-z_]+\.[a-z0-9_]+$/i, 'entity-completion');
      assert.equal(await textOfEditor(), `entity_id: ${entity}`, 'Completion must update the unsaved editor text');
      await status('HA YAML: checked');
      assert.equal(await editor.$$eval('.cm-lintRange-warning, .cm-lintRange-error', (nodes) => nodes.length), 0,
        'Correcting the unsaved entity must remove its diagnostic marks');
      assert.ok(current.responses.some((entry) => entry.operation === 'diagnostics' && entry.text === `entity_id: ${entity}`
        && entry.status === 200 && entry.reply?.items?.length === 0), 'Corrected draft needs its own clean live diagnostic response');
      await screenshot('corrected-unsaved');

      const service = await completion('actions:\n  - action: homeassistant.', /^homeassistant\.[a-z_]+$/, 'service-completion');
      assert.equal(await textOfEditor(), `actions:\n  - action: ${service}`, 'Service completion must replace the full dotted identifier');

      current.unavailable(true);
      await draft(`entity_id: ${entity}\n# controlled-unavailable`);
      await status('HA YAML: unavailable');
      await screenshot('controlled-unavailable');
      current.unavailable(false);
      await draft(`entity_id: ${entity}\n# restored-live-worker`);
      await status('HA YAML: checked');
      console.log('PASS: rendered live entity/service completion and corrected unsaved diagnostics through Core Ingress');
      console.log('PASS: rendered controlled-503 availability/recovery (worker was not stopped)');
    }
    await current.verifyNoWrites();
    console.log('CHECK: editor no-write assertions passed');
  } finally { await current.close(); }

  const readOnly = await createCase(true);
  console.log('CHECK: editor read-only file fixture loaded');
  try {
    await readOnly.isolated.waitForFunction((text) => document.body.textContent.includes(text), { timeout: 15000 }, missing);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(await readOnly.isolated.evaluate(() => typeof window.__OPENCHAMBER_RUNTIME_APIS__.files.writeFile), 'undefined',
      'Read-only fixture must exercise the real missing-write-capability branch');
    assert.equal(await readOnly.isolated.$$eval('[contenteditable="true"]', (nodes, marker) =>
      nodes.filter((node) => node.textContent.includes(marker)).length, missing), 0,
    'The rendered fixture document must not be editable (unrelated composer editors may remain editable)');
    assert.equal(readOnly.requests.length, 0, 'Read-only FilesView must not dispatch editor LSP requests');
    await readOnly.verifyNoWrites();
    console.log('PASS: rendered read-only FilesView issued no LSP requests or file/server writes');
  } finally { await readOnly.close(); }
}
