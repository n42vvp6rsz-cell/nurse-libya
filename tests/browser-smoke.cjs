#!/usr/bin/env node
'use strict';

// Run with: node tests/browser-smoke.cjs
// Every external request is intercepted before navigation. Supabase/config are
// replaced with local mocks; the suite cannot create users or contact a backend.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');

const root = path.resolve(__dirname, '..');
const timeout = (promise, ms, label) => Promise.race([
  promise,
  new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); timer.unref(); })
]);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function mockSDK(options) {
  window.__qa = {calls: [], blocked: [], rows: options.rows || {}, errors: {}, pending: {}, owner: 'qa-owner-a'};
  const q = window.__qa;
  const user = id => ({id, email: `${id}@example.invalid`, user_metadata: {full_name: 'مستخدم الاختبار', phone: '0910000000', ...(options.spoofAdmin ? {role: 'admin'} : {})}});
  let listener;
  let current = options.signedIn ? user('qa-owner-a') : null;
  q.emit = (event, id) => { current = id ? user(id) : null; listener?.(event, current ? {user: current} : null); };
  q.release = table => { const entries = q.pending[table] || []; delete q.pending[table]; entries.forEach(resolve => resolve()); };
  q.defer = [];
  const defaultRows = {
    services: [{id: 'qa-service', name: 'تمريض منزلي', slug: 'home-nursing', description: 'رعاية منزلية', sort_order: 1, is_active: true}],
    profiles: [{id: 'qa-owner-a', full_name: 'الاسم المعتمد', phone: '0910000000', role: options.role || (options.admin ? 'admin' : 'patient')}],
    bookings: [], doctors: [], nurses: [], hospitals: [], laboratories: [], pharmacies: [], organizations: [], jobs: [], courses: [],
    provider_applications: [], job_applications: [], course_enrollments: [], service_requests: []
  };
  const auth = {
    onAuthStateChange(fn) { listener = fn; return {data: {subscription: {unsubscribe() {}}}}; },
    async getSession() { return {data: {session: current ? {user: current} : null}, error: null}; },
    async signInWithPassword(payload) { q.calls.push({type: 'login', payload}); current = user('qa-owner-a'); listener?.('SIGNED_IN', {user: current}); return {data: {session: {user: current}, user: current}, error: null}; },
    async signUp(payload) { q.calls.push({type: 'signup', payload}); return {data: {user: user('qa-created'), session: null}, error: null}; },
    async resetPasswordForEmail(...payload) { q.calls.push({type: 'reset', payload}); return {data: {}, error: null}; },
    async updateUser(payload) { q.calls.push({type: 'password', payload}); return {data: {user: current}, error: null}; },
    async signOut() { q.calls.push({type: 'logout'}); current = null; listener?.('SIGNED_OUT', null); return {error: null}; }
  };
  function from(table) {
    const query = {table, filters: [], operation: 'select', payload: null, singleton: false, columns: '*', count: null};
    let result;
    async function execute() {
      q.calls.push(JSON.parse(JSON.stringify(query)));
      const capturedOwner = current?.id;
      if (q.defer.includes(table)) await new Promise(resolve => (q.pending[table] ||= []).push(resolve));
      if (q.errors[table]) return {data: null, error: {message: 'Mock failure', code: q.errors[table]}};
      if (query.operation === 'insert' || query.operation === 'update' || query.operation === 'upsert') {
        const idFilter = query.filters.find(([method, column]) => method === 'eq' && column === 'id');
        const base = (q.rows[table] || []).find(row => row.id === idFilter?.[2]) || {};
        const inserted = {...base, ...query.payload, id: query.payload?.id || idFilter?.[2] || 'qa-generated-id', created_at: '2026-10-07T10:00:00Z'};
        if (query.operation === 'insert') (q.rows[table] ||= []).push(inserted);
        return {data: query.singleton ? inserted : [inserted], error: null};
      }
      let rows = [...(q.rows[table] || defaultRows[table] || [])];
      if (table === 'profiles' && !Object.hasOwn(q.rows, table)) rows = [{id: capturedOwner, full_name: capturedOwner === 'qa-owner-b' ? 'الحساب الثاني' : 'الاسم المعتمد', phone: '0910000000', role: options.role || (options.admin ? 'admin' : 'patient')}];
      for (const [method, column, value] of query.filters) {
        if (method === 'eq') rows = rows.filter(row => row[column] === value);
        if (method === 'in') rows = rows.filter(row => value.includes(row[column]));
      }
      if (query.count) rows = rows.slice(0, query.count);
      return {data: query.singleton ? (rows[0] || null) : rows, error: null};
    }
    const chain = {
      select(columns) { query.columns = columns || '*'; return chain; },
      eq(column, value) { query.filters.push(['eq', column, value]); return chain; },
      neq() { return chain; }, lt() { return chain; }, lte() { return chain; }, gt() { return chain; }, gte() { return chain; },
      is() { return chain; }, or() { return chain; }, match() { return chain; },
      in(column, value) { query.filters.push(['in', column, value]); return chain; },
      order() { return chain; }, limit(count) { query.count = count; return chain; }, range() { return chain; },
      single() { query.singleton = true; return chain; }, maybeSingle() { query.singleton = true; return chain; },
      insert(payload) { query.operation = 'insert'; query.payload = payload; return chain; },
      update(payload) { query.operation = 'update'; query.payload = payload; return chain; },
      upsert(payload) { query.operation = 'upsert'; query.payload = payload; return chain; },
      then(resolve, reject) { return (result ||= execute()).then(resolve, reject); }
    };
    return chain;
  }
  window.supabase = {createClient() { return {auth, from, async rpc(name, payload) { q.calls.push({type: 'rpc', name, payload}); return {data: name === 'nurse_app_contract_version' ? (options.contractVersion || null) : null, error: null}; }}; }};
}

