const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const {parseHTML}=require('linkedom');
const source=fs.readFileSync('opportunities.js','utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function setup(options={}) {
  const {document}=parseHTML('<html><body><section id="publish"></section></body></html>');
  // Linkedom has a read-only select.value; emulate the browser's writable selection.
  Object.defineProperty(Object.getPrototypeOf(document.createElement('select')),'value',{configurable:true,get(){return this.querySelector('option[selected]')?.value ?? this.querySelector('option')?.value ?? '';},set(next){this.querySelectorAll('option').forEach(option=>{if(option.value===String(next)) option.setAttribute('selected','');else option.removeAttribute('selected');});}});
  const database={jobs:options.jobs || [],courses:options.courses || []},calls=[],toasts=[],routes={},listeners=[];
  let currentUser={id:'owner-a',user_metadata:{role:'admin'}},version=1,sequence=0,failed=false;
  const role=options.role || 'nurse';
  function from(table) {
    const query={table,type:'select',filters:[],columns:'',data:null};
    const chain={
      select(columns){query.columns=columns;return chain;},eq(name,value){query.filters.push([name,value]);return chain;},order(){return chain;},
      insert(data){query.type='insert';query.data=data;return chain;},update(data){query.type='update';query.data=data;return chain;},
      async limit(){calls.push({...query});if(options.loadPromise && table==='jobs') return options.loadPromise;return {data:database[table],error:null};},
      async maybeSingle(){calls.push({...query});return {data:database[table].find(row=>query.filters.every(([key,value])=>row[key]===value)) || null,error:null};},
      async single(){
        calls.push({...query});
        if(table==='profiles') return {data:{role},error:null};
        let row;
        if(query.type==='insert') {row={...query.data,created_at:'2026-10-07T12:00:00Z'};database[table].push(row);}
        if(query.type==='update') {row=options.zeroUpdate ? null : database[table].find(item=>query.filters.every(([key,value])=>item[key]===value));if(row) Object.assign(row,query.data);}
        if(options.writePromise && query.type!=='select') return options.writePromise;
        if(options.commitThenFail && !failed && query.type==='insert') {failed=true;throw new Error('response lost');}
        return {data:row,error:row ? null : {code:'PGRST116'}};
      }
    };return chain;
  }
  const api={client:{from},authReady:true,get currentUser(){return currentUser;},get userVersion(){return version;},registerRoute(name,route){routes[name]=route;},onReady(fn){fn(api);},onUserChange(fn){listeners.push(fn);},showToast(message){toasts.push(message);},errorMessage(){return 'خطأ مؤقت';},requireLogin(){calls.push({login:true});}};
  const sandbox={document,console,URL,Date,Intl,location:{hash:''},NurseApp:api,crypto:{randomUUID(){return `00000000-0000-4000-8000-${String(++sequence).padStart(12,'0')}`;}}};sandbox.window=sandbox;
  vm.createContext(sandbox);vm.runInContext(source,sandbox);
  if(!options.skipLoad) await routes.publish.onEnter();
  const form=kind=>document.getElementById(kind==='job' ? 'publishJobForm' : 'publishCourseForm');
  const fill=(kind,data)=>Object.entries(data).forEach(([name,value])=>{form(kind).querySelector(`[name="${name}"]`).value=String(value);});
  const submit=async(kind,data)=>{if(data) fill(kind,data);form(kind).onsubmit({preventDefault(){}});await tick();await tick();};
  const emit=user=>{currentUser=user;version++;listeners.forEach(fn=>fn(currentUser,version));};
  return {document,database,calls,toasts,routes,form,fill,submit,emit};
}
const job={title:'ممرض مناوبات',organization_name:'جهة تجريبية',description:'وصف فرصة العمل',city:'طرابلس',employment_type:'مناوبات',requirements:'خبرة مناسبة',contact_phone:'٠٩٢٨٤٨٢١٢٨',contact_email:'jobs@example.invalid',expires_at:'2099-01-31'};
const course={title:'مهارات الرعاية',provider_name:'جهة تدريب تجريبية',description:'برنامج تدريبي موصوف من الجهة',city:'بنغازي',start_date:'2099-02-01',end_date:'2099-02-03',is_free:'true',price:'',seats:'20',duration_minutes:'90',registration_url:'https://example.invalid/course',learning_outcomes:'مهارة أولى\nمهارة ثانية'};
test('publisher requires stored provider role, regardless of metadata admin role',async()=>{
  const a=await setup({role:'patient'});assert.equal(a.document.getElementById('publishForms').hidden,true);assert.equal(a.document.querySelector('#publishState a').getAttribute('href'),'#workspace');
  await a.submit('job',job);assert.equal(a.calls.filter(call=>call.type==='insert').length,0);assert.match(a.toasts.at(-1),/صلاحية/);
});
test('job publication uses captured owner, safe dates and normalized phone',async()=>{
  const a=await setup();await a.submit('job',job);const insert=a.calls.find(call=>call.type==='insert');
  assert.equal(insert.table,'jobs');assert.equal(insert.data.publisher_id,'owner-a');assert.equal(insert.data.status,'active');assert.equal(insert.data.contact_phone,'0928482128');assert.equal(insert.data.expires_at,'2099-01-31T23:59:59+02:00');assert.match(insert.data.id,/00000000/);assert.equal(a.database.jobs.length,1);
});
test('course creation is pending and closed and never submits approval fields',async()=>{
  const a=await setup();await a.submit('course',course);const insert=a.calls.find(call=>call.type==='insert');
  assert.equal(insert.data.publisher_id,'owner-a');assert.equal(insert.data.status,'closed');assert.equal(insert.data.review_status,'pending');assert.equal(insert.data.price,0);assert.equal(insert.data.is_free,true);assert.deepEqual([...insert.data.learning_outcomes],['مهارة أولى','مهارة ثانية']);assert.equal('review_note' in insert.data,false);assert.equal('published_at' in insert.data,false);
});
test('invalid calendar dates, untrusted cities, HTTPS credentials and negative prices block writes',async()=>{
  const a=await setup();await a.submit('job',{...job,expires_at:'2099-02-31'});
  const injected=a.document.createElement('option');injected.value='مدينة غير موجودة';a.form('job').querySelector('[name="city"]').append(injected);await a.submit('job',{...job,city:'مدينة غير موجودة'});
  await a.submit('course',{...course,registration_url:'javascript:alert(1)'});await a.submit('course',{...course,registration_url:'https://user:pass@example.invalid/'});await a.submit('course',{...course,is_free:'false',price:'-1'});await a.submit('course',{...course,end_date:'2099-01-01'});
  assert.equal(a.calls.filter(call=>call.type==='insert').length,0);assert.match(a.document.getElementById('publishCourseNotice').textContent,/تحقّق/);
});
test('ambulance provider can author jobs but cannot create courses',async()=>{
  const a=await setup({role:'ambulance'});assert.equal(a.form('course').parentElement.hidden,true);await a.submit('course',course);assert.equal(a.calls.filter(call=>call.type==='insert').length,0);await a.submit('job',job);assert.equal(a.database.jobs.length,1);
});
test('own listings are owner-filtered and user text never becomes markup',async()=>{
  const a=await setup({jobs:[{...job,id:'j1',publisher_id:'owner-a',status:'active',title:'<img src=x onerror=alert(1)>'},{...job,id:'j2',publisher_id:'another-owner',title:'OTHER PRIVATE ROW'}]});
  const list=a.document.getElementById('ownJobsList');assert.equal(list.querySelector('img'),null);assert.match(list.textContent,/<img/);assert.doesNotMatch(list.textContent,/OTHER PRIVATE ROW/);assert.ok(a.calls.find(call=>call.table==='jobs' && call.filters.some(([key,value])=>key==='publisher_id' && value==='owner-a')));
});
test('two rapid submissions share one write and cannot create duplicates',async()=>{
  const a=await setup();a.fill('job',job);const form=a.form('job');form.onsubmit({preventDefault(){}});form.onsubmit({preventDefault(){}});await tick();await tick();assert.equal(a.calls.filter(call=>call.type==='insert').length,1);
});
test('a lost insert response resolves the same saved ID on retry without another insert',async()=>{
  const a=await setup({commitThenFail:true});await a.submit('job',job);const original=a.database.jobs[0];assert.equal(a.form('job').querySelector('[name="title"]').disabled,true);assert.match(a.document.getElementById('publishJobNotice').textContent,/لم يتأكد/);
  a.fill('job',{title:'different unsent title'});await a.submit('job');assert.equal(a.calls.filter(call=>call.type==='insert').length,1);assert.equal(a.database.jobs.length,1);assert.equal(a.database.jobs[0].title,original.title);assert.match(a.toasts.at(-1),/تم حفظ/);
});
test('a late own-list response is discarded after account switch',async()=>{
  let resolve;const pending=new Promise(r=>resolve=r);const a=await setup({skipLoad:true,loadPromise:pending});
  const request=a.routes.publish.onEnter();await tick();a.emit({id:'owner-b'});
  resolve({data:[{id:'private',publisher_id:'owner-a',title:'saved private title',status:'active'}],error:null});await request;
  assert.equal(a.document.getElementById('ownJobsList').textContent,'');assert.equal(a.form('job').querySelector('[name="title"]').value,'');assert.equal(a.document.getElementById('publishForms').hidden,true);
});
test('late write response cannot show success or repopulate a different account',async()=>{
  let resolve;const pending=new Promise(r=>resolve=r);const a=await setup({writePromise:pending});await a.submit('job',job);
  const saved=a.database.jobs[0];a.emit({id:'owner-b'});resolve({data:saved,error:null});await tick();await tick();
  assert.equal(a.toasts.some(message=>/تم حفظ/.test(message)),false);assert.equal(a.document.getElementById('ownJobsList').textContent,'');assert.equal(a.form('job').querySelector('[name="title"]').value,'');
});
test('course edits resubmit content closed/pending and retain explicit owner filter',async()=>{
  const a=await setup({courses:[{...course,id:'course-id',publisher_id:'owner-a',status:'active',review_status:'approved',is_free:true,price:0,learning_outcomes:['قديم']}]});
  a.document.getElementById('ownCoursesList').querySelector('button').onclick();await a.submit('course',{title:'عنوان جديد'});const update=a.calls.find(call=>call.type==='update');assert.equal(update.data.status,'closed');assert.equal(update.data.review_status,'pending');assert.ok(update.filters.some(([key,value])=>key==='publisher_id' && value==='owner-a'));assert.ok(update.filters.some(([key,value])=>key==='id' && value==='course-id'));
});
test('an update matching no row does not show success',async()=>{
  const a=await setup({zeroUpdate:true,jobs:[{...job,id:'job-id',publisher_id:'owner-a',status:'active'}]});a.document.getElementById('ownJobsList').querySelector('button').onclick();await a.submit('job',{title:'عنوان جديد'});assert.equal(a.toasts.some(message=>/تم حفظ/.test(message)),false);assert.match(a.document.getElementById('publishJobNotice').textContent,/لم يتأكد/);
});
