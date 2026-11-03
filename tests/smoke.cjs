/* Smoke test: opens the pickup page in a headless browser with a fake Firebase
   (tests/fake-firebase.js) and checks the main screens work without script errors.
   Run: node tests/smoke.cjs        (needs: npm i -D playwright && npx playwright install chromium)
   SHOTS=dir node tests/smoke.cjs   also saves screenshots there. */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake-firebase.js'), 'utf8');
const SHOTS = process.env.SHOTS || '';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.json': 'application/json' };

const now = Date.now();
const USER = { uid: 'u1', email: 'pat@acme.ca', displayName: 'Pat' };
const DATA = {
  users: { u1: { company_id: 'c1', profile: { name: 'Pat', phone: '2045550100' } } },
  companies: {
    c1: {
      name: 'Acme Supply', owner_uid: 'u1', join_code: 'ABCD2345',
      members: { u1: { name: 'Pat', email: 'pat@acme.ca', role: 'owner' } },
      address_book: { a1: { name: 'Acme Supply', address: '12 Main St', verified: false } }
    }
  },
  requests: {
    r1: { ref_no: 1201, status: 'new', company_id: 'c1', company_name: 'Acme Supply', customer_uid: 'u1', pickup: { name: 'Acme Supply', address: '12 Main St' }, delivery: { name: 'Smith Co', address: '40 Park Ave' }, items: [{ qty: 2, type: 'box' }], items_text: '2 boxes', payment: 'prepaid', when: 'asap', created_at: now - 25 * 60000 },
    r0: { ref_no: 1190, status: 'dispatched', company_id: 'c1', company_name: 'Acme Supply', customer_uid: 'u1', pickup: { name: 'Acme Supply', address: '12 Main St' }, delivery: { name: 'Lake Clinic' }, items_text: '1 box', payment: 'collect', created_at: now - 3 * 86400000, dispatched_at: now - 3 * 86400000 + 3600000 }
  },
  counters: { request_no: 1203 }
};

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
      if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' });
      fs.createReadStream(p).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

async function open(browser, url, fake) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // Storage starts empty once per test, and survives reloads within it
  await page.addInitScript((f) => { window.__FAKE = f; try { if (!sessionStorage.getItem('t')) { localStorage.clear(); sessionStorage.setItem('t', '1'); } } catch (e) { /* */ } }, fake);
  await page.route(/googleapis\.com|gstatic\.com\/(?!firebasejs)|cloudfunctions\.net/, (r) => r.abort());
  await page.route(/gstatic\.com\/firebasejs/, (r) => r.fulfill({ contentType: 'text/javascript', body: /firebase-app-compat/.test(r.request().url()) ? FAKE : '' }));
  await page.goto(url);
  return { page, errors, ctx };
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `pickup-${name}.png`) }); };

