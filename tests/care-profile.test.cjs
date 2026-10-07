const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const {parseHTML}=require('linkedom');
const source=fs.readFileSync('care-profile.js','utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const mappings={doctor:['doctors','profile_id'],nurse:['nurses','profile_id'],hospital:['hospitals','owner_profile_id'],laboratory:['laboratories','owner_profile_id'],pharmacy:['pharmacies','owner_profile_id']};
async function setup(options={}) {
  const {document}=parseHTML('<html><body><section id="care-profile"></section></body></html>');
  Object.defineProperty(Object.getPrototypeOf(document.createElement('select')),'value',{configurable:true,get(){return this.querySelector('option[selected]')?.value ?? this.querySelector('option')?.value ?? '';},set(next){this.querySelectorAll('option').forEach(option=>{if(option.value===String(next))option.setAttribute('selected','');else option.removeAttribute('selected');});}});
  const database={doctors:[],nurses:[],hospitals:[],laboratories:[],pharmacies:[]},calls=[],toasts=[],routes={},listeners=[];
  let currentUser={id:'owner-a',user_metadata:{role:'doctor'}},version=1,sequence=0,failed=false;
  const role=options.role || 'nurse';if(mappings[role])database[mappings[role][0]]=options.rows || [];
  const client={async rpc(name){calls.push({rpc:name});return options.missingGate ? {error:{code:'PGRST202'},data:null} : {data:1,error:null};},from(table){
    const query={table,type:'select',filters:[],data:null};
    const chain={select(columns){query.columns=columns;return chain;},eq(name,value){query.filters.push([name,value]);return chain;},order(){return chain;},insert(data){query.type='insert';query.data=data;return chain;},update(data){query.type='update';query.data=data;return chain;},
      async limit(){calls.push({...query});return options.loadPromise || {data:database[table],error:null};},
      async maybeSingle(){calls.push({...query});return {data:database[table].find(row=>query.filters.every(([key,value])=>row[key]===value)) || null,error:null};},
      async single(){calls.push({...query});if(table==='profiles')return {data:{id:currentUser?.id,role},error:null};let row;
        if(query.type==='insert'){row={...query.data,verified:false,created_at:'2026-10-07T00:00:00Z'};database[table].push(row);}
        else if(query.type==='update'){row=options.zeroUpdate ? null : database[table].find(row=>query.filters.every(([key,value])=>row[key]===value));if(row)Object.assign(row,query.data,{verified:false});}
        if(options.writePromise)return options.writePromise;
        if(options.commitThenFail && !failed && query.type==='insert'){failed=true;throw new Error('response lost');}
        return {data:row,error:row ? null : {code:'PGRST116'}};
      }};return chain;
  }};
  const api={client,authReady:true,get currentUser(){return currentUser;},get userVersion(){return version;},registerRoute(name,route){routes[name]=route;},onReady(fn){fn(api);},onUserChange(fn){listeners.push(fn);},showToast(message){toasts.push(message);},errorMessage(){return 'خطأ مؤقت';},requireLogin(){calls.push({login:true});}};
  const sandbox={document,console,URL,Date,Intl,location:{hash:''},NurseApp:api,crypto:{randomUUID(){return `00000000-0000-4000-8000-${String(++sequence).padStart(12,'0')}`;}}};sandbox.window=sandbox;
  vm.createContext(sandbox);vm.runInContext(source,sandbox);if(!options.skipLoad)await routes['care-profile'].onEnter();
  const form=()=>document.getElementById('careProfileForm');
  const fill=data=>Object.entries(data).forEach(([name,value])=>{form().querySelector(`[name="${name}"]`).value=String(value);});
  const submit=async data=>{if(data)fill(data);form().onsubmit({preventDefault(){}});await tick();await tick();};
  const emit=user=>{currentUser=user;version++;listeners.forEach(fn=>fn(currentUser,version));};
  return {document,database,calls,toasts,routes,form,fill,submit,emit};
}
const personal={name:'مقدم خدمة تجريبي',specialty:'تمريض',city:'طرابلس',bio:'نبذة مهنية',years_experience:'0',available_for_home_visits:'false'};
const institution={name:'مؤسسة تجريبية',city:'بنغازي',address:'عنوان المؤسسة',description:'وصف المؤسسة'};
test('care directory authoring checks stored role and does not trust profession metadata',async()=>{
  const a=await setup({role:'patient'});assert.equal(a.document.getElementById('careProfilePanel').hidden,true);assert.equal(a.form(),null);assert.equal(a.document.querySelector('#careProfileState a').getAttribute('href'),'#workspace');assert.equal(a.calls.some(call=>call.type==='insert'),false);
});
test('missing backend contract keeps form disabled and rejects even programmatic save',async()=>{
  const a=await setup({missingGate:true});assert.match(a.document.getElementById('careProfileState').textContent,/تفعيل إصلاحات/);assert.equal(a.form().querySelector('input').disabled,true);assert.equal(a.document.getElementById('saveCareProfile').disabled,true);await a.submit(personal);assert.equal(a.calls.some(call=>call.type==='insert'),false);assert.match(a.document.getElementById('careProfileNotice').textContent,/تفعيل إصلاحات/);
});
test('each supported role writes its exact table and captured owner without contact or verification fields',async()=>{
  for(const [role,[table,ownerColumn]]of Object.entries(mappings)) {
    const a=await setup({role});const data=['doctor','nurse'].includes(role) ? {...personal} : institution;if(role==='doctor')delete data.available_for_home_visits;
    await a.submit(data);const insert=a.calls.find(call=>call.type==='insert');assert.ok(insert,role);assert.equal(insert.table,table);assert.equal(insert.data[ownerColumn],'owner-a');
    for(const forbidden of ['verified','role','phone','email','whatsapp','photo_url','image_url'])assert.equal(forbidden in insert.data,false,`${role}:${forbidden}`);
    assert.equal(a.database[table][0].verified,false);assert.ok(a.calls.some(call=>call.rpc==='nurse_app_contract_version'));
  }
});
test('doctor specialty and bounded integer experience are validated before mutation',async()=>{
  const a=await setup({role:'doctor'});const data={...personal};delete data.available_for_home_visits;
  await a.submit({...data,specialty:''});await a.submit({...data,years_experience:'61'});await a.submit({...data,years_experience:'1.5'});await a.submit({...data,name:'bad\u202e name'});assert.equal(a.calls.some(call=>call.type==='insert'),false);
  await a.submit({...data,years_experience:'0'});assert.equal(a.calls.find(call=>call.type==='insert').data.years_experience,0);
});
test('existing nurse singleton is edited by UUID with immutable owner filters',async()=>{
  const a=await setup({rows:[{...personal,id:'nurse-id',profile_id:'owner-a',verified:true,years_experience:4,available_for_home_visits:false}]});assert.equal(a.document.getElementById('careProfilePanel').hidden,true);
  a.document.getElementById('ownCareProfiles').querySelector('button').onclick();assert.equal(a.document.getElementById('careProfilePanel').hidden,false);await a.submit({name:'اسم معدل'});
  const update=a.calls.find(call=>call.type==='update');assert.ok(update.filters.some(([key,value])=>key==='id'&&value==='nurse-id'));assert.ok(update.filters.some(([key,value])=>key==='profile_id'&&value==='owner-a'));assert.equal('profile_id'in update.data,false);assert.equal('verified'in update.data,false);assert.equal(a.database.nurses.length,1);
});
test('own list suppresses other owners and renders names as text',async()=>{
  const a=await setup({role:'hospital',rows:[{id:'own',owner_profile_id:'owner-a',name:'<img src=x onerror=alert(1)>',verified:false},{id:'other',owner_profile_id:'owner-b',name:'OTHER PRIVATE PROFILE',verified:false}]});
  const list=a.document.getElementById('ownCareProfiles');assert.equal(list.querySelector('img'),null);assert.match(list.textContent,/<img/);assert.doesNotMatch(list.textContent,/OTHER PRIVATE PROFILE/);assert.ok(a.calls.find(call=>call.table==='hospitals'&&call.filters.some(([key,value])=>key==='owner_profile_id'&&value==='owner-a')));
});
test('lost response retries the original UUID and frozen content without a duplicate insert',async()=>{
  const a=await setup({commitThenFail:true});await a.submit(personal);assert.equal(a.form().querySelector('input').disabled,true);assert.match(a.document.getElementById('careProfileNotice').textContent,/لم يتأكد/);
  a.fill({name:'unsent replacement'});await a.submit();assert.equal(a.calls.filter(call=>call.type==='insert').length,1);assert.equal(a.database.nurses.length,1);assert.equal(a.database.nurses[0].name,personal.name);assert.match(a.toasts.at(-1),/تم حفظ/);
});
test('rapid repeated submissions share one mutation',async()=>{
  const a=await setup();a.fill(personal);a.form().onsubmit({preventDefault(){}});a.form().onsubmit({preventDefault(){}});await tick();await tick();assert.equal(a.calls.filter(call=>call.type==='insert').length,1);
});
test('late own list cannot reveal profile after account changes',async()=>{
  let resolve;const pending=new Promise(r=>resolve=r);const a=await setup({skipLoad:true,loadPromise:pending});const request=a.routes['care-profile'].onEnter();await tick();a.emit({id:'owner-b'});resolve({data:[{id:'private',profile_id:'owner-a',name:'old private name'}],error:null});await request;assert.equal(a.document.getElementById('ownCareProfiles').textContent,'');assert.equal(a.document.getElementById('careProfilePanel').hidden,true);
});
test('late mutation response cannot confirm a different account',async()=>{
  let resolve;const pending=new Promise(r=>resolve=r);const a=await setup({writePromise:pending});await a.submit(personal);const row=a.database.nurses[0];a.emit({id:'owner-b'});resolve({data:row,error:null});await tick();await tick();assert.equal(a.toasts.some(message=>/تم حفظ/.test(message)),false);assert.equal(a.document.getElementById('ownCareProfiles').textContent,'');assert.equal(a.form().querySelector('input').value,'');
});
test('zero matched update never reports a saved profile',async()=>{
  const a=await setup({zeroUpdate:true,rows:[{...personal,id:'nurse-id',profile_id:'owner-a',verified:false,years_experience:2,available_for_home_visits:false}]});a.document.getElementById('ownCareProfiles').querySelector('button').onclick();await a.submit({name:'اسم جديد'});assert.equal(a.toasts.some(message=>/تم حفظ/.test(message)),false);assert.match(a.document.getElementById('careProfileNotice').textContent,/لم يتأكد/);
});