async function startBrowser() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'nurse-libya-browser-'));
  const browser = spawn(process.env.CHROMIUM_BIN || '/usr/bin/chromium', [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--no-first-run', '--disable-background-networking', '--disable-sync',
    '--disable-default-apps', '--metrics-recording-only', 'about:blank'
  ], {stdio: ['ignore', 'ignore', 'pipe']});
  let stderr = '';
  const endpoint = await timeout(new Promise((resolve, reject) => {
    browser.stderr.on('data', chunk => { stderr += chunk; const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) resolve(match[1]); });
    browser.once('error', reject);
    browser.once('exit', code => reject(new Error(`Chromium exited early (${code})`)));
  }), 15000, 'Chromium startup');
  const socket = new WebSocket(endpoint);
  await timeout(new Promise((resolve, reject) => { socket.addEventListener('open', resolve, {once: true}); socket.addEventListener('error', reject, {once: true}); }), 10000, 'CDP connection');
  let next = 0;
  const pending = new Map();
  const listeners = new Map();
  socket.addEventListener('message', event => {
    const msg = JSON.parse(event.data);
    if (msg.id) {
      const waiter = pending.get(msg.id); pending.delete(msg.id);
      if (msg.error) waiter?.reject(new Error(msg.error.message)); else waiter?.resolve(msg.result);
    } else for (const fn of listeners.get(msg.method) || []) fn(msg.params, msg.sessionId);
  });
  const send = (method, params = {}, sessionId) => timeout(new Promise((resolve, reject) => {
    const id = ++next; pending.set(id, {resolve, reject}); socket.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}));
  }), 15000, method);
  const on = (event, fn) => { const list = listeners.get(event) || []; list.push(fn); listeners.set(event, list); };
  async function close() { await send('Browser.close').catch(() => {}); browser.kill('SIGTERM'); socket.close(); await fs.rm(profile, {recursive: true, force: true, maxRetries: 4, retryDelay: 100}); }
  return {send, on, close};
}

