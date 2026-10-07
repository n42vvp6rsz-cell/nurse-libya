#!/usr/bin/env node
'use strict';

// Run with: node tests/browser-smoke.cjs
// Every external request is intercepted before navigation. Supabase/config are
// replaced with local mocks. One known image URL is fulfilled with a synthetic
// oversized SVG; all other external requests fail. No backend is contacted.
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
  window.__qa = {calls: [], blocked: [], rows: options.rows || {}, errors: {}, pending: {}, rpcErrors: {}, rpcPending: {}, rpcDefer: [], userA: options.owner || 'qa-owner-a', userB: options.otherOwner || 'qa-owner-b'};
  const q = window.__qa;
  const user = id => ({id, email: `${id}@example.invalid`, user_metadata: {full_name: 'مستخدم الاختبار', phone: '0910000000', ...(options.spoofAdmin ? {role: 'admin'} : {})}});
  let listener;
  let current = options.signedIn ? user(q.userA) : null;
  q.emit = (event, id) => { current = id ? user(id) : null; listener?.(event, current ? {user: current} : null); };
  q.release = table => { const entries = q.pending[table] || []; delete q.pending[table]; entries.forEach(resolve => resolve()); };
  q.releaseRPC = name => { const entries = q.rpcPending[name] || []; delete q.rpcPending[name]; entries.forEach(resolve => resolve()); };
  q.defer = [];
  const defaultRows = {
    services: [{id: 'qa-service', name: 'تمريض منزلي', slug: 'home-nursing', description: 'رعاية منزلية', sort_order: 1, is_active: true}],
    profiles: [{id: 'qa-owner-a', full_name: 'الاسم المعتمد', phone: '0910000000', role: options.role || (options.admin ? 'admin' : 'patient')}],
    bookings: [], doctors: [], nurses: [], hospitals: [], laboratories: [], pharmacies: [], organizations: [], jobs: [], courses: [],
    provider_applications: [], job_applications: [], course_enrollments: [], service_requests: [], messages: [], store_products: [], store_orders: [], store_order_items: []
  };
  const auth = {
    onAuthStateChange(fn) { listener = fn; return {data: {subscription: {unsubscribe() {}}}}; },
    async getSession() { return {data: {session: current ? {user: current} : null}, error: null}; },
    async signInWithPassword(payload) { q.calls.push({type: 'login', payload}); current = user(q.userA); listener?.('SIGNED_IN', {user: current}); return {data: {session: {user: current}, user: current}, error: null}; },
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
        const serverDefaults = table === 'store_products' ? {currency: 'LYD', is_active: false, updated_at: '2026-10-07T10:00:00Z'} : {};
        const inserted = {...serverDefaults, ...base, ...query.payload, id: query.payload?.id || idFilter?.[2] || 'qa-generated-id', created_at: '2026-10-07T10:00:00Z'};
        if (query.operation === 'insert') (q.rows[table] ||= []).push(inserted);
        return {data: query.singleton ? inserted : [inserted], error: null};
      }
      let rows = [...(q.rows[table] || defaultRows[table] || [])];
      if (table === 'profiles' && !Object.hasOwn(q.rows, table)) rows = [{id: capturedOwner, full_name: capturedOwner === q.userB ? 'الحساب الثاني' : 'الاسم المعتمد', phone: '0910000000', role: options.role || (options.admin ? 'admin' : 'patient')}];
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
  window.supabase = {createClient() { return {auth, from, async rpc(name, payload) {
    q.calls.push({type: 'rpc', name, payload});
    const capturedOwner = current?.id;
    if (q.rpcDefer.includes(name)) await new Promise(resolve => (q.rpcPending[name] ||= []).push(resolve));
    if (q.rpcHandler) return q.rpcHandler(name, payload, capturedOwner);
    if (q.rpcErrors[name]) return {data: null, error: {code: q.rpcErrors[name], message: 'Mock RPC failure'}};
    const contracts = {nurse_app_contract_version: options.contractVersion, nurse_messages_contract_version: options.messagesContractVersion, nurse_store_contract_version: options.storeContractVersion};
    return {data: Object.hasOwn(contracts, name) ? (contracts[name] || null) : (options.rpcData?.[name] || null), error: null};
  }}; }};
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
          } else if (url === 'https://qa-image.example.invalid/wide.svg') {
            const body = '<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="400" viewBox="0 0 4000 400"><rect width="4000" height="400" fill="#e5f1ec"/><path d="M1940 80h120v70h70v100h-70v70h-120v-70h-70v-100h70z" fill="#086b68"/></svg>';
            await send('Fetch.fulfillRequest', {requestId, responseCode: 200, responseHeaders: [{name: 'Content-Type', value: 'image/svg+xml'}], body: Buffer.from(body).toString('base64')});
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
    async function mockPreview(p, filename) {
      await p.evaluate(`(()=>{window.scrollTo(0,0);const marker=document.createElement('div');marker.id='qaMockPreviewLabel';marker.textContent='معاينة ببيانات محاكاة للاختبار';Object.assign(marker.style,{position:'fixed',bottom:'10px',left:'10px',zIndex:'9999',background:'#fff',color:'#123b46',border:'1px solid #123b46',borderRadius:'8px',padding:'7px 12px',fontSize:'12px',maxWidth:'calc(100vw - 20px)'});document.body.append(marker)})()`);
      await pause(50);
      const capture = await p.send('Page.captureScreenshot', {format: 'png'});
      await fs.writeFile(path.join(root, 'docs', filename), Buffer.from(capture.data, 'base64'));
      await p.evaluate("document.querySelector('#qaMockPreviewLabel').remove()");
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
        await mockPreview(p, width === 390 ? 'preview-mobile.png' : 'preview-desktop.png');
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
    const messageOwner = '11111111-1111-4111-8111-111111111111';
    const messageOther = '22222222-2222-4222-8222-222222222222';
    const messagePeer = '33333333-3333-4333-8333-333333333333';
    const messageOptions = {
      signedIn: true, owner: messageOwner, otherOwner: messageOther,
      hash: `messages?provider=${messagePeer}`,
      rows: {
        doctors: [{id: '55555555-5555-4555-8555-555555555555', profile_id: messagePeer, name: 'مقدم رعاية للاختبار', city: 'طرابلس', verified: true}],
        messages: [{id: '44444444-4444-4444-8444-444444444444', sender_id: messagePeer, receiver_id: messageOwner, body: '<img src=x onerror="window.__messageXSS=1"> رسالة اختبار خاصة', is_read: false, created_at: '2026-10-07T10:00:00Z'}]
      }
    };
    await scenario('messages participant threads render text and reject writes without backend activation', async () => {
      const p = await page(messageOptions);
      await p.until("document.querySelector('#messagesThread article')", 'participant thread loaded');
      assert.equal(await p.evaluate("document.querySelector('#messagesThread img') !== null || !!window.__messageXSS"), false);
      assert.equal(await p.evaluate("document.querySelector('#messagesSend').disabled"), true);
      assert.equal(await p.evaluate("document.querySelector('#messagesThread button').disabled"), true);
      await p.evaluate("document.querySelector('#messagesBody').value='إرسال غير مسموح';document.querySelector('#messagesSend').disabled=false;document.querySelector('#messagesForm').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));document.querySelector('#messagesThread button').disabled=false;document.querySelector('#messagesThread button').click()");
      await pause(100);
      assert.equal(await p.evaluate("window.__qa.calls.some(c=>c.type==='rpc'&&['send_private_message','mark_private_message_read'].includes(c.name))"), false);
      await p.checkOverflow('messages inactive backend mobile');
      await p.close();
    });
    await scenario('message lost-response retry preserves UUID, recipient and body without duplicate writes', async () => {
      const p = await page({...messageOptions, messagesContractVersion: 1});
      await p.until("document.querySelector('#messagesSend')&&!document.querySelector('#messagesSend').disabled", 'message send enabled');
      await p.evaluate(`window.__qa.rpcHandler=(name,payload,owner)=>{
        const q=window.__qa;
        if(name==='nurse_messages_contract_version')return {data:1,error:null};
        if(name==='send_private_message'){
          let saved=q.rows.messages.find(row=>row.id===payload.p_message_id);
          if(!saved){saved={id:payload.p_message_id,sender_id:owner,receiver_id:payload.p_receiver_id,body:payload.p_body,is_read:false,created_at:'2026-10-07T10:01:00Z'};q.rows.messages.push(saved);return {data:null,error:{message:'Synthetic response lost',code:'NETWORK'}};}
          return {data:[saved],error:null};
        }
        if(name==='mark_private_message_read'){const row=q.rows.messages.find(row=>row.id===payload.p_message_id);row.is_read=true;return {data:[row],error:null};}
        return {data:null,error:null};
      };document.querySelector('#messagesBody').value='<svg onload="window.__messageXSS=1"> رسالة آمنة';document.querySelector('#messagesForm').requestSubmit();document.querySelector('#messagesForm').requestSubmit()`);
      await p.until("document.querySelector('#messagesNotice').textContent.includes('لم يتأكد')", 'ambiguous message response visible');
      assert.equal(await p.evaluate("window.__qa.calls.filter(c=>c.type==='rpc'&&c.name==='send_private_message').length"), 1);
      await p.evaluate("document.querySelector('#messagesBody').value='نص معدل برمجيًا';document.querySelector('#messagesForm').requestSubmit()");
      await p.until("document.querySelector('#messagesBody').value===''", 'message retry confirmed');
      const sends = await p.evaluate("window.__qa.calls.filter(c=>c.type==='rpc'&&c.name==='send_private_message')");
      assert.equal(sends.length, 2);
      assert.deepEqual(sends[0].payload, sends[1].payload, 'Retry retains original payload');
      assert.equal(sends[0].payload.p_receiver_id, messagePeer);
      assert.equal(await p.evaluate("window.__qa.rows.messages.filter(row=>row.id===window.__qa.calls.find(c=>c.name==='send_private_message').payload.p_message_id).length"), 1);
      assert.equal(await p.evaluate("document.querySelector('#messagesThread svg') !== null || !!window.__messageXSS"), false);
      await p.evaluate("document.querySelector('#messagesThread button').click()");
      await p.until("window.__qa.calls.some(c=>c.name==='mark_private_message_read')", 'recipient read action captured');
      assert.equal(await p.evaluate("window.__qa.rows.messages[0].is_read"), true);
      await p.close();
    });
    await scenario('messages discard a late private response when the account changes', async () => {
      const p = await page({...messageOptions, hash: 'home', messagesContractVersion: 1});
      await p.evaluate("window.__qa.defer.push('messages');location.hash='messages'");
      await p.until("window.__qa.pending.messages?.length", 'message request delayed');
      await p.evaluate(`window.__qa.defer=[];window.__qa.emit('SIGNED_IN',${JSON.stringify(messageOther)});window.__qa.release('messages')`);
      await pause(200);
      assert.equal(await p.evaluate("document.querySelector('#messages').textContent.includes('رسالة اختبار خاصة')"), false);
      assert.equal(await p.evaluate("document.querySelector('#messagesBody').value"), '');
      await p.close();
    });
    await scenario('messages responsive controls, labels and keyboard (390 / 1440)', async () => {
      for (const width of [390, 1440]) {
        const p = await page({...messageOptions, messagesContractVersion: 1, width, rows: {...messageOptions.rows, messages: messageOptions.rows.messages.map(row => ({...row, body: 'رسالة تنسيق الرعاية للاختبار فقط'}))}});
        await p.until("document.querySelector('#messagesSend')&&!document.querySelector('#messagesSend').disabled", 'message controls ready');
        await p.checkOverflow(`messages ${width}`);
        const unlabeled = await p.evaluate("[...document.querySelectorAll('#messages input,#messages select,#messages textarea')].filter(el=>!el.labels?.length&&!el.getAttribute('aria-label')&&!el.getAttribute('aria-labelledby')).map(el=>el.id||el.name)");
        assert.deepEqual(unlabeled, []);
        await p.evaluate("document.querySelector('#messagesBody').focus()");
        await p.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9});
        await p.send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9});
        assert.equal(await p.evaluate('document.activeElement.id'), 'messagesSend', 'Keyboard reaches send from the message field');
        await mockPreview(p, width === 390 ? 'preview-messages-mobile.png' : 'preview-messages-desktop.png');
        await p.close();
      }
    });
    const productId = '66666666-6666-4666-8666-666666666666';
    const productSecondId = '77777777-7777-4777-8777-777777777777';
    const storeProducts = [
      {id: productId, title: 'مستلزمات رعاية تجريبية', description: 'بيانات محاكاة لا تمثل منتجًا معروضًا للبيع.', category: 'رعاية منزلية', image_url: 'https://qa-image.example.invalid/wide.svg', price_minor: 1005, currency: 'LYD', stock_quantity: 4, is_active: true, created_at: '2026-10-07T10:00:00Z', updated_at: '2026-10-07T10:00:00Z'},
      {id: productSecondId, title: 'أداة اختبار ثانية', description: 'بيانات اختبار فقط.', category: 'أدوات', image_url: null, price_minor: 9000, currency: 'LYD', stock_quantity: 2, is_active: true, created_at: '2026-10-07T10:00:00Z', updated_at: '2026-10-07T10:00:00Z'}
    ];
    const storeOptions = {signedIn: true, owner: messageOwner, otherOwner: messageOther, hash: 'store', storeContractVersion: 1, rows: {store_products: storeProducts, store_orders: [], store_order_items: []}};
    const fillCheckout = "document.querySelector('#storeCheckoutForm [name=customer_name]').value='مستلم الاختبار';document.querySelector('#storeCheckoutForm [name=phone]').value='0910000000';document.querySelector('#storeCheckoutForm [name=city]').value='طرابلس';document.querySelector('#storeCheckoutForm [name=address]').value='عنوان محاكاة للتسليم فقط';";
    await scenario('store empty catalog and missing contract deny programmatic writes', async () => {
      const empty = await page({hash: 'store', storeContractVersion: 1});
      await empty.until("document.querySelector('#storeProducts').textContent.includes('لا توجد منتجات')", 'empty store catalog');
      assert.equal(await empty.evaluate("document.querySelector('#storeProducts article')!==null"), false, 'No fabricated products');
      await empty.close();
      const denied = await page({...storeOptions, storeContractVersion: 0});
      await denied.until("document.querySelector('#storeProducts article')", 'inactive store read');
      assert.equal(await denied.evaluate("document.querySelector('#storeCheckoutButton').disabled"), true);
      await denied.evaluate(`${fillCheckout}document.querySelector('#storeProducts button').disabled=false;document.querySelector('#storeProducts button').click();document.querySelector('#storeCheckoutButton').disabled=false;document.querySelector('#storeCheckoutForm').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`);
      await pause(100);
      assert.equal(await denied.evaluate("window.__qa.calls.some(c=>c.type==='rpc'&&c.name==='checkout_store_order'||c.table==='store_products'&&c.operation!=='select')"), false);
      await denied.close();
    });
    await scenario('store filtering, text rendering and three-decimal LYD cart', async () => {
      const unsafe = '<svg onload="window.__storeXSS=1">';
      const p = await page({...storeOptions, rows: {...storeOptions.rows, store_products: [{...storeProducts[0], title: unsafe}, storeProducts[1]]}});
      await p.until("document.querySelectorAll('#storeProducts article').length===2", 'store products loaded');
      assert.equal(await p.evaluate("document.querySelector('#storeProducts svg')!==null||!!window.__storeXSS"), false);
      assert.ok(await p.evaluate("document.querySelector('#storeProducts').textContent.includes((9).toLocaleString('ar-LY',{minimumFractionDigits:3,maximumFractionDigits:3}))"), 'Whole LYD prices retain three decimal places');
      await p.evaluate("document.querySelector('#storeFilters [name=category]').value='رعاية منزلية';document.querySelector('#storeFilters').dispatchEvent(new Event('input',{bubbles:true}))");
      assert.equal(await p.evaluate("document.querySelectorAll('#storeProducts article').length"), 1);
      await p.evaluate("document.querySelector('#storeProducts button').click()");
      assert.equal(await p.evaluate("document.querySelector('#storeCartItems').textContent.includes('الكمية: 1')"), true);
      assert.ok(await p.evaluate("document.querySelector('#storeCartTotal').textContent.includes((1.005).toLocaleString('ar-LY',{minimumFractionDigits:3,maximumFractionDigits:3}))"), '1005 minor units display as 1.005 LYD');
      assert.equal(await p.evaluate("document.querySelector('#store input[autocomplete=cc-number],#store input[name*=card],#store input[name*=payment]')!==null"), false, 'Cash on delivery needs no card fields');
      await p.evaluate("document.querySelector('#storeFilters [name=search]').value='بحث لا يطابق';document.querySelector('#storeFilters').dispatchEvent(new Event('input',{bubbles:true}))");
      assert.equal(await p.evaluate("document.querySelector('#storeProducts').textContent.includes('لا توجد منتجات تطابق')"), true);
      await p.close();
    });
    await scenario('COD checkout recovers lost response by owner UUID despite subsequent catalog changes', async () => {
      const p = await page(storeOptions);
      await p.until("document.querySelector('#storeProducts button')&&!document.querySelector('#storeProducts button').disabled", 'store cart available');
      await p.evaluate(`window.__qa.rpcHandler=(name,payload,owner)=>{
        const q=window.__qa;if(name==='nurse_store_contract_version')return {data:1,error:null};
        if(name==='checkout_store_order'){
          const product=q.rows.store_products.find(row=>row.id===payload.p_items[0].product_id);
          const order={id:payload.p_order_id,user_id:owner,customer_name:payload.p_customer_name,phone:payload.p_phone,city:payload.p_city,address:payload.p_address,notes:null,status:'pending',total_minor:product.price_minor*payload.p_items[0].quantity,currency:'LYD',payment_method:'cash_on_delivery',created_at:'2026-10-07T10:02:00Z',updated_at:'2026-10-07T10:02:00Z',cancelled_at:null};
          q.rows.store_orders.push(order);q.rows.store_order_items.push({order_id:order.id,product_id:product.id,title:product.title,quantity:payload.p_items[0].quantity,unit_price_minor:product.price_minor,currency:'LYD',line_total_minor:order.total_minor});
          return {data:null,error:{message:'Synthetic response lost',code:'NETWORK'}};
        }return {data:null,error:null};
      };document.querySelector('#storeProducts button').click();${fillCheckout}document.querySelector('#storeCheckoutForm').requestSubmit();document.querySelector('#storeCheckoutForm').requestSubmit()`);
      await p.until("document.querySelector('#storeCheckoutState').textContent.includes('احتُفظ')", 'ambiguous order retained');
      const calls = await p.evaluate("window.__qa.calls.filter(c=>c.type==='rpc'&&c.name==='checkout_store_order')");
      assert.equal(calls.length, 1, 'One atomic checkout under duplicate submission');
      assert.equal(calls[0].payload.p_items[0].expected_unit_price_minor, 1005);
      assert.equal(Object.hasOwn(calls[0].payload, 'user_id'), false);
      assert.equal(Object.hasOwn(calls[0].payload, 'payment_status'), false);
      await p.evaluate("window.__qa.rows.store_products[0].stock_quantity=0;window.__qa.rows.store_products[0].price_minor=7000;document.querySelector('#storeCheckoutForm [name=address]').value='عنوان تم تغييره برمجيًا';document.querySelector('#storeCheckoutForm').requestSubmit()");
      await p.until("location.hash==='#orders'&&document.querySelector('#storeOrdersList article')", 'saved COD order recovered');
      assert.equal(await p.evaluate("window.__qa.calls.filter(c=>c.name==='checkout_store_order').length"), 1, 'Recovery does not create another checkout');
      assert.equal(await p.evaluate("window.__qa.rows.store_orders.length"), 1);
      assert.equal(await p.evaluate("document.querySelector('#storeOrdersList').textContent.includes('الدفع نقدًا عند التسليم')"), true);
      assert.equal(await p.evaluate("/مدفوع|تم الدفع|paid/i.test(document.querySelector('#storeOrdersList').textContent)"), false);
      await p.evaluate("document.querySelector('#storeOrdersList button').click()");
      await p.until("document.querySelector('#storeOrdersList').textContent.includes('عنوان محاكاة للتسليم فقط')", 'saved canonical address shown');
      assert.equal(await p.evaluate("document.querySelector('#storeOrdersList').textContent.includes('عنوان تم تغييره')"), false);
      await p.close();
    });
    await scenario('refreshed unavailable stock blocks checkout and preserves a review warning', async () => {
      const p = await page(storeOptions);
      await p.until("document.querySelector('#storeProducts button')&&!document.querySelector('#storeProducts button').disabled", 'stock available');
      await p.evaluate(`document.querySelector('#storeProducts button').click();window.__qa.rows.store_products[0].stock_quantity=0;document.querySelector('#store .section-head button').click();${fillCheckout}`);
      await p.until("document.querySelector('#storeProducts article').textContent.includes('غير متوفر')", 'stock refresh visible');
      await p.evaluate("document.querySelector('#storeCheckoutForm').requestSubmit()");
      await p.until("document.querySelector('#storeCheckoutState').textContent.includes('تغيّر توفر')", 'review stock warning');
      assert.equal(await p.evaluate("window.__qa.calls.some(c=>c.name==='checkout_store_order')"), false);
      await p.close();
    });
    await scenario('store administration checks stored role and owner orders discard late data', async () => {
      const denied = await page({...storeOptions, hash: 'store-admin', spoofAdmin: true});
      await denied.until("document.querySelector('#storeAdminState').textContent.includes('المعتمدة')", 'stored role denial');
      assert.equal(await denied.evaluate("document.querySelector('#storeAdminPanel').hidden"), true);
      await denied.evaluate("document.querySelector('#storeProductForm').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))");
      assert.equal(await denied.evaluate("window.__qa.calls.some(c=>c.table==='store_products'||c.name==='transition_store_order')"), false);
      await denied.close();
      const privateOrder = {id: '88888888-8888-4888-8888-888888888888', user_id: messageOwner, customer_name: 'PRIVATE STORE OWNER A', phone: '+218910000000', city: 'طرابلس', address: 'PRIVATE ADDRESS OWNER A', status: 'pending', total_minor: 1005, currency: 'LYD', payment_method: 'cash_on_delivery', created_at: '2026-10-07T10:00:00Z'};
      const p = await page({...storeOptions, hash: 'home', rows: {...storeOptions.rows, store_orders: [privateOrder]}});
      await p.evaluate("window.__qa.defer.push('store_orders');location.hash='orders'");
      await p.until("window.__qa.pending.store_orders?.length", 'own order request pending');
      await p.evaluate(`window.__qa.defer=[];window.__qa.emit('SIGNED_IN',${JSON.stringify(messageOther)});window.__qa.release('store_orders')`);
      await pause(200);
      assert.equal(await p.evaluate("document.body.textContent.includes('PRIVATE STORE OWNER A')||document.body.textContent.includes('PRIVATE ADDRESS OWNER A')"), false);
      assert.equal(await p.evaluate(`document.querySelector('#storeOrdersList').textContent.includes(${JSON.stringify(privateOrder.id)})`), false);
      assert.equal(await p.evaluate("document.querySelector('#storeCheckoutForm [name=address]').value"), '');
      assert.equal(await p.evaluate("Object.keys(localStorage).length+Object.keys(sessionStorage).length"), 0, 'No private shop state persists across accounts');
      await p.close();
    });
    await scenario('store, orders and administration responsive forms (390 / 1440)', async () => {
      for (const width of [390, 1440]) {
        const p = await page({...storeOptions, width, admin: true});
        await p.until("document.querySelector('#storeProducts article')", 'mock store ready');
        await p.until("document.querySelector('#storeProducts img').complete&&document.querySelector('#storeProducts img').naturalWidth===4000", 'oversized synthetic product image decoded');
        await p.checkOverflow(`store ${width}`);
        await mockPreview(p, width === 390 ? 'preview-store-mobile.png' : 'preview-store-desktop.png');
        for (const hash of ['orders', 'store-admin']) {
          await p.route(hash);
          assert.equal(await p.evaluate(`document.getElementById(${JSON.stringify(hash)})?.hidden`), false);
          await p.checkOverflow(`${hash} ${width}`);
        }
        await p.until("document.querySelector('#storeAdminPanel')&&!document.querySelector('#storeAdminPanel').hidden", 'stored administrator loaded');
        const unlabeled = await p.evaluate("[...document.querySelectorAll('#store input,#store select,#store textarea,#store-admin input,#store-admin select,#store-admin textarea')].filter(el=>!el.labels?.length&&!el.getAttribute('aria-label')&&!el.getAttribute('aria-labelledby')).map(el=>el.id||el.name)");
        assert.deepEqual(unlabeled, []);
        await p.close();
      }
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
