import assert from 'node:assert/strict';

// Admit only synthetic messages, with execution disabled on the wire. This
// exercises the built UI/SDK and the real server without model or tool calls.
export async function checkPromptAdmission({ browser, page, base, session }) {
  const origin = new URL(page.url()).origin;
  const context = await browser.createBrowserContext();
  await context.setCookie({ name: 'ingress_session', value: session, domain: new URL(origin).hostname, path: '/' });
  const isolated = await context.newPage();
  let id;
  try {
    const created = await page.evaluate(async (base) => {
      const r = await fetch(base + 'api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Prompt admission regression', agent: 'build', location: { directory: '/run/opencode-v2/workspace' } }) });
      return { status: r.status, payload: await r.json() };
    }, base);
    assert.equal(created.status, 200);
    id = created.payload.data.id;
    const seeded = await page.evaluate(async (base, id) => {
      const r = await fetch(base + 'api/session/' + encodeURIComponent(id) + '/prompt', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Synthetic previous turn.', resume: false }) });
      return { status: r.status, payload: await r.json() };
    }, base, id);
    console.log('CHECK: raw prompt admission ' + JSON.stringify({ status: seeded.status, error: seeded.payload?._tag, message: seeded.payload?.message }));
    assert.equal(seeded.status, 200, 'Raw prompt admission: ' + JSON.stringify(seeded.payload));
    console.log('CHECK: raw prompt admitted without execution');
    const target = base + 'api/session/' + encodeURIComponent(id) + '/prompt';
    await isolated.setRequestInterception(true);
    isolated.on('request', request => {
      const pathname = new URL(request.url()).pathname;
      if (request.method() === 'POST' && pathname.endsWith('/prompt')) {
        if (pathname !== target) return void request.abort();
        const body = JSON.parse(request.postData() || '{}');
        console.log('CHECK: UI prompt field types ' + JSON.stringify(Object.fromEntries(Object.entries(body).map(([k,v]) => [k, v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v]))));
        return void request.continue({ postData: JSON.stringify({ ...body, resume: false }) });
      }
      void request.continue();
    });
    for (const text of ['Synthetic continuation turn.', 'Synthetic continuation after reload.']) {
      await isolated.goto(origin + base + '?session=' + encodeURIComponent(id), { waitUntil: 'domcontentloaded', timeout: 30000 });
      const editor = await isolated.waitForSelector('[data-testid="chat-input"] [contenteditable="true"]', { timeout: 30000 });
      await editor.click();
      await isolated.keyboard.type(text);
      const reply = isolated.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === target, { timeout: 20000 });
      await isolated.click('button[aria-label="Send message"]');
      const response = await reply;
      const payload = await response.json();
      assert.equal(response.status(), 200, 'Rendered continuation prompt: ' + JSON.stringify(payload));
      assert.equal(payload.data.payload.text, text, 'The complete UI prompt must arrive unchanged');
      assert.equal(payload.data.sessionID, id, 'Continue the existing session, not a replacement');
    }
    console.log('PASS: built UI continued the same session before and after reload through Ingress with execution disabled');
  } finally {
    await context.close();
    if (id) {
      const removed = await page.evaluate(async (base, id) => (await fetch(base + 'api/session/' + encodeURIComponent(id), { method: 'DELETE' })).ok, base, id);
      assert.equal(removed, true, 'Prompt regression session cleanup failed');
    }
  }
}
