const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const {parseHTML}=require('linkedom');
const source=fs.readFileSync('catalog.js','utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(fn=>resolve=fn);return {promise,resolve};};
const doctor={id:'doctor-1',profile_id:'provider-1',name:'طبيب عام',specialty:'طب عام',city:'طرابلس',bio:'رعاية',verified:true};
const nurse={id:'nurse-1',profile_id:'provider-2',name:'ممرضة',city:'بنغازي',specialty:'تمريض',verified:true,available_for_home_visits:true};
const job={id:'job-1',title:'ممرض',organization_name:'مؤسسة',description:'فرصة عمل',city:'طرابلس',status:'active',expires_at:null};
const course={id:'course-1',title:'تدريب مجاني',provider_name:'مركز',description:'مهارات',status:'active',review_status:'approved',is_free:true,seats:10,end_date:'2099-01-01'};
async function setup(options={}) {
  const {document}=parseHTML('<html dir="rtl"><body><section id="providers"></section><section id="organizations"></section><section id="jobs"></section><section id="courses"></section></body></html>');
  const tables={doctors:[doctor],nurses:[nurse],organizations:[],hospitals:[],laboratories:[],pharmacies:[],jobs:[job],courses:[course],job_applications:[],course_enrollments:[],...options.tables};
  const calls=[],toasts=[],routes={},listeners=[];let user=options.signedIn?{id:'owner-a'}:null,version=0;
  const client={from(table){
    const call={table,op:'select',filters:[]};calls.push(call);
    const chain={
      select(columns){call.columns=columns;return chain;},eq(column,value){call.filters.push([column,value]);return chain;},in(column,values){call.filters.push([column,values]);return chain;},or(value){call.or=value;return chain;},order(column,value){call.order=[column,value];return chain;},limit(value){call.limit=value;return run('many');},maybeSingle(){return run('single');},single(){return run('single');},insert(value){call.op='insert';call.payload=value;return chain;},update(value){call.op='update';call.payload=value;return chain;}
    };
    async function run(shape) {
      if(options.handler){const result=await options.handler(call,shape,tables);if(result!==undefined)return result;}
      let rows=(tables[table]||[]).filter(row=>call.filters.every(([column,value])=>Array.isArray(value)?value.includes(row[column]):row[column]===value));
      if(call.op==='insert') {const row={id:`saved-${table}`,created_at:'2026-10-07',enrolled_at:'2026-10-07',...call.payload};tables[table].push(row);rows=[row];}
      if(call.op==='update')rows.forEach(row=>Object.assign(row,call.payload));
      return {data:shape==='single'?rows[0]||null:rows.slice(0,call.limit||rows.length),error:null};
    }
    return chain;
  }};
  const app={client,authReady:true,get currentUser(){return user;},get userVersion(){return version;},isCurrent(id,expected){return user?.id===id&&version===expected;},registerRoute(key,value){routes[key]=value;},onUserChange(fn){listeners.push(fn);},showToast(message){toasts.push(message);},chooseService(...values){calls.push({action:'chooseService',values});},requireLogin(page){calls.push({action:'login',page});}};
  const location={hash:options.hash||'#home'};
  const sandbox={window:{NurseApp:app},document,location,console,Intl,Date,URL,Set};vm.createContext(sandbox);vm.runInContext(source,sandbox);
  const enter=async key=>{location.hash=`#${key}`;routes[key].onEnter();await tick();await tick();};
  const change=async value=>{user=value;version++;listeners.forEach(fn=>fn(user,version));await tick();await tick();};
  const click=async element=>{element.onclick();await tick();await tick();};
  return {document,calls,toasts,tables,app,enter,change,click};
}
test('public queries are bounded, explicitly verified, and omit private contacts/profiles',async()=>{
  const a=await setup();await a.enter('providers');await a.enter('organizations');
  for(const call of a.calls){assert.equal(call.limit,200);assert.ok(!/phone|email|\*/.test(call.columns));assert.notEqual(call.table,'profiles');assert.ok(call.filters.some(([column,value])=>column==='verified'&&value===true||column==='verification_status'&&value==='verified'));}
  assert.match(a.document.getElementById('providersResults').textContent,/طبيب عام/);
  assert.equal(a.document.getElementById('providersCity').querySelectorAll('option').length,14);
});
test('provider search and profession/city filters render only matching plain text',async()=>{
  const a=await setup({tables:{doctors:[{...doctor,name:'<img src=x onerror=alert(1)>'}]}});await a.enter('providers');
  const results=a.document.getElementById('providersResults');assert.equal(results.querySelector('img'),null);assert.match(results.textContent,/<img/);
  const city=a.document.getElementById('providersCity');Object.defineProperty(city,'value',{value:'بنغازي',writable:true});city.parentElement.parentElement.onchange();assert.match(results.textContent,/ممرضة/);assert.doesNotMatch(results.textContent,/<img/);
  const search=a.document.getElementById('providersSearch');search.value='غير موجود';search.parentElement.parentElement.oninput();assert.match(results.textContent,/لا توجد نتائج/);
});
test('provider booking uses the supported service and captured provider association',async()=>{
  const a=await setup();await a.enter('providers');await a.click(a.document.getElementById('providersResults').querySelector('button'));
  const call=a.calls.find(value=>value.action==='chooseService');assert.equal(call.values[0],'doctors');assert.equal(call.values[1].providerProfileId,'provider-1');
});
test('jobs query only active unexpired posts and guest login preserves route',async()=>{
  const a=await setup();await a.enter('jobs');const call=a.calls.find(value=>value.table==='jobs');assert.match(call.or,/expires_at\.is\.null,expires_at\.gt\./);assert.ok(call.filters.some(([column,value])=>column==='status'&&value==='active'));
  const link=a.document.getElementById('jobsResults').querySelector('a');link.onclick({preventDefault(){}});assert.equal(a.calls.find(value=>value.action==='login').page,'jobs');
});
test('course list additionally filters approved review and offers no paid checkout',async()=>{
  const a=await setup({tables:{courses:[{...course,id:'paid',title:'دورة مدفوعة',is_free:false},{...course,id:'draft',title:'مسودة',review_status:'draft'}]}});await a.enter('courses');
  const call=a.calls.find(value=>value.table==='courses');assert.ok(call.filters.some(([column,value])=>column==='review_status'&&value==='approved'));
  const results=a.document.getElementById('coursesResults');assert.match(results.textContent,/الالتحاق المدفوع غير متاح/);assert.doesNotMatch(results.textContent,/مسودة/);assert.equal(results.querySelector('button'),null);
});
test('free enrollment is owned, pending/free, and duplicate retry finds the original',async()=>{
  const a=await setup({signedIn:true});await a.enter('courses');await a.click(a.document.getElementById('coursesResults').querySelector('button'));
  const insert=a.calls.find(value=>value.table==='course_enrollments'&&value.op==='insert');assert.equal(insert.payload.user_id,'owner-a');assert.equal(insert.payload.status,'pending');assert.equal(insert.payload.payment_status,'free');
  assert.match(a.document.getElementById('coursesMine').textContent,/قيد المراجعة/);assert.equal(a.calls.filter(value=>value.op==='insert').length,1);
  await a.enter('courses');assert.equal(a.document.getElementById('coursesResults').querySelector('button'),null);
});
test('saved enrollment after a lost insert response is resolved through owner-filtered lookup',async()=>{
  let lost=true;const a=await setup({signedIn:true,handler(call,shape,tables){if(call.table==='course_enrollments'&&call.op==='insert'&&lost){lost=false;tables.course_enrollments.push({id:'original',...call.payload});return {data:null,error:{code:'TIMEOUT'}};}}});
  await a.enter('courses');await a.click(a.document.getElementById('coursesResults').querySelector('button'));
  assert.equal(a.calls.filter(value=>value.op==='insert').length,1);assert.ok(a.calls.filter(value=>value.table==='course_enrollments'&&value.op==='select'&&!value.limit).every(value=>value.filters.some(([column,value])=>column==='user_id'&&value==='owner-a')));assert.match(a.toasts.join(' '),/محفوظ/);
});
test('double course clicks cannot create concurrent submissions',async()=>{
  const pending=deferred();const a=await setup({signedIn:true,handler(call){if(call.table==='course_enrollments'&&call.op==='insert')return pending.promise;}});await a.enter('courses');const button=a.document.getElementById('coursesResults').querySelector('button');button.onclick();button.onclick();await tick();
  assert.equal(a.calls.filter(value=>value.op==='insert').length,1);pending.resolve({data:{id:'saved',course_id:'course-1',status:'pending',payment_status:'free'},error:null});await tick();await tick();
});
test('late own enrollment responses are discarded after an account change',async()=>{
  const pending=deferred();const a=await setup({signedIn:true,handler(call){if(call.table==='course_enrollments'&&call.limit&&call.filters.some(([column,value])=>column==='user_id'&&value==='owner-a'))return pending.promise;}});await a.enter('courses');await a.change({id:'owner-b'});
  pending.resolve({data:[{id:'private-a',course_id:'course-1',status:'completed'}],error:null});await tick();await tick();assert.doesNotMatch(a.document.getElementById('coursesMine').textContent,/مكتمل/);assert.ok(a.calls.some(value=>value.table==='course_enrollments'&&value.filters.some(([column,value])=>column==='user_id'&&value==='owner-b')));
});
test('job application writes only captured owner/submitted and withdrawal only changes status',async()=>{
  const a=await setup({signedIn:true});await a.enter('jobs');const form=a.document.getElementById('jobsResults').querySelector('form');form.querySelector('textarea').value='خبرتي';form.onsubmit({preventDefault(){}});await tick();await tick();
  const insert=a.calls.find(value=>value.table==='job_applications'&&value.op==='insert');assert.equal(insert.payload.applicant_id,'owner-a');assert.equal(insert.payload.status,'submitted');assert.equal(insert.payload.cover_note,'خبرتي');
  await a.click(a.document.getElementById('jobsMine').querySelector('button'));const update=a.calls.find(value=>value.op==='update');assert.deepEqual({...update.payload},{status:'withdrawn'});assert.ok(update.filters.some(([column,value])=>column==='applicant_id'&&value==='owner-a'));assert.match(a.document.getElementById('jobsMine').textContent,/تم سحب/);
});
test('zero-row withdrawal does not report success',async()=>{
  const a=await setup({signedIn:true,tables:{job_applications:[{id:'mine',job_id:'job-1',applicant_id:'owner-a',status:'submitted'}]},handler(call){if(call.op==='update')return {data:null,error:null};}});await a.enter('jobs');await a.click(a.document.getElementById('jobsMine').querySelector('button'));assert.doesNotMatch(a.toasts.join(' '),/تم سحب/);assert.match(a.toasts.join(' '),/تعذّر تأكيد/);
});
test('one directory failure shows retry and never publishes partial providers',async()=>{
  const a=await setup({handler(call){if(call.table==='nurses')return {data:null,error:{code:'503'}};}});await a.enter('providers');const results=a.document.getElementById('providersResults');assert.match(results.textContent,/تعذّر تحميل/);assert.doesNotMatch(results.textContent,/طبيب عام/);assert.match(results.querySelector('button').textContent,/إعادة المحاولة/);
});
test('old same-account history cannot overwrite a newer refresh',async()=>{
  const pending=deferred();let reads=0;const a=await setup({signedIn:true,handler(call){if(call.table==='course_enrollments'&&call.limit){reads++;if(reads===1)return pending.promise;return {data:[{id:'newest',course_id:'course-1',status:'active'}],error:null};}}});
  await a.enter('courses');await a.enter('courses');pending.resolve({data:[{id:'older',course_id:'course-1',status:'pending'}],error:null});await tick();await tick();assert.match(a.document.getElementById('coursesMine').textContent,/التحاق نشط/);assert.doesNotMatch(a.document.getElementById('coursesMine').textContent,/قيد المراجعة/);
});
test('account switch during insert cannot show old account success or requests',async()=>{
  const pending=deferred();const a=await setup({signedIn:true,handler(call){if(call.table==='course_enrollments'&&call.op==='insert')return pending.promise;}});await a.enter('courses');const button=a.document.getElementById('coursesResults').querySelector('button');button.onclick();await tick();await a.change({id:'owner-b'});
  pending.resolve({data:{id:'private-a',course_id:'course-1',status:'completed',payment_status:'free'},error:null});await tick();await tick();assert.equal(a.toasts.length,0);assert.doesNotMatch(a.document.getElementById('coursesMine').textContent,/مكتمل/);
});
test('expiry and course eligibility are rechecked before inserting',async()=>{
  const a=await setup({signedIn:true});await a.enter('jobs');a.tables.jobs[0].status='closed';const form=a.document.getElementById('jobsResults').querySelector('form');form.onsubmit({preventDefault(){}});await tick();await tick();assert.equal(a.calls.filter(value=>value.op==='insert').length,0);assert.match(a.toasts.join(' '),/لم تعد مفتوحة/);
  await a.enter('courses');a.tables.courses[0].is_free=false;await a.click(a.document.getElementById('coursesResults').querySelector('button'));assert.equal(a.calls.filter(value=>value.op==='insert').length,0);assert.match(a.toasts.join(' '),/غير متاحة للالتحاق المجاني/);
});
