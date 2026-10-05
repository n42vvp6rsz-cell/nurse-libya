const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const {parseHTML} = require('linkedom');
const source = fs.readFileSync('app.js','utf8');
const html = fs.readFileSync('index.html','utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function setup(options = {}) {
  const {document} = parseHTML(html);
  const calls = [];
  let listener;
  const user = {id:'test-user',email:'test@example.invalid',user_metadata:{full_name:'مستخدم تجريبي'}};
  const session = options.signedIn ? {user} : null;
  const auth = {
    onAuthStateChange(fn){listener=fn;return {data:{subscription:{unsubscribe(){}}}};},
    async getSession(){return {data:{session},error:null};},
    async signInWithPassword(value){calls.push(['login',value]);return {data:{session:{user},user},error:null};},
    async signUp(value){calls.push(['signup',value]);return {data:{user,session:null},error:null};},
    async resetPasswordForEmail(...value){calls.push(['reset',value]);return {error:null};},
    async updateUser(value){calls.push(['password',value]);return {error:null};},
    async signOut(){calls.push(['logout']);listener('SIGNED_OUT',null);return {error:null};}
  };
  const client = {auth,from(table){
    const chain = {
      select(){return chain;},eq(){return chain;},order(){return table === 'services' ? Promise.resolve({data:[{name:'تمريض منزلي',description:'رعاية منزلية'},{name:'الأطباء',description:'تنسيق موعد'},{name:'المستشفيات',description:'تنسيق خدمة'}],error:null}) : chain;},
      async single(){return {data:{full_name:'الاسم المعتمد',phone:'0910000000'},error:options.profileError?{code:'42P17'}:null};},
      async limit(){return options.bookingPromise || {data:options.bookings||[],error:options.bookingError?{}:null};},
      async insert(value){calls.push(['insert',value]);return {error:null};}
    };return chain;
  }};
  const location = {hash:options.hash||'',origin:'https://example.invalid',pathname:'/nurse-libya/'};
  document.querySelectorAll('form').forEach(form=>{form.reset=()=>form.querySelectorAll('input,textarea').forEach(el=>el.value='');});
  document.getElementById('bookingService').add = option => document.getElementById('bookingService').append(option);
  document.getElementById('services').scrollIntoView=()=>{};
  const timers = [];
  const sandbox = {document,location,history:{replaceState(a,b,value){location.hash=value.slice(value.indexOf('#'));}},
    URLSearchParams, Intl, Date, console,
    setTimeout(fn,ms){if(ms===0)timers.push(fn);return 1;},clearTimeout(){},
    FormData:class {constructor(form){this.values=form.testValues||{};}get(key){return this.values[key]??'';}},
    Option:function(name,value){const el=document.createElement('option');el.textContent=name;el.value=value;return el;},
    NURSE_LIBYA_CONFIG:{supabaseUrl:'https://example.invalid',supabasePublishableKey:'public-test-key'},
    supabase:options.noSDK?undefined:{createClient(){return client;}},
    scrollTo(){},addEventListener(){}
  };
  sandbox.window=sandbox;
  vm.createContext(sandbox);vm.runInContext(source,sandbox);await tick();
  const submit=async(id,values)=>{const form=document.getElementById(id);form.testValues=values;form.onsubmit({preventDefault(){},currentTarget:form});await tick();};
  const emit=async(event,newSession)=>{listener(event,newSession);timers.splice(0).forEach(fn=>fn());await tick();};
  return {sandbox,document,calls,user,submit,emit,run:code=>vm.runInContext(code,sandbox)};
}
test('guest routing protects bookings and service cards exist',async()=>{
 const a=await setup({hash:'#bookings'});assert.equal(a.document.querySelectorAll('#serviceGrid article').length,3);assert.equal(a.document.getElementById('login').hidden,false);assert.equal(a.document.getElementById('bookings').hidden,true);
});
test('missing SDK leaves services available with a visible error',async()=>{
 const a=await setup({noSDK:true});assert.equal(a.document.getElementById('connection').hidden,false);assert.equal(a.document.getElementById('home').hidden,false);
});
test('signup without session never authenticates; profession cannot grant a role',async()=>{
 const a=await setup();await a.submit('registerForm',{name:'اسم',phone:'0910000000',email:'test@example.invalid',password:'  Password99  ',role:'admin'});
 const payload=a.calls.find(c=>c[0]==='signup')[1];assert.equal(payload.options.data.role,'patient');assert.equal(payload.password,'  Password99  ');assert.equal(a.run('currentUser'),null);assert.equal(a.sandbox.location.hash,'login');
});
test('login preserves password spaces and resumes chosen service',async()=>{
 const a=await setup();a.run("pendingService = 'تمريض منزلي'");await a.submit('loginForm',{email:' test@example.invalid ',password:'  Password99  '});assert.equal(a.calls[0][1].password,'  Password99  ');assert.equal(a.calls[0][1].email,'test@example.invalid');assert.equal(a.sandbox.location.hash,'booking');
});
test('booking validates date and writes only current user ownership',async()=>{
 const a=await setup({signedIn:true});const data={service:'تمريض منزلي',name:'المستفيد',phone:'0910000000',notes:'',date:'2000-01-01'};
 await a.submit('bookingForm',data);assert.equal(a.calls.length,0);
 data.date='2099-01-01';await a.submit('bookingForm',data);assert.equal(a.calls[0][1].user_id,'test-user');assert.equal(a.calls[0][1].status,'pending');
});
test('booking data is rendered as text and both status formats work',async()=>{
 const a=await setup({signedIn:true,bookings:[{service:'<img src=x onerror=alert(1)>',booking_date:'2026-10-05',status:'قيد المراجعة'},{service:'رعاية',booking_date:'2026-10-06',status:'confirmed'}]});await a.run('loadBookings()');
 const list=a.document.getElementById('bookingsList');assert.equal(list.querySelector('img'),null);assert.match(list.textContent,/<img/);assert.equal(list.querySelector('[data-status="pending"]').textContent,'قيد المراجعة');assert.equal(list.querySelector('[data-status="confirmed"]').textContent,'تم التأكيد');
});
test('late bookings response cannot reveal data after signout',async()=>{
 let resolve;const pending=new Promise(r=>resolve=r);const a=await setup({signedIn:true,bookingPromise:pending});const request=a.run('loadBookings()');await a.emit('SIGNED_OUT',null);resolve({data:[{service:'private',status:'pending',booking_date:'2026-10-05'}],error:null});await request;assert.equal(a.document.getElementById('bookingsList').textContent,'');
});
test('recovery opens password form, mismatch blocks save, reset preserves base path',async()=>{
 const a=await setup();await a.submit('forgotForm',{email:'test@example.invalid'});assert.equal(a.calls[0][1][1].redirectTo,'https://example.invalid/nurse-libya/');
 await a.emit('PASSWORD_RECOVERY',{user:a.user});assert.equal(a.document.getElementById('password').hidden,false);
 await a.submit('passwordForm',{password:'Password99',confirm:'other'});assert.equal(a.calls.filter(c=>c[0]==='password').length,0);
 await a.submit('passwordForm',{password:'Password99',confirm:'Password99'});assert.equal(a.calls.filter(c=>c[0]==='password').length,1);assert.equal(a.run('recovery'),false);
});
test('profile and booking failures show useful error states',async()=>{
 const a=await setup({signedIn:true,profileError:true,bookingError:true});await a.run('loadBookings()');assert.match(a.document.getElementById('profileState').textContent,/تعذّر/);assert.match(a.document.getElementById('bookingsList').textContent,/تعذّر/);
});