(async () => {
  const srv = await serve();
  const base = `http://127.0.0.1:${srv.address().port}/index.html`;
  const browser = await chromium.launch();
  try {
    // Signed out: errors show under the field and are tied to it
    {
      const { page, errors, ctx } = await open(browser, base, { user: null, data: DATA });
      await page.waitForSelector('#view-auth:not([hidden])');
      await page.click('#auth-submit');
      assert.strictEqual(await page.textContent('#auth-email-err'), 'Enter a valid email address.');
      assert.strictEqual(await page.getAttribute('#auth-email', 'aria-invalid'), 'true');
      assert.match(await page.getAttribute('#auth-email', 'aria-describedby'), /auth-email-err/);
      await page.fill('#auth-email', 'p');
      assert.strictEqual(await page.locator('#auth-email-err').count(), 0, 'typing clears the error');
      assert.deepStrictEqual(errors, [], 'no script errors on the sign-in screen');
      await ctx.close();
    }
    // Signed in, but the database never answers: the "can't reach" screen, not the sign-in page
    {
      const { page, errors, ctx } = await open(browser, base, { user: USER, data: DATA, hangReads: true });
      await page.waitForSelector('#view-offline:not([hidden])', { timeout: 15000 });
      assert.ok(await page.isVisible('#offline-call'), 'offers to call dispatch');
      await shot(page, 'offline');
      assert.deepStrictEqual(errors, [], 'no script errors on the offline screen');
      await ctx.close();
    }
    const { page, errors, ctx } = await open(browser, base, { user: USER, data: DATA });
    await page.waitForSelector('#view-app:not([hidden])');
    assert.strictEqual((await page.textContent('#new-repeat-latest')).trim(), 'Repeat last');
    // 2.1 an unsent request comes back after the app is closed
    await page.fill('#pickup-name', 'Acme Supply');
    await page.waitForFunction(() => localStorage.getItem('ec_draft_u1_c1'));
    await page.reload();
    await page.waitForSelector('#draft-banner:not([hidden])');
    await shot(page, 'draft');
    await page.click('[data-act=draft-continue]');
    assert.strictEqual(await page.inputValue('#pickup-name'), 'Acme Supply');
    // 3.2 / 3.7 Review with a missing address: the error is tied to the field and the field gets one nudge
    await page.click('#btn-review');
    await page.waitForSelector('#pickup-address-err');
    assert.strictEqual(await page.getAttribute('#pickup-address', 'aria-invalid'), 'true');
    assert.ok(await page.evaluate(() => !!document.querySelector('.field.nudge')), 'first problem is nudged');
    await page.fill('#pickup-address', '12 Main St');
    await page.check('input[name=payment][value=prepaid]', { force: true });
    // 2.2 the same pickup was sent 25 minutes ago and hasn't been dispatched
    await page.click('#btn-review');
    await page.waitForSelector('#sheet:not([hidden]) #btn-send');
    assert.match(await page.textContent('#sheet-body'), /You already sent a pickup from Acme Supply 25 min ago \(#1201\)/);
    assert.ok(await page.evaluate(() => document.getElementById('view-app').inert), '3.3 page behind the sheet is inert');
    await page.waitForTimeout(400);
    await shot(page, 'duplicate');
    await page.click('#btn-send');
    await page.waitForSelector('#sent-wrap:not([hidden]) .ticket');
    assert.strictEqual((await page.textContent('.ticket-no')).trim(), '#1204');
    assert.ok(!(await page.evaluate(() => document.getElementById('view-app').inert)), 'page usable again after the sheet closes');
    assert.strictEqual(await page.evaluate(() => localStorage.getItem('ec_draft_u1_c1')), null, 'draft cleared once sent');
    assert.ok(await page.isVisible('[data-act=share-ticket]'), '2.4 share button on the ticket');
    await page.waitForTimeout(800);
    await shot(page, 'sent');
    // History: the arrow is read as "to"; a backwards custom range is swapped
    await page.click('.tab[data-nav=history]');
    await page.waitForSelector('#hist-list .row');
    assert.match(await page.textContent('#hist-list .row .sr-only'), / to /);
    await page.selectOption('#hist-period', 'custom');
    await page.fill('#hist-from', '2026-03-01');
    await page.fill('#hist-to', '2026-02-01');
    assert.deepStrictEqual([await page.inputValue('#hist-from'), await page.inputValue('#hist-to')], ['2026-02-01', '2026-03-01'], 'backwards range swapped');
    assert.strictEqual(await page.evaluate(() => getComputedStyle(document.getElementById('hist-period')).fontSize), '16px', '3.6 no zoom on iPhone');
    // 2.9 import contacts from a CSV
    await page.click('.tab[data-nav=contacts]');
    await page.setInputFiles('#contacts-file', { name: 'customers.csv', mimeType: 'text/csv', buffer: Buffer.from('Name,Address,City,Phone\r\nWestman Tire,200 18th St,Brandon,204-555-0199\r\nAcme Supply,12 Main St,,\r\n,No Name Rd,,\r\n"Lake Clinic, East",5 Lake Rd,Brandon,\r\n') });
    await page.waitForSelector('#imp-go');
    assert.match(await page.textContent('#sheet-body'), /2 new contacts to add[\s\S]*1 row already in your contacts[\s\S]*1 row without a name or address/);
    await shot(page, 'import');
    await page.click('#imp-go');
    await page.waitForFunction(() => Object.values(window.__fakeDb.get('companies/c1/address_book')).length === 3);
    const book = await page.evaluate(() => Object.values(window.__fakeDb.get('companies/c1/address_book')));
    const westman = book.find((c) => c.name === 'Westman Tire');
    assert.strictEqual(westman.address, '200 18th St, Brandon');
    assert.strictEqual(westman.phone, '(204) 555-0199');
    assert.ok(book.some((c) => c.name === 'Lake Clinic, East'), 'quoted commas kept');
    // 3.9 a deleted contact can be brought back
    await page.waitForSelector('#sheet[hidden]', { state: 'attached' });
    await page.click('#contacts-list .contact-row:has-text("Westman Tire")');
    await page.click('#ct-delete');
    await page.click('#sheet-body [data-confirm="1"]');
    await page.waitForSelector('.toast .toast-act');
    assert.ok(!Object.values(await page.evaluate(() => window.__fakeDb.get('companies/c1/address_book'))).some((c) => c.name === 'Westman Tire'));
    await page.click('.toast .toast-act');
    await page.waitForFunction(() => Object.values(window.__fakeDb.get('companies/c1/address_book')).some((c) => c.name === 'Westman Tire'));
    // 3.10 theme follows the phone by default
    await page.click('.tab[data-nav=account]');
    assert.ok(await page.isChecked('input[name=theme][value=system]'), 'Match phone is the default');
    await page.check('input[name=theme][value=dark]', { force: true });
    assert.strictEqual(await page.getAttribute('html', 'data-theme'), 'dark');
    await page.check('input[name=theme][value=system]', { force: true });
    assert.strictEqual(await page.evaluate(() => localStorage.getItem('ec_theme_pref')), null);
    assert.deepStrictEqual(errors, [], 'no script errors');
    await ctx.close();

    // 2.3 home-screen shortcut "Repeat last" fills in the latest request
    {
      const { page: p2, errors: e2, ctx: c2 } = await open(browser, `${base}?go=repeat`, { user: USER, data: DATA });
      await p2.waitForFunction(() => document.getElementById('pickup-name').value === 'Acme Supply');
      assert.strictEqual(await p2.inputValue('#delivery-name'), 'Smith Co');
      assert.ok(!(await p2.evaluate(() => location.search)), 'the ?go= is removed from the address');
      assert.deepStrictEqual(e2, [], 'no script errors from the shortcut');
      await c2.close();
    }
    // 1.5 History loads one period at a time once dispatch has filled in the history keys
    const key = (cid, ms) => `${cid}~${String(ms).padStart(13, '0')}`;
    const keyed = JSON.parse(JSON.stringify(DATA));
    keyed.config = { history_keys_ready: true };
    Object.values(keyed.requests).forEach((r) => { r.company_created = key(r.company_id, r.created_at); });
    const oldAt = now - 400 * 86400000;
    keyed.requests.r9 = { ref_no: 1001, status: 'dispatched', company_id: 'c1', company_name: 'Acme Supply', customer_uid: 'u1', pickup: { name: 'Acme Supply', address: '12 Main St' }, delivery: { name: 'Old Co' }, items_text: '1 box', payment: 'prepaid', created_at: oldAt, dispatched_at: oldAt + 3600000, company_created: key('c1', oldAt) };
    keyed.requests.x1 = { ref_no: 1300, status: 'new', company_id: 'c1_x', company_name: 'Other', customer_uid: 'u9', pickup: { name: 'Other', address: '1 Elm' }, delivery: { name: 'Elsewhere' }, items_text: '1 box', payment: 'prepaid', created_at: now - 86400000, company_created: key('c1_x', now - 86400000) };
    {
      const { page: p3, errors: e3, ctx: c3 } = await open(browser, base, { user: USER, data: keyed });
      await p3.waitForSelector('#view-app:not([hidden])');
      await p3.waitForFunction(() => S.reqLoaded);
      assert.deepStrictEqual(await p3.evaluate(() => Object.keys(S.requests).sort()), ['r0', 'r1'], 'only recent requests of this company are loaded');
      await p3.click('.tab[data-nav=history]');
      await p3.selectOption('#hist-period', 'all');
      await p3.waitForSelector('#hist-list .req-no:has-text("#1001")');
      assert.deepStrictEqual(await p3.evaluate(() => Object.keys(S.requests).sort()), ['r0', 'r1', 'r9'], 'All time loads the older ones too');
      assert.doesNotMatch(await p3.textContent('#hist-summary'), /Loading/);
      // A new request carries its history key, so it shows up straight away
      await p3.click('.tab[data-nav=new]');
      await p3.fill('#pickup-name', 'Acme Supply');
      await p3.fill('#pickup-address', '12 Main St');
      await p3.fill('#delivery-name', 'Lake Clinic');
      await p3.check('input[name=payment][value=prepaid]', { force: true });
      await p3.click('#btn-review');
      await p3.waitForSelector('#sheet:not([hidden]) #btn-send');
      await p3.click('#btn-send');
      await p3.waitForSelector('#sent-wrap:not([hidden]) .ticket');
      const mine = await p3.evaluate(() => Object.values(window.__fakeDb.get('requests')).find((r) => r.ref_no === 1204));
      assert.match(mine.company_created, /^c1~\d{13}$/);
      await p3.waitForFunction(() => Object.values(S.requests).some((r) => r.ref_no === 1204));
      assert.deepStrictEqual(e3, [], 'no script errors in period-at-a-time History');
      await c3.close();
    }
    // Rules not updated yet: the new query is refused, so everything loads the old way
    {
      const { page: p4, errors: e4, ctx: c4 } = await open(browser, base, { user: USER, data: keyed, denyBy: ['company_created'] });
      await p4.waitForSelector('#view-app:not([hidden])');
      await p4.waitForFunction(() => S.reqLoaded);
      assert.deepStrictEqual(await p4.evaluate(() => Object.keys(S.requests).sort()), ['r0', 'r1', 'r9'], 'falls back to loading every request');
      assert.strictEqual(await p4.locator('.toast').count(), 0, 'no error shown for the fallback');
      assert.deepStrictEqual(e4, [], 'no script errors in the fallback');
      await c4.close();
    }
    console.log('pickup smoke test passed');
  } finally {
    await browser.close();
    srv.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