async function main() {
  const server = http.createServer(async (request, response) => {
    try {
      const requested = new URL(request.url, 'http://localhost').pathname;
      const filename = path.resolve(root, `.${requested === '/' ? '/index.html' : requested}`);
      if (!filename.startsWith(root + path.sep)) { response.writeHead(403); response.end(); return; }
      if (requested === '/config.js') throw new Error('Config must be intercepted');
      const file = await fs.readFile(filename);
      response.writeHead(200, {'Content-Type': ({'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml'})[path.extname(filename)] || 'application/octet-stream'}); response.end(file);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await startBrowser();
  let count = 0;
  const scenarios = [];
  const blockedRequests = [];
  const failures = [];
  try {
    async function page(options = {}) {
      const {targetId} = await browser.send('Target.createTarget', {url: 'about:blank'});
      const {sessionId} = await browser.send('Target.attachToTarget', {targetId, flatten: true});
      const send = (method, params) => browser.send(method, params, sessionId);
      const errors = [];
      browser.on('Runtime.exceptionThrown', (event, session) => { if (session === sessionId) errors.push(event.exceptionDetails.exception?.description || event.exceptionDetails.text); });
      browser.on('Fetch.requestPaused', async (event, session) => {
        if (session !== sessionId) return;
        const {requestId, request: {url}} = event;
        try {
          if (url.includes('/@supabase/supabase-js@')) {
            const body = options.noSDK ? '' : `(${mockSDK.toString()})(${JSON.stringify(options)});`;
            await send('Fetch.fulfillRequest', {requestId, responseCode: 200, responseHeaders: [{name: 'Content-Type', value: 'text/javascript'}], body: Buffer.from(body).toString('base64')});
          } else if (url === `${origin}/config.js`) {
            const body = "window.NURSE_LIBYA_CONFIG={supabaseUrl:'https://blocked-backend.example.invalid',supabasePublishableKey:'public-test-key'};";
            await send('Fetch.fulfillRequest', {requestId, responseCode: 200, responseHeaders: [{name: 'Content-Type', value: 'text/javascript'}], body: Buffer.from(body).toString('base64')});
          } else if (url.startsWith(origin + '/')) await send('Fetch.continueRequest', {requestId});
          else { blockedRequests.push(new URL(url).hostname); await send('Fetch.failRequest', {requestId, errorReason: 'BlockedByClient'}); }
        } catch (error) { errors.push(`Interception: ${error.message}`); }
      });
      await send('Runtime.enable'); await send('Page.enable');
      await send('Fetch.enable', {patterns: [{urlPattern: '*'}]});
      await send('Emulation.setDeviceMetricsOverride', {width: options.width || 390, height: 844, deviceScaleFactor: 1, mobile: false});
      await send('Page.navigate', {url: `${origin}/#${options.hash || 'home'}`});
      const evaluate = async expression => {
        const result = await send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true, userGesture: true});
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        return result.result.value;
      };
      async function until(expression, label) {
        const end = Date.now() + 5000;
        while (Date.now() < end) { if (await evaluate(expression)) return; await pause(30); }
        throw new Error(`Browser condition failed: ${label}`);
      }
      await until("document.querySelector('#home') && (typeof authReady === 'undefined' || authReady)", 'application ready');
      await pause(120);
      const route = async hash => { await evaluate(`location.hash=${JSON.stringify(hash)}`); await pause(120); };
      const checkOverflow = async label => {
        const metrics = await evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth})');
        assert.ok(metrics.scroll <= metrics.width + 1, `${label}: overflow ${JSON.stringify(metrics)}`);
      };
      const close = async () => { await browser.send('Target.closeTarget', {targetId}); assert.deepEqual(errors, [], 'Uncaught browser errors'); };
      return {evaluate, until, route, checkOverflow, close, send, errors};
    }
    async function scenario(name, task) {
      try { await task(); count++; scenarios.push(name); process.stdout.write(`PASS ${name}\n`); }
      catch (error) { failures.push({name, error}); process.stderr.write(`FAIL ${name}: ${error.message}\n`); }
    }
    await scenario('guest routes and responsive public layout (390 / 1440)', async () => {
      for (const width of [390, 1440]) {
        const p = await page({width});
        await p.until("document.querySelector('#serviceGrid article')", 'service loaded');
        await p.checkOverflow(`home ${width}`);
        assert.equal(await p.evaluate('document.documentElement.dir'), 'rtl');
        for (const hash of ['login', 'register', 'forgot', 'providers', 'organizations', 'jobs', 'courses', 'contact', 'privacy']) {
          await p.route(hash); await p.checkOverflow(`${hash} ${width}`);
          assert.equal(await p.evaluate(`document.getElementById(${JSON.stringify(hash)})?.hidden`), false, `${hash} route visible`);
        }
        await p.route('bookings');
        assert.equal(await p.evaluate("document.querySelector('#login').hidden"), false);
        await p.route('home');
        assert.ok(await p.evaluate('scrollY <= 1'), 'Route entry keeps header in view');
        await p.send('Page.captureScreenshot', {format: 'png'}).then(result => fs.writeFile(path.join(os.tmpdir(), `nurse-libya-qa-${width}.png`), Buffer.from(result.data, 'base64')));
        await p.close();
      }
    });
    await scenario('SDK outage has a useful visible state', async () => {
      const p = await page({noSDK: true});
      assert.equal(await p.evaluate("document.querySelector('#connection').hidden"), false);
      assert.equal(await p.evaluate("document.querySelector('#home').hidden"), false);
      await p.close();
    });
    await scenario('catalog and booking text cannot create unsafe DOM', async () => {
      const unsafe = '<img src=x onerror="window.__xss=1">';
      const p = await page({signedIn: true, rows: {services: [{name: unsafe, description: unsafe, is_active: true}], bookings: [{id: 'qa-private', user_id: 'qa-owner-a', service: unsafe, booking_date: '2099-01-01', status: 'pending'}]}});
      await p.until("document.querySelector('#serviceGrid article')", 'unsafe service loaded');
      assert.equal(await p.evaluate("document.querySelector('#serviceGrid img') !== null || !!window.__xss"), false);
      await p.route('bookings');
      await p.until("document.querySelector('#bookingsList').textContent.includes('<img')", 'unsafe booking rendered as text');
      assert.equal(await p.evaluate("document.querySelector('#bookingsList img') !== null || !!window.__xss"), false);
      await p.close();
    });
    await scenario('approved public filters, long text, empty and retry states', async () => {
      const p = await page({rows: {
        doctors: [{id: 'qa-doctor', profile_id: 'qa-provider', name: 'X'.repeat(260), specialty: 'تمريض', city: 'طرابلس', verified: true}, {id: 'qa-hidden', name: 'UNVERIFIED MUST STAY HIDDEN', verified: false}],
        courses: [{id: 'qa-draft', title: 'UNAPPROVED MUST STAY HIDDEN', status: 'active', review_status: 'draft'}]
      }});
      await p.route('providers');
      await p.until("document.querySelector('#providersResults article')", 'public provider loaded');
      assert.equal(await p.evaluate("document.querySelector('#providersResults').textContent.includes('UNVERIFIED')"), false);
      await p.checkOverflow('long public provider title');
      await p.route('courses');
      await p.until("document.querySelector('#coursesResults').textContent.includes('لا توجد')", 'unapproved course excluded');
      assert.equal(await p.evaluate("document.querySelector('#coursesResults').textContent.includes('UNAPPROVED')"), false);
      await p.evaluate("window.__qa.errors.doctors='42P17'");
      await p.route('providers');
      await p.until("document.querySelector('#providersResults').textContent.includes('إعادة المحاولة')", 'useful retry state');
      await p.close();
    });
    await scenario('native validation and single booking submission', async () => {
      const p = await page({signedIn: true, hash: 'booking'});
      await p.until("document.querySelector('#bookingService option')", 'booking service available');
      const first = await p.evaluate("document.querySelector('#bookingForm').checkValidity()");
      assert.equal(first, false, 'Empty booking has native validation');
      await p.evaluate("document.querySelector('#bookingName').value='المستفيد';document.querySelector('#bookingPhone').value='0910000000';document.querySelector('#bookingDate').value='2099-01-01';document.querySelector('#bookingForm').requestSubmit();document.querySelector('#bookingForm').requestSubmit();");
      await p.until("window.__qa.calls.some(c=>c.table==='bookings'&&c.operation==='insert')", 'booking inserted');
      const inserts = await p.evaluate("window.__qa.calls.filter(c=>c.table==='bookings'&&c.operation==='insert')");
      assert.equal(inserts.length, 1, 'Concurrent submission must not duplicate');
      assert.equal(inserts[0].payload.user_id, 'qa-owner-a');
      assert.equal(inserts[0].payload.status, 'pending');
      assert.match(inserts[0].payload.id, /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i, 'Stable booking UUID');
      await p.close();
    });
    await scenario('late private booking response is discarded after account switch', async () => {
      const p = await page({signedIn: true, rows: {bookings: [{id: 'qa-private', user_id: 'qa-owner-a', service: 'PRIVATE OWNER A', booking_date: '2099-01-01', status: 'pending'}]}});
      await p.evaluate("window.__qa.defer.push('bookings');location.hash='bookings'");
      await p.until("window.__qa.pending.bookings?.length", 'private request pending');
      await p.evaluate("window.__qa.emit('SIGNED_IN','qa-owner-b');window.__qa.defer=[];window.__qa.release('bookings')");
      await pause(200);
      assert.equal(await p.evaluate("document.body.textContent.includes('PRIVATE OWNER A')"), false);
      await p.close();
    });
    await scenario('profile save edits display fields only', async () => {
      const p = await page({signedIn: true, hash: 'profile'});
      await p.until("document.querySelector('#profileForm [name=full_name]').value", 'own profile loaded');
      await p.evaluate("document.querySelector('#profileForm [name=full_name]').value='اسم محدّث';document.querySelector('#profileForm [name=phone]').value='0910000000';document.querySelector('#profileForm').requestSubmit()");
      await p.until("window.__qa.calls.some(c=>c.table==='profiles'&&c.operation==='update')", 'profile update captured');
      const writes = await p.evaluate("window.__qa.calls.filter(c=>c.table==='profiles'&&c.operation==='update')");
      assert.deepEqual(Object.keys(writes[0].payload).sort(), ['full_name', 'phone']);
      assert.ok(writes[0].filters.some(([method, column, value]) => method === 'eq' && column === 'id' && value === 'qa-owner-a'));
      await p.until("document.querySelector('#profileName').textContent==='اسم محدّث'", 'saved profile reflected');
      await p.close();
    });
    await scenario('private authoring and administration layout (390 / 1440)', async () => {
      for (const width of [390, 1440]) {
        const p = await page({signedIn: true, admin: true, width});
        for (const hash of ['profile', 'booking', 'bookings', 'workspace', 'publish', 'care-profile', 'admin']) {
          await p.route(hash);
          assert.equal(await p.evaluate(`document.getElementById(${JSON.stringify(hash)})?.hidden`), false, `${hash} route visible`);
          await p.checkOverflow(`${hash} ${width}`);
        }
        await p.close();
      }
    });
    await scenario('profession metadata cannot open administration', async () => {
      const p = await page({signedIn: true, spoofAdmin: true, hash: 'admin'});
      await pause(200);
      const rpcCalls = await p.evaluate("window.__qa.calls.filter(c=>c.type==='rpc')");
      assert.deepEqual(rpcCalls, [], 'Metadata role cannot invoke administrative actions');
      assert.equal(await p.evaluate("[...document.querySelectorAll('#admin button')].some(el=>/اعتماد|موافقة/.test(el.textContent)&&!el.disabled)"), false);
      await p.close();
    });
    await scenario('care profiles require the database contract and expose safe role fields', async () => {
      const denied = await page({signedIn: true, role: 'doctor', hash: 'care-profile'});
      await denied.until("document.querySelector('#saveCareProfile')?.disabled", 'missing database contract disables writes');
      await denied.evaluate("document.querySelector('#careProfileForm [name=name]').value='مقدم الخدمة';document.querySelector('#careProfileForm [name=specialty]').value='طب عام';document.querySelector('#careProfileForm').requestSubmit()");
      await pause(100);
      assert.equal(await denied.evaluate("window.__qa.calls.some(c=>['doctors','nurses','hospitals','laboratories','pharmacies'].includes(c.table)&&c.operation==='insert')"), false);
      await denied.close();
      for (const role of ['doctor', 'nurse', 'hospital', 'laboratory', 'pharmacy']) {
        const p = await page({signedIn: true, role, contractVersion: 1, hash: 'care-profile'});
        await p.until("document.querySelector('#saveCareProfile') && !document.querySelector('#saveCareProfile').disabled", `${role} form enabled by contract`);
        await p.checkOverflow(`${role} care profile form`);
        assert.equal(await p.evaluate("document.querySelector('#careProfileForm [name=phone],#careProfileForm [name=email],#careProfileForm [name=verified]')!==null"), false);
        if (role === 'doctor') {
          await p.evaluate("document.querySelector('#careProfileForm [name=name]').value='مقدم الخدمة';document.querySelector('#careProfileForm [name=specialty]').value='طب عام';document.querySelector('#careProfileForm [name=city]').value='طرابلس';document.querySelector('#careProfileForm').requestSubmit()");
          await p.until("window.__qa.calls.some(c=>c.table==='doctors'&&c.operation==='insert')", 'owned doctor insert captured');
          const payload = await p.evaluate("window.__qa.calls.find(c=>c.table==='doctors'&&c.operation==='insert').payload");
          assert.equal(payload.profile_id, 'qa-owner-a');
          assert.equal(Object.hasOwn(payload, 'verified'), false);
          assert.equal(Object.hasOwn(payload, 'phone'), false);
        }
        await p.close();
      }
    });
    await scenario('keyboard navigation and form labels', async () => {
      const p = await page();
      await p.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9});
      await p.send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9});
      assert.ok(await p.evaluate("['A','BUTTON','INPUT','SELECT'].includes(document.activeElement.tagName)"), 'Keyboard can reach a control');
      const unlabeled = await p.evaluate("[...document.querySelectorAll('input,select,textarea')].filter(el=>!el.labels?.length&&!el.getAttribute('aria-label')&&!el.getAttribute('aria-labelledby')).map(el=>el.id||el.name)");
      assert.deepEqual(unlabeled, [], 'Every form control has a label');
      await p.close();
    });
    process.stdout.write(`Browser smoke: ${count} scenarios passed, ${failures.length} failed; mocked backend only.\n`);
    if (blockedRequests.some(host => host.includes('supabase'))) throw new Error('Unexpected real backend request attempted');
    if (failures.length) throw new AggregateError(failures.map(f => f.error), `${failures.length} browser scenarios failed`);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
