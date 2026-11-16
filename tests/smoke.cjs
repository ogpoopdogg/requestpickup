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

const PHONE = { width: 390, height: 844 };
const DESK = { width: 1280, height: 900 };
async function open(browser, url, fake, viewport = PHONE) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, hasTouch: viewport === PHONE, serviceWorkers: 'block' });
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
      // Landing page: the intro's Create account button opens the sign-up form, and both Google buttons are there
      assert.strictEqual(await page.locator('#view-auth [data-act=google]').count(), 2, 'Google button in the intro and in the card');
      await page.click('.hero-cta [data-mode=create]');
      assert.strictEqual(await page.isVisible('#auth-confirm-wrap'), true, 'Create account shows the confirm password field');
      await page.click('#auth-mode-btn');
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
    // The full form and the review sheet, on a computer (phones get the guided steps, tested further down)
    const { page, errors, ctx } = await open(browser, base, { user: USER, data: DATA }, DESK);
    await page.waitForSelector('#view-app:not([hidden])');
    assert.strictEqual((await page.textContent('#new-repeat-latest')).trim(), 'Repeat last');
    assert.ok(await page.isVisible('.topbar .tabbar .tab[data-nav=history]'), 'menu in the top bar on a computer');
    assert.ok(await page.isVisible('#top-call[href^="tel:"]'), 'call dispatch from the top bar');
    await page.waitForSelector('#side-sum .btn');
    assert.ok(await page.isHidden('#btn-review'), 'the summary beside the form has the send button');
    await shot(page, 'desktop-form');
    // Payment starts on this person's last choice; phone, email, description, hours and PO wait behind "+"
    await page.waitForFunction(() => S.reqLoaded);
    assert.ok(await page.isChecked('input[name=payment][value=prepaid]'), 'payment starts on the last choice');
    assert.ok(await page.isHidden('#pickup-phone') && await page.isHidden('#po') && await page.isHidden('#item-details'), 'extras are tucked away');
    await page.click('[data-act=show-opt][data-opt=pickup-phone]');
    assert.ok(await page.isVisible('#pickup-phone'), '+ Phone opens the phone box');
    assert.ok(await page.isHidden('[data-act=show-opt][data-opt=pickup-phone]'), 'and its + button goes away');
    await page.click('[data-act=show-opt][data-opt=hours]');
    await page.fill('#ready-after', '14:00');
    await page.fill('#closes-at', '16:00');
    // Typing a name suggests this account's own contacts; a tap fills in the whole stop
    await page.fill('#delivery-name', 'acm');
    await page.waitForSelector('#delivery-name-ac:not([hidden]) .ac-item');
    assert.match(await page.textContent('#delivery-name-ac'), /Acme Supply[\s\S]*12 Main St/);
    await shot(page, 'contact-suggest');
    await page.click('#delivery-name-ac .ac-item');
    assert.strictEqual(await page.inputValue('#delivery-name'), 'Acme Supply');
    assert.strictEqual(await page.inputValue('#delivery-address'), '12 Main St');
    assert.ok(await page.isHidden('#delivery-name-ac'), 'list closes once picked');
    await page.fill('#delivery-name', 'zzz');
    assert.ok(await page.isHidden('#delivery-name-ac'), 'no list when nothing matches');
    await page.fill('#delivery-name', '');
    await page.fill('#delivery-address', '');
    // 2.1 an unsent request comes back after the app is closed
    await page.fill('#pickup-name', 'Acme Supply');
    await page.waitForTimeout(700); // the draft is saved half a second after typing stops
    await page.waitForFunction(() => localStorage.getItem('ec_draft_u1_c1'));
    await page.reload();
    await page.waitForSelector('#draft-banner:not([hidden])');
    await shot(page, 'draft');
    await page.click('[data-act=draft-continue]');
    assert.strictEqual(await page.inputValue('#pickup-name'), 'Acme Supply');
    // 3.2 / 3.7 Review with a missing address: the error is tied to the field and the field gets one nudge
    await page.click('#side-sum .btn');
    await page.waitForSelector('#pickup-address-err');
    assert.strictEqual(await page.getAttribute('#pickup-address', 'aria-invalid'), 'true');
    assert.ok(await page.evaluate(() => !!document.querySelector('.field.nudge')), 'first problem is nudged');
    await page.fill('#pickup-address', '12 Main St');
    await page.check('input[name=payment][value=prepaid]', { force: true });
    await page.waitForFunction(() => /Prepaid \(sender pays\)/.test(document.getElementById('side-sum').textContent));
    await page.waitForTimeout(400);
    await shot(page, 'desktop-filled');
    // 2.2 the same pickup was sent 25 minutes ago and hasn't been dispatched
    await page.click('#side-sum .btn');
    await page.waitForSelector('#sheet:not([hidden]) #btn-send');
    assert.match(await page.textContent('#sheet-body'), /You already sent a pickup from Acme Supply 25 min ago \(#1201\)/);
    // Outside 6:30 am to 5:00 pm, an "as soon as possible" request says when dispatch will see it
    assert.strictEqual(await page.evaluate(() => { const real = window.shopNowHM, realDay = window.shopTodayStr; window.shopTodayStr = () => '2026-11-18'; const out = ['06:29', '06:30', '16:59', '17:00'].map((t) => { window.shopNowHM = () => t; return afterHoursText(); }); window.shopNowHM = real; window.shopTodayStr = realDay; return out.map((t) => (t ? (/opens at 6:30 am/.test(t) ? 'before' : /closed for the day[\s\S]*6:30 am tomorrow/.test(t) ? 'after' : t) : 'open')).join(','); }), 'before,open,open,after');
    // Closed on weekends and Manitoba's general holidays; Friday evening says Monday
    assert.deepStrictEqual(await page.evaluate(() => {
      const real = window.shopNowHM, realDay = window.shopTodayStr;
      const at = (day, hm) => { window.shopTodayStr = () => day; window.shopNowHM = () => hm; return afterHoursText(); };
      const out = [at('2026-11-20', '17:30'), at('2026-11-21', '10:00'), at('2026-12-25', '10:00'), at('2026-11-18', '10:00')];
      window.shopNowHM = real; window.shopTodayStr = realDay;
      return out;
    }), [
      'Dispatch is closed for the day (open 6:30 am to 5:00 pm). They\u2019ll see this request at 6:30 am on Monday.',
      'Dispatch is closed for the weekend (open weekdays, 6:30 am to 5:00 pm). They\u2019ll see this request at 6:30 am on Monday.',
      'Dispatch is closed for Christmas Day (open weekdays, 6:30 am to 5:00 pm). They\u2019ll see this request at 6:30 am on Monday.',
      ''
    ]);
    // Holidays from the Manitoba Employment Standards list (2025 to 2027 dates from its table where it gives them)
    assert.deepStrictEqual(await page.evaluate(() => ['2025-04-18', '2026-04-03', '2027-03-26', '2025-05-19', '2026-05-18', '2027-05-24', '2026-02-16', '2026-09-07', '2026-09-30', '2026-10-12', '2026-12-26', '2026-11-11', '2026-04-06'].map((d) => shopClosedReason(d))),
      ['Good Friday', 'Good Friday', 'Good Friday', 'Victoria Day', 'Victoria Day', 'Victoria Day', 'Louis Riel Day', 'Labour Day', 'Truth and Reconciliation Day', 'Thanksgiving', 'the weekend', '', '']);
    assert.ok(await page.evaluate(() => document.getElementById('view-app').inert), '3.3 page behind the sheet is inert');
    await page.waitForTimeout(400);
    await shot(page, 'duplicate');
    await page.click('#btn-send');
    await page.waitForSelector('#sent-wrap:not([hidden]) .ticket');
    assert.strictEqual((await page.textContent('.ticket-no')).trim(), '#1204');
    assert.ok(!(await page.evaluate(() => document.getElementById('view-app').inert)), 'page usable again after the sheet closes');
    assert.strictEqual(await page.evaluate(() => localStorage.getItem('ec_draft_u1_c1')), null, 'draft cleared once sent');
    assert.ok(await page.isVisible('[data-act=share-ticket]'), '2.4 share button on the ticket');
    const sent = await page.evaluate(() => Object.entries(window.__fakeDb.get('requests')).find(([, r]) => r.ref_no === 1204));
    assert.strictEqual(sent[1].ready_after, '14:00');
    assert.strictEqual(sent[1].closes_at, '16:00');
    assert.strictEqual(sent[1].payment, 'prepaid');
    // What happens next: Sent, then Seen by dispatch, then Dispatched to a driver, live
    await page.waitForSelector('#sent-steps .steps');
    assert.strictEqual(await page.locator('#sent-steps .steps li.done').count(), 1);
    await page.evaluate((id) => window.__fakeDb.put(`requests/${id}/seen_at`, Date.now()), sent[0]);
    await page.waitForFunction(() => document.querySelectorAll('#sent-steps .steps li.done').length === 2);
    await page.waitForTimeout(800);
    await shot(page, 'sent');
    await page.click('[data-act=msg-sent]');
    await page.waitForSelector('#msgs-body #msg-about');
    assert.strictEqual(await page.inputValue('#msg-about'), sent[0], 'Messages opens on the pickup just sent');
    await page.waitForFunction(() => document.activeElement && document.activeElement.matches('#msgs-body textarea'));
    await page.evaluate(() => { msgAbout = ''; document.getElementById('msgs-body').innerHTML = ''; }); // back to the default pick for the checks below
    // History: the arrow is read as "to"; a backwards custom range is swapped
    await page.click('.tab[data-nav=history]');
    await page.waitForSelector('#hist-list .row');
    assert.match(await page.textContent('#hist-list .row .sr-only'), / to /);
    assert.ok(await page.locator('#hist-list .row-repeat').count() >= 3, 'Repeat on every row');
    assert.match(await page.textContent('#hist-list'), /Seen/);
    // A reply from dispatch: a chip on the row, and the thread in the request
    await page.evaluate(() => window.__fakeDb.put('messages/m1', { rid: 'r1', company_id: 'c1', ref_no: 1201, from: 'dispatch', text: 'A driver is on the way.', at: Date.now(), by_uid: 'staff1', by_name: 'dana' }));
    await page.waitForSelector('#hist-list .chip.msg');
    await page.click('#hist-list .row[data-id=r1]');
    await page.waitForSelector('#sheet-body .msgs .msg.them');
    await page.fill('#sheet-body form[data-msg-form] textarea', 'Thanks! Back door please.');
    await page.click('#sheet-body form[data-msg-form] button');
    await page.waitForFunction(() => Object.values(window.__fakeDb.get('messages')).some((m) => m.from === 'customer' && m.by_uid === 'u1' && m.company_id === 'c1' && m.rid === 'r1'));
    await page.waitForSelector('#sheet-body .msgs .msg.me');
    await page.waitForTimeout(300);
    await shot(page, 'messages');
    // Removed by dispatch: said plainly, with call or text
    await page.evaluate(() => { window.__fakeDb.put('requests/r1/status', 'removed'); window.__fakeDb.put('requests/r1/removed_at', Date.now()); });
    await page.waitForFunction(() => /Removed by dispatch/.test(document.getElementById('sheet-body').textContent));
    assert.ok(await page.isVisible('#sheet-body .call-row a[href^="tel:"]'), 'call dispatch');
    assert.ok(await page.isVisible('#sheet-body .call-row a[href^="sms:"]'), 'text dispatch');
    await shot(page, 'removed');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#sheet[hidden]', { state: 'attached' });
    assert.strictEqual(await page.locator('#hist-list .chip.msg').count(), 0, 'read once opened');
    // Messages tab: one conversation for the account, each message with its pickup number
    await page.evaluate(() => window.__fakeDb.put('messages/m2', { rid: 'r0', company_id: 'c1', ref_no: 1190, from: 'dispatch', text: 'Driver is 10 min out.', at: Date.now(), by_uid: 'staff1', by_name: 'dana' }));
    await page.waitForSelector('#msg-dot:not([hidden])');
    await page.click('.tab[data-nav=messages]');
    await page.waitForSelector('#msgs-body .msg.them');
    assert.ok(await page.isHidden('#msg-dot'), 'dot clears once the conversation is open');
    assert.match(await page.textContent('#msgs-body .msg-list'), /#1201[\s\S]*#1190/);
    assert.strictEqual(await page.inputValue('#msg-about'), 'r0', 'starts on the pickup dispatch last wrote about');
    assert.strictEqual(await page.locator('#toasts .toast.from-dispatch').count(), 0, 'dispatch pop-ups clear when Messages opens');
    assert.strictEqual((await page.textContent('#msgs-body .msg-day')).trim(), 'Today', 'day label above the messages');
    await page.fill('#msgs-body .msg-form textarea', 'one\ntwo\nthree');
    assert.ok(await page.evaluate(() => document.querySelector('#msgs-body .msg-form textarea').offsetHeight > 60), 'the box grows with longer messages');
    await page.fill('#msgs-body .msg-form textarea', '');
    await page.selectOption('#msg-about', 'r1');
    await page.fill('#msgs-body .msg-form textarea', 'Is the 1201 driver coming?');
    await page.press('#msgs-body .msg-form textarea', 'Enter');
    await page.waitForFunction(() => Object.values(window.__fakeDb.get('messages')).some((m) => m.text === 'Is the 1201 driver coming?' && m.rid === 'r1' && m.company_id === 'c1'));
    // A message that couldn't go out stays on screen with Try again, it doesn't vanish
    await page.evaluate(() => { Object.defineProperty(S, 'online', { get: () => false, set: () => {}, configurable: true }); });
    await page.fill('#msgs-body .msg-form textarea', 'Hello?');
    await page.press('#msgs-body .msg-form textarea', 'Enter');
    await page.waitForSelector('#msgs-body .msg.failed');
    await page.evaluate(() => { delete S.online; S.online = true; });
    await page.click('#msgs-body .msg.failed [data-act=msg-retry]');
    await page.waitForFunction(() => Object.values(window.__fakeDb.get('messages')).some((m) => m.text === 'Hello?'));
    await page.waitForFunction(() => !document.querySelector('#msgs-body .msg.failed'));
    // General: a message that isn't about any pickup
    await page.selectOption('#msg-about', 'general');
    await page.fill('#msgs-body .msg-form textarea', 'Are you open Saturday?');
    await page.press('#msgs-body .msg-form textarea', 'Enter');
    await page.waitForFunction(() => Object.values(window.__fakeDb.get('messages')).some((m) => m.text === 'Are you open Saturday?' && m.rid === 'general' && m.company_id === 'c1' && m.ref_no === null && m.from === 'customer'));
    await page.waitForFunction(() => [...document.querySelectorAll('#msgs-body .msg.me')].some((b) => /Saturday/.test(b.textContent) && b.querySelector('.msg-ref') && b.querySelector('.msg-ref').textContent === 'General'));
    await page.selectOption('#msg-about', 'r1');
    await page.evaluate(() => window.__fakeDb.put('messages/m3', { rid: 'general', company_id: 'c1', ref_no: null, from: 'dispatch', text: 'No, weekdays only.', at: Date.now(), by_uid: 'staff1', by_name: 'dana' }));
    await page.waitForFunction(() => /weekdays only/.test(document.querySelector('#msgs-body .msg-list').textContent));
    await page.evaluate(() => { msgAbout = ''; document.getElementById('msgs-body').innerHTML = ''; renderMessages(); }); // what a fresh open picks
    assert.strictEqual(await page.inputValue('#msg-about'), 'general', 'starts on General when dispatch last wrote a general message');
    assert.ok(await page.isHidden('#msg-dot'), 'a general reply counts as read while the conversation is open');
    await page.waitForTimeout(300);
    await shot(page, 'messages-tab');
    await page.click('#msgs-body .msg-ref >> nth=0');
    await page.waitForSelector('#sheet:not([hidden]) [data-detail]');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#sheet[hidden]', { state: 'attached' });
    await page.click('.tab[data-nav=history]');
    await page.click('#hist-status [data-status=removed]');
    assert.match(await page.textContent('#hist-list'), /#1201/, 'Removed filter shows removed pickups');
    assert.strictEqual(await page.locator('#hist-list .row').count(), 1);
    await page.click('#hist-status [data-status=all]');
    await page.evaluate(() => { document.getElementById('toasts').innerHTML = ''; }); // so later steps find their own toast
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
    // 3.10 theme is Light by default; Dark and Auto can still be picked
    await page.click('.tab[data-nav=account]');
    assert.ok(await page.isChecked('input[name=theme][value=light]'), 'Light is the default');
    assert.strictEqual(await page.getAttribute('html', 'data-theme'), 'light');
    await page.check('input[name=theme][value=dark]', { force: true });
    assert.strictEqual(await page.getAttribute('html', 'data-theme'), 'dark');
    await page.check('input[name=theme][value=system]', { force: true });
    assert.strictEqual(await page.evaluate(() => localStorage.getItem('ec_theme_pref')), 'system');
    await page.check('input[name=theme][value=light]', { force: true });
    assert.match(await page.textContent('#account-body'), /\(204\) 555-0100/, 'phone shown as (204) 555-0100');
    assert.ok(await page.isVisible('#account-body input[name=theme][value=system] + span:has-text("Auto")'));
    assert.match(await page.textContent('#account-body'), /Contact E&C[\s\S]*\(204\) 730-0945[\s\S]*6:30 am to 5:00 pm/);
    assert.ok(await page.isVisible('#account-body .contact-btns a[href^="tel:"]'), 'call from Account');
    await shot(page, 'account');
    // A long contact list gets A to Z down the side
    await page.evaluate(() => { const names = ['Alder', 'Birch', 'Cedar', 'Dogwood', 'Elm', 'Fir', 'Gum', 'Hazel', 'Ivy', 'Juniper', 'Kapok', 'Larch']; names.forEach((n, i) => window.__fakeDb.put(`companies/c1/address_book/z${i}`, { name: `${n} Co`, address: `${i + 1} Tree St` })); });
    await page.click('.tab[data-nav=contacts]');
    await page.waitForSelector('.az-index button[data-l=L]');
    await page.click('.az-index button[data-l=L]');
    await shot(page, 'contacts-az');
    assert.deepStrictEqual(errors, [], 'no script errors');
    await ctx.close();

    // Phones: one step at a time, with recent places a tap away
    {
      const { page: pg, errors: eg, ctx: cg } = await open(browser, base, { user: USER, data: DATA });
      await pg.waitForSelector('#view-app:not([hidden])');
      await pg.waitForFunction(() => S.reqLoaded);
      assert.ok((await pg.locator('.tabbar').evaluate((el) => getComputedStyle(el).backgroundColor)) !== 'rgba(0, 0, 0, 0)', 'solid bottom bar');
      assert.strictEqual((await pg.textContent('#guide-q')).trim(), 'Where are we picking up?');
      assert.strictEqual((await pg.textContent('#guide-step-txt')).trim(), 'Step 1 of 4');
      assert.ok(await pg.isHidden('#delivery-name') && await pg.isHidden('#items-block') && await pg.isHidden('#pay-block'), 'only the pickup step shows');
      assert.ok(await pg.isHidden('#btn-back'), 'no Back on the first step');
      assert.strictEqual((await pg.textContent('#top-call')).trim(), 'Call');
      await shot(pg, 'guided-1');
      // Next with nothing filled in: the pickup name is flagged, payment (step 4) is not
      await pg.click('#btn-review');
      await pg.waitForSelector('#pickup-name-err');
      assert.strictEqual(await pg.locator('#pay-field.invalid').count(), 0, 'later steps stay quiet');
      assert.strictEqual((await pg.textContent('#guide-step-txt')).trim(), 'Step 1 of 4');
      // A recent pickup place fills in the whole stop
      await pg.click('[data-recent=pickup] .recent-stop:has-text("Acme Supply")');
      assert.strictEqual(await pg.inputValue('#pickup-address'), '12 Main St');
      assert.ok(await pg.isHidden('[data-recent=pickup]'), 'the list goes once the stop is filled in');
      await pg.click('#btn-review');
      assert.strictEqual((await pg.textContent('#guide-q')).trim(), 'Where is it going?');
      assert.strictEqual((await pg.textContent('#btn-review')).trim(), 'Skip', 'an empty delivery can be skipped');
      assert.ok(await pg.isVisible('[data-recent=delivery] .recent-stop:has-text("Smith Co")'));
      await pg.fill('#delivery-name', 'Lake Clinic');
      assert.strictEqual((await pg.textContent('#btn-review')).trim(), 'Next');
      await pg.fill('#delivery-name', '');
      await pg.click('#btn-review');
      // Items: tap the type; weight and size wait behind a button
      assert.strictEqual((await pg.textContent('#guide-q')).trim(), 'What are we moving, and when?');
      assert.ok(await pg.isHidden('#item-rows [data-field=weight]'), 'weight tucked away');
      await pg.click('#item-rows .tchip:has-text("Pallets")');
      await pg.click('#item-rows [data-act=qty-inc]');
      await pg.click('#item-size-btn');
      await pg.fill('#item-rows [data-field=weight]', '300');
      assert.match(await pg.textContent('#items-preview'), /2 pallets/);
      assert.match(await pg.textContent('#next-day-btn'), /^Next business day: /);
      await shot(pg, 'guided-3');
      await pg.click('#btn-review');
      // Check and send: the summary, the warnings, payment on the last choice
      assert.strictEqual((await pg.textContent('#guide-q')).trim(), 'Check and send');
      assert.match(await pg.textContent('#check-sum'), /You already sent a pickup from Acme Supply 25 min ago \(#1201\)/);
      assert.match(await pg.textContent('#check-sum'), /Pickup\s*Acme Supply\s*12 Main St[\s\S]*Not set \(optional\)[\s\S]*2 pallets/);
      assert.ok(await pg.isChecked('input[name=payment][value=prepaid]'), 'payment starts on the last choice');
      assert.match(await pg.textContent('#pay-field'), /Sender pays[\s\S]*Recipient pays/);
      assert.strictEqual((await pg.textContent('#btn-review')).trim(), 'Send request');
      await pg.waitForTimeout(300);
      await shot(pg, 'guided-4');
      // Back, and the phone's back button, go one step back; a summary line jumps to its step
      await pg.click('#btn-back');
      await pg.waitForFunction(() => S.step === 3);
      await pg.click('#btn-review');
      await pg.goBack();
      await pg.waitForFunction(() => S.step === 3);
      await pg.click('#btn-review');
      await pg.click('#check-sum .check-row[data-go="1"]');
      assert.strictEqual((await pg.textContent('#guide-q')).trim(), 'Where are we picking up?');
      await pg.evaluate(() => setStep(4));
      await pg.click('#pay-field label:has-text("Collect")');
      await pg.click('#btn-review');
      await pg.waitForSelector('#sent-wrap:not([hidden]) .ticket');
      const g = await pg.evaluate(() => Object.values(window.__fakeDb.get('requests')).find((r) => r.ref_no === 1204));
      assert.strictEqual(g.payment, 'collect');
      assert.deepStrictEqual(Object.values(g.items), [{ qty: 2, type: 'pallet', weight: 300 }]);
      assert.strictEqual(g.delivery.name, '');
      // A weekend date can't be picked
      await pg.click('[data-act=new-request]');
      assert.strictEqual(await pg.evaluate(() => S.step), 1, 'a new request starts on step 1');
      await pg.fill('#pickup-name', 'Acme Supply');
      await pg.fill('#pickup-address', '12 Main St');
      await pg.click('#btn-review');
      await pg.click('#btn-review');
      await pg.check('input[name=when][value=scheduled]', { force: true });
      await pg.fill('#sched-date', '2030-01-05');
      await pg.click('#btn-review');
      await pg.waitForSelector('#sched-err');
      assert.match(await pg.textContent('#sched-err'), /closed that day \(the weekend\)/);
      // Repeat from History lands on Check and send
      await pg.click('.tab[data-nav=history]');
      await pg.waitForSelector('#hist-list .row-repeat');
      await pg.click('#hist-list .row-repeat >> nth=0');
      await pg.click('#sheet-body [data-confirm="1"]').catch(() => {});
      await pg.waitForFunction(() => S.tab === 'new' && S.step === 4);
      assert.deepStrictEqual(eg, [], 'no script errors in the guided steps');
      await cg.close();
    }
    // 2.3 home-screen shortcut "Repeat last" fills in the latest request
    {
      const { page: p2, errors: e2, ctx: c2 } = await open(browser, `${base}?go=repeat`, { user: USER, data: DATA });
      await p2.waitForFunction(() => document.getElementById('pickup-name').value === 'Acme Supply');
      assert.strictEqual(await p2.inputValue('#delivery-name'), 'Smith Co');
      assert.ok(!(await p2.evaluate(() => location.search)), 'the ?go= is removed from the address');
      assert.deepStrictEqual(e2, [], 'no script errors from the shortcut');
      await c2.close();
    }
    // A pickup removed while the app was closed is mentioned on the next open; cancelled pickups aren't offered in Messages
    {
      const away = JSON.parse(JSON.stringify(DATA));
      Object.assign(away.requests.r1, { status: 'removed', removed_at: now - 30000 });
      away.requests.r2 = { ref_no: 1202, status: 'cancelled', company_id: 'c1', company_name: 'Acme Supply', customer_uid: 'u1', pickup: { name: 'Acme Supply', address: '12 Main St' }, delivery: { name: 'Gone Co' }, items_text: '1 box', payment: 'prepaid', created_at: now - 10 * 60000, cancelled_at: now - 5 * 60000 };
      const { page: p5, errors: e5, ctx: c5 } = await open(browser, base, { user: USER, data: away });
      await p5.waitForFunction(() => S.reqLoaded);
      await p5.evaluate((t) => localStorage.setItem('ec_seen_u1', String(t)), now - 60000);
      await p5.reload();
      await p5.waitForSelector('.toast.error:has-text("#1201 was removed by dispatch since your last visit")');
      await p5.click('.tab[data-nav=messages]');
      await p5.waitForSelector('#msg-about');
      const opts = await p5.$$eval('#msg-about option', (o) => o.map((x) => x.value));
      assert.ok(!opts.includes('r2') && opts.includes('r1'), 'cancelled pickups left out of About, removed ones kept');
      assert.strictEqual(opts[0], 'general', 'General is the first choice in About');
      assert.strictEqual(await p5.inputValue('#msg-about'), 'general', 'with no messages yet, About starts on General');
      assert.deepStrictEqual(e5, [], 'no script errors');
      await c5.close();
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
      const { page: p3, errors: e3, ctx: c3 } = await open(browser, base, { user: USER, data: keyed }, DESK);
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
      await p3.click('#side-sum .btn');
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
    // A phone set to dark still opens in Light until the person picks Dark or Auto
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark', serviceWorkers: 'block' });
      const pd = await ctx.newPage();
      await pd.route(/googleapis\.com|gstatic\.com|cloudfunctions\.net/, (r) => r.abort());
      await pd.goto(base);
      assert.strictEqual(await pd.getAttribute('html', 'data-theme'), 'light', 'Light by default on a dark phone');
      await pd.evaluate(() => localStorage.setItem('ec_theme_pref', 'system'));
      await pd.reload();
      assert.strictEqual(await pd.getAttribute('html', 'data-theme'), 'dark', 'Auto follows a dark phone');
      await ctx.close();
    }
    console.log('pickup smoke test passed');
  } finally {
    await browser.close();
    srv.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
