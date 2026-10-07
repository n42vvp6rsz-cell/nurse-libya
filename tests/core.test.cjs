const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const {parseHTML} = require('linkedom');
const {webcrypto} = require('node:crypto');
const source = fs.readFileSync('app.js','utf8');
const html = fs.readFileSync('index.html','utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve,reject; const promise = new Promise((ok,fail) => {resolve=ok;reject=fail;}); return {promise,resolve,reject}; }
const userA = {id:'00000000-0000-4000-8000-000000000001',email:'a@example.invalid',user_metadata:{full_name:'مستخدم ألف'}};
const userB = {id:'00000000-0000-4000-8000-000000000002',email:'b@example.invalid',user_metadata:{full_name:'مستخدم باء'}};
async function setup(options = {}) {
  const {document} = parseHTML(html);
  const calls=[], timers=[], records=new Map(), handlers={};
  let listener, clock = Date.parse('2026-10-07T12:00:00Z');
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() {return clock;} }
  const auth = {
    onAuthStateChange(fn) { listener=fn; return {data:{subscription:{unsubscribe(){}}}}; },
    getSession: () => options.sessionPromise || Promise.resolve({data:{session:options.signedIn?{user:userA}:null},error:null}),
    async signInWithPassword(value) { calls.push(['login',value]); if(options.login) return options.login(value); listener('SIGNED_IN',{user:userA}); return {data:{session:{user:userA}},error:null}; },
    async signUp(value) { calls.push(['signup',value]); if(options.signupSession) listener('SIGNED_IN',{user:userA}); return {data:{session:options.signupSession?{user:userA}:null},error:null}; },
    async resetPasswordForEmail(...value) {calls.push(['reset',value]); return {error:null};},
    async updateUser(value) {calls.push(['password',value]); return options.password ? options.password(value) : {error:null};},
    async signOut() {listener('SIGNED_OUT',null); return {error:null};}
  };
  const client = {auth,from(table) {
    const query={table,filters:[],columns:'',update:null};
    const chain={
      select(columns) {query.columns=columns;return chain;},
      eq(column,value) {query.filters.push([column,value]);return chain;},
      order() {return table==='services' ? options.servicesPromise||Promise.resolve({data:options.services||[{name:'تمريض منزلي',slug:'home-nursing',description:'رعاية'}],error:null}) : chain;},
      limit() {calls.push(['bookings-read',query]);return Promise.resolve({data:[...records.values()].filter(row=>query.filters.every(([key,value])=>row[key]===value)),error:null});},
      async single() {
        const id=query.filters.find(([key])=>key==='id')?.[1];
        if(query.update) return options.profileUpdate ? options.profileUpdate(query) : {data:{id,...query.update},error:null};
        return options.profileRead ? options.profileRead(query) : {data:{full_name:id===userA.id?'اسم ألف':'اسم باء',phone:'0912345678'},error:null};
      },
      async maybeSingle() {
        calls.push(['booking-find',query]);
        if(options.findBooking) return options.findBooking(query,records,calls);
        const row=[...records.values()].find(item=>query.filters.every(([key,value])=>item[key]===value));
        return {data:row||null,error:null};
      },
      update(value) {query.update=value;calls.push(['profile-update',value,query]);return chain;},
      async insert(value) {calls.push(['booking-insert',value]);if(options.insert) return options.insert(value,records,calls);records.set(value.id,{...value});return {error:null};}
    };
    return chain;
  }};
  document.querySelectorAll('form').forEach(form=>{form.reset=()=>form.querySelectorAll('input,textarea').forEach(el=>el.value='');});
  document.querySelectorAll('select').forEach(select=>Object.defineProperty(select,'value',{get(){return [...select.querySelectorAll('option')].find(option=>option.hasAttribute('selected'))?.value||'';},set(value){select.querySelectorAll('option').forEach(option=>{if(option.value===String(value))option.setAttribute('selected','');else option.removeAttribute('selected');});}}));
  document.getElementById('bookingService').add=option=>{const select=document.getElementById('bookingService');if(!select.querySelector('[selected]'))option.setAttribute('selected','');select.append(option);};
  document.getElementById('services').scrollIntoView=()=>{};
  const location={hash:options.hash||'',search:options.search||'',origin:'https://example.invalid',pathname:'/nurse-libya/'};
  const sandbox={document,location,history:{replaceState(a,b,value){location.hash=value.slice(value.indexOf('#'));}},URLSearchParams,Intl,Date:ClockDate,console,crypto:webcrypto,
    setTimeout(fn,ms){if(ms===0)timers.push(fn);return timers.length;},clearTimeout(){},
    FormData:class {constructor(form){this.values=form.testValues||{};}get(key){return this.values[key]??'';}},
    Option:function(name,value){const el=document.createElement('option');el.textContent=name;el.value=value;return el;},
    NURSE_LIBYA_CONFIG:{supabaseUrl:'https://example.invalid',supabasePublishableKey:'public-test-key'},supabase:{createClient(){return client;}},scrollTo(){},addEventListener(name,fn){handlers[name]=fn;}};
  sandbox.window=sandbox;vm.createContext(sandbox);vm.runInContext(source,sandbox);
  async function pump(){await tick();for(let round=0;round<5&&timers.length;round++){timers.splice(0).forEach(fn=>fn());await tick();}}
  await pump();
  const start=(id,values)=>{const form=document.getElementById(id);form.testValues=values;form.onsubmit({preventDefault(){},currentTarget:form});};
  return {document,sandbox,calls,records,pump,start,run:code=>vm.runInContext(code,sandbox),setClock(value){clock=Date.parse(value);},async submit(id,values){start(id,values);await pump();},async emit(event,session){listener(event,session);await pump();},async event(name){handlers[name]?.();await pump();}};
}
const booking = overrides => ({service:'تمريض منزلي',name:'محمد علي',phone:'٠٩١٢٣٤٥٦٧٨',date:'2026-10-08',notes:'وصف لوجستي',...overrides});
test('a late session snapshot or INITIAL_SESSION never overrides the latest account event',async()=>{
  const snapshot=deferred(),a=await setup({sessionPromise:snapshot.promise});
  await a.emit('SIGNED_IN',{user:userB});snapshot.resolve({data:{session:{user:userA}},error:null});await a.pump();
  await a.emit('INITIAL_SESSION',{user:userA});
  assert.equal(a.sandbox.NurseApp.currentUser.id,userB.id);assert.equal(a.sandbox.NurseApp.authReady,true);assert.ok(a.sandbox.NurseApp.client);
});
test('session rejection completes guest initialization and keeps login usable',async()=>{
  const snapshot=deferred(),a=await setup({sessionPromise:snapshot.promise,hash:'#login'});snapshot.reject(new Error('Synthetic session storage error'));await a.pump();
  assert.equal(a.sandbox.NurseApp.authReady,true);assert.equal(a.sandbox.NurseApp.currentUser,null);assert.ok(a.sandbox.NurseApp.client);
  await a.submit('loginForm',{email:'a@example.invalid',password:' Password99 '});assert.equal(a.sandbox.NurseApp.currentUser.id,userA.id);assert.equal(a.sandbox.location.hash,'home');
});
test('real auth events before login and signup responses leave their entry screens',async()=>{
  const a=await setup({hash:'#login'});await a.submit('loginForm',{email:'a@example.invalid',password:' Password99 '});
  assert.equal(a.sandbox.location.hash,'home');assert.equal(a.document.getElementById('home').hidden,false);
  const b=await setup({hash:'#register',signupSession:true});await b.submit('registerForm',{name:'محمد علي',phone:'٠٩١٢٣٤٥٦٧٨',email:'a@example.invalid',password:'Password99',role:'doctor'});
  assert.equal(b.sandbox.location.hash,'home');assert.equal(b.calls.find(call=>call[0]==='signup')[1].options.data.role,'patient');
});
test('late login results cannot restore a superseded account or its success UI',async()=>{
  const login=deferred(),a=await setup({hash:'#login',login:()=>login.promise});a.start('loginForm',{email:'a@example.invalid',password:'Password99'});
  await a.emit('SIGNED_IN',{user:userB});login.resolve({data:{session:{user:userA}},error:null});await a.pump();
  assert.equal(a.sandbox.NurseApp.currentUser.id,userB.id);assert.doesNotMatch(a.document.getElementById('toast').textContent,/تم تسجيل الدخول بنجاح/);
});
test('names require real letters, phones normalize digits, and nonexistent dates never insert',async()=>{
  const a=await setup({signedIn:true});
  for(const invalid of [booking({name:'۞۞'}),booking({name:'٠١'}),booking({phone:'1111111111'}),booking({date:'2028-02-31'}),booking({date:'2027-02-29'})]) await a.submit('bookingForm',invalid);
  assert.equal(a.calls.filter(call=>call[0]==='booking-insert').length,0);
  await a.submit('bookingForm',booking({name:'Cafe\u0301 علي',date:'2028-02-29'}));
  const payload=a.calls.find(call=>call[0]==='booking-insert')[1];assert.equal(payload.patient_name,'Café علي');assert.equal(payload.phone,'0912345678');assert.match(payload.id,/^[0-9a-f-]{36}$/);
});
test('duplicate submissions create one UUID and ambiguous retry retains the exact payload',async()=>{
  let count=0;const pending=deferred();
  const a=await setup({signedIn:true,insert:async(value,records)=>{count++;if(count===1)return pending.promise;records.set(value.id,{...value});return {error:null};}});
  a.start('bookingForm',booking());a.start('bookingForm',booking({name:'اسم مختلف'}));await a.pump();assert.equal(count,1);
  pending.reject(new Error('Synthetic network failure'));await a.pump();
  assert.equal(a.document.getElementById('bookingName').disabled,true);
  await a.submit('bookingForm',booking({name:'تغيير غير مقصود',notes:'different'}));
  const writes=a.calls.filter(call=>call[0]==='booking-insert');assert.equal(writes.length,2);assert.equal(writes[0][1].id,writes[1][1].id);assert.deepEqual(writes[0][1],writes[1][1]);
});
test('lost successful response is recovered by own UUID before now-past date validation',async()=>{
  let lookup=0;const a=await setup({signedIn:true,insert:async(value,records)=>{records.set(value.id,{...value});throw new Error('Synthetic lost response');},findBooking:(query,records)=>{
    if(++lookup===1)return {data:null,error:{message:'Synthetic lookup offline'}};
    return {data:[...records.values()].find(row=>query.filters.every(([key,value])=>row[key]===value))||null,error:null};}});
  await a.submit('bookingForm',booking());a.setClock('2026-10-10T12:00:00Z');await a.submit('bookingForm',{});
  assert.equal(a.calls.filter(call=>call[0]==='booking-insert').length,1);assert.equal(a.run('bookingAttempt'),null);assert.equal(a.sandbox.location.hash,'bookings');
  assert.match(a.document.getElementById('bookingReference').textContent,/مرجع الطلب/);
  for(const call of a.calls.filter(call=>call[0]==='booking-find'))assert.ok(call[1].filters.some(([key,value])=>key==='user_id'&&value===userA.id));
});
test('A to B to A discards pending references and an old finally cannot unlock a new save',async()=>{
  const old=deferred(),fresh=deferred();let count=0;const a=await setup({signedIn:true,insert:()=>++count===1?old.promise:fresh.promise});
  a.start('bookingForm',booking());await a.pump();await a.emit('SIGNED_IN',{user:userB});await a.emit('SIGNED_IN',{user:userA});
  assert.equal(a.document.getElementById('bookingReference').textContent,'');a.start('bookingForm',booking({notes:'new attempt'}));await a.pump();
  old.resolve({error:null});await a.pump();assert.equal(a.document.getElementById('bookingName').disabled,true);assert.doesNotMatch(a.document.getElementById('bookingState').textContent,/تم حفظ/);
  fresh.resolve({error:null});await a.pump();assert.match(a.document.getElementById('bookingState').textContent,/تم حفظ/);
});
test('profile edits save only normalized own display fields and reject zero matched updates',async()=>{
  let result={data:null,error:null};const a=await setup({signedIn:true,profileUpdate:()=>result});
  await a.submit('profileForm',{full_name:'Cafe\u0301 علي',phone:'٠٩١٢٣٤٥٦٧٨',role:'admin'});
  const call=a.calls.find(call=>call[0]==='profile-update');assert.deepEqual(JSON.parse(JSON.stringify(call[1])),{full_name:'Café علي',phone:'0912345678'});assert.ok(call[2].filters.some(([key,value])=>key==='id'&&value===userA.id));assert.equal(a.document.getElementById('profileSaveState').textContent,'');
  result={data:{id:userA.id,full_name:'Café علي',phone:'0912345678'},error:null};await a.submit('profileForm',{full_name:'Cafe\u0301 علي',phone:'٠٩١٢٣٤٥٦٧٨'});assert.match(a.document.getElementById('profileSaveState').textContent,/تم حفظ/);
});
test('late profile saves do not populate another account or reset its editor',async()=>{
  const save=deferred(),a=await setup({signedIn:true,profileUpdate:()=>save.promise});a.start('profileForm',{full_name:'اسم ألف',phone:'0912345678'});await a.pump();
  await a.emit('SIGNED_IN',{user:userB});save.resolve({data:{id:userA.id,full_name:'اسم ألف الخاص',phone:'0912345678'},error:null});await a.pump();
  assert.doesNotMatch(a.document.getElementById('profileName').textContent,/الخاص/);assert.equal(a.document.getElementById('profileSaveState').textContent,'');
});
test('booking intent and public provider survive login and confirmation callbacks',async()=>{
  const provider='00000000-0000-4000-8000-000000000099';const a=await setup({hash:'#booking?service=home-nursing&provider='+provider});
  await a.submit('registerForm',{name:'محمد علي',phone:'0912345678',email:'a@example.invalid',password:'Password99',role:'doctor'});
  const redirect=a.calls.find(call=>call[0]==='signup')[1].options.emailRedirectTo;assert.match(redirect,/return=booking/);assert.match(redirect,/provider=/);
  await a.submit('loginForm',{email:'a@example.invalid',password:'Password99'});assert.match(a.sandbox.location.hash,/^booking\?service=/);assert.equal(a.document.getElementById('bookingService').value,'تمريض منزلي');
  await a.submit('bookingForm',booking());assert.equal(a.calls.find(call=>call[0]==='booking-insert')[1].provider_profile_id,provider);
});
test('provider deep links survive a catalog that resolves after authenticated routing',async()=>{
  const catalog=deferred(),provider='00000000-0000-4000-8000-000000000099';
  const a=await setup({signedIn:true,hash:'#booking?service=home-nursing&provider='+provider,servicesPromise:catalog.promise});
  assert.equal(a.run('pendingProviderId'),provider);assert.equal(a.document.getElementById('bookingForm').querySelector('button[type="submit"],button:not([type])').disabled,true);
  catalog.resolve({data:[{name:'تمريض منزلي',slug:'home-nursing',description:'رعاية'}],error:null});await a.pump();
  assert.equal(a.run('pendingProviderId'),provider);assert.equal(a.document.getElementById('bookingService').value,'تمريض منزلي');
  await a.submit('bookingForm',booking());assert.equal(a.calls.find(call=>call[0]==='booking-insert')[1].provider_profile_id,provider);
});
test('late modular route registration resumes a safe confirmation target',async()=>{
  const a=await setup({signedIn:true,search:'?return=courses'});assert.equal(a.run('pendingPage'),'courses');
  const section=a.document.createElement('section');section.id='courses';section.className='screen';a.document.getElementById('main').append(section);
  let entered=0;a.sandbox.NurseApp.registerRoute('courses',{onEnter(){entered++;}});assert.equal(a.sandbox.location.hash,'courses');assert.equal(section.hidden,false);assert.ok(entered);
  const b=await setup({signedIn:true,search:'?return=https://evil.invalid'});assert.notEqual(b.sandbox.location.hash,'https://evil.invalid');
});
test('missing or ambiguous service links cannot silently book another service',async()=>{
  const a=await setup({signedIn:true,hash:'#booking?service=missing'});assert.equal(a.document.getElementById('bookingService').value,'');
  await a.submit('bookingForm',booking({service:''}));assert.equal(a.calls.filter(call=>call[0]==='booking-insert').length,0);
  const b=await setup({signedIn:true,services:[{name:'خدمة',slug:'one'},{name:'خدمة',slug:'two'}]});
  b.sandbox.NurseApp.chooseService('one');await b.submit('bookingForm',booking({service:'خدمة'}));assert.equal(b.calls.filter(call=>call[0]==='booking-insert').length,0);assert.equal(b.document.querySelectorAll('#bookingService option').length,0);
});
