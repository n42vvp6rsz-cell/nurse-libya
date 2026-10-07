const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const {parseHTML}=require('linkedom');
const source=fs.readFileSync('workspace.js','utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function settle(){for(let i=0;i<5;i++)await tick();}
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
async function setup(options={}){
 const {document}=parseHTML('<!doctype html><html><body><main id="main"></main></body></html>');
 const create=document.createElement.bind(document);
 document.createElement=function(tag){const node=create(tag);if(tag==='form')node.reset=()=>{node.querySelectorAll('input,textarea').forEach(input=>{input.value='';});};if(tag==='select'){let chosen;Object.defineProperty(node,'value',{configurable:true,get(){return chosen??node.querySelector('option')?.value??'';},set(value){chosen=value;}});}return node;};
 const calls=[],toasts=[],routes=new Map(),changes=[],readies=[];
 const state={user:{id:'owner',email:'test@example.invalid',user_metadata:{role:options.metadataRole||'patient'}},version:0};
 const db={profiles:{owner:{id:'owner',role:options.role||'patient'},applicant:{id:'applicant',role:options.applicantRole||'patient'}},provider_applications:options.applications||[],organizations:options.organizations||[],courses:options.courses||[],doctors:options.providers?.doctors||[],nurses:options.providers?.nurses||[],hospitals:options.providers?.hospitals||[],laboratories:options.providers?.laboratories||[],pharmacies:options.providers?.pharmacies||[],bookings:options.bookings||[]};
 let nextId=0;
 const copy=value=>value==null?value:JSON.parse(JSON.stringify(value));
 function matches(row,filters){return filters.every(([kind,column,value])=>kind==='in'?value.includes(row[column]):kind==='is'?row[column]==null:row[column]===value);}
 async function respond(request){
  calls.push(request);
  if(options.respond){const result=await options.respond(request,db);if(result!==undefined)return result;}
  if(request.table==='profiles'){
   let rows=Object.values(db.profiles).filter(row=>matches(row,request.filters));
   if(options.profilesReadable===false)rows=rows.filter(row=>row.id===state.user?.id);
   return {data:copy(request.single?rows[0]||null:rows),error:null};
  }
  const rows=db[request.table]||[];
  if(request.mode==='insert'){const row={created_at:'2026-10-07T10:00:00Z',updated_at:'2026-10-07T10:00:00Z',...request.payload};rows.push(row);return {data:copy(row),error:null};}
  const selected=rows.filter(row=>matches(row,request.filters));
  if(request.mode==='update'){selected.forEach(row=>Object.assign(row,request.payload));return {data:copy(request.single?selected[0]||null:selected),error:null};}
  return {data:copy(request.single?selected[0]||null:selected),error:null};
 }
 const client={from(table){const request={table,mode:'select',filters:[],columns:null,single:false};const chain={
  select(columns){request.columns=columns;return chain;},eq(column,value){request.filters.push(['eq',column,value]);return chain;},is(column,value){request.filters.push(['is',column,value]);return chain;},in(column,value){request.filters.push(['in',column,value]);return chain;},order(column,config){request.order=[column,config];return chain;},limit(value){request.limit=value;return chain;},maybeSingle(){request.single=true;return chain;},single(){request.single=true;return chain;},insert(payload){request.mode='insert';request.payload=payload;return chain;},update(payload){request.mode='update';request.payload=payload;return chain;},then(resolve,reject){return respond(request).then(resolve,reject);}
 };return chain;},async rpc(name,args){calls.push({rpc:name,args});if(name==='nurse_app_contract_version')return {data:options.contractVersion??1,error:options.contractError?{code:'PGRST202'}:null};if(options.rpc)return options.rpc(name,args,db);const row=db.provider_applications.find(row=>row.id===args.p_application_id);if(row){row.status=args.p_approve?'approved':'rejected';row.reviewed_by=state.user.id;row.reviewed_at='2026-10-07T10:00:00Z';if(args.p_approve)db.profiles[row.user_id].role=row.requested_role;}return {data:null,error:null};}};
 const app={client,authReady:true,get currentUser(){return state.user;},get userVersion(){return state.version;},isCurrent(id,version){return state.user?.id===id&&state.version===version;},showToast(value){toasts.push(value);},errorMessage(){return 'تعذّر إتمام العملية. حاول مجددًا.';},registerRoute(name,definition){routes.set(name,definition);},onUserChange(fn){changes.push(fn);},onReady(fn){readies.push(fn);fn(app);}};
 const location={hash:''};
 const sandbox={document,location,URL,Date,Map,Set,Promise,console,NurseApp:app,crypto:{randomUUID:()=>`uuid-${++nextId}`},FormData:class{constructor(form){this.values=form.testValues||{};}get(name){return this.values[name]??'';}}};sandbox.window=sandbox;
 vm.createContext(sandbox);vm.runInContext(source,sandbox);await settle();
 async function submit(id,values){const form=document.getElementById(id);form.testValues=values;form.onsubmit({preventDefault(){},currentTarget:form});await settle();}
 async function enter(name){await routes.get(name).onEnter(app);await settle();}
 async function switchUser(user){state.user=user;state.version++;changes.forEach(fn=>fn(user,state.version));await settle();}
 return {document,calls,toasts,routes,db,state,submit,enter,switchUser,app};
}
const application={id:'application-1',user_id:'applicant',requested_role:'nurse',organization_name:'المؤسسة',license_number:'L-1',city:'طرابلس',notes:'معلومات مهنية',status:'pending',reviewed_by:null,reviewed_at:null,created_at:'2026-10-07T10:00:00Z'};
const applicationValues={requested_role:'nurse',license_number:'L-1',organization_name:'المؤسسة',city:'طرابلس',phone:'٠٩١٢٣٤٥٦٧٨',notes:'معلومات مهنية'};
const organizationValues={name:'مركز الرعاية',kind:'medical_center',city:'طرابلس',area:'حي الأندلس',address:'شارع الرعاية',phone:'0912345678',email:'contact@example.invalid',website:'https://example.invalid',description:'وصف المؤسسة'};
function reviewButton(a,list,label='اعتماد'){return [...a.document.querySelectorAll(`#${list} button`)].find(node=>node.textContent===label);}
test('professional and administration routes are authenticated, with owner-scoped lists',async()=>{
 const a=await setup();assert.equal(a.routes.get('workspace').requiresAuth,true);assert.equal(a.routes.get('admin').requiresAuth,true);await a.enter('workspace');
 const applicationQuery=a.calls.find(call=>call.table==='provider_applications');const organizationQuery=a.calls.find(call=>call.table==='organizations');
 assert.ok(applicationQuery.filters.some(([,column,value])=>column==='user_id'&&value==='owner'));assert.ok(organizationQuery.filters.some(([,column,value])=>column==='owner_profile_id'&&value==='owner'));
 assert.ok(a.calls.every(call=>!call.columns||!call.columns.includes('*')));
});
test('admin metadata grants no authority and causes no admin list query',async()=>{
 const a=await setup({metadataRole:'admin',role:'patient'});await a.enter('admin');assert.match(a.document.getElementById('adminState').textContent,/الإدارة المعتمد/);assert.equal(a.calls.filter(call=>call.table!=='profiles').length,0);
});
test('application validates requested profession and phone before insertion',async()=>{
 const a=await setup();await a.submit('providerApplicationForm',{...applicationValues,requested_role:'admin'});await a.submit('providerApplicationForm',{...applicationValues,requested_role:'government'});await a.submit('providerApplicationForm',{...applicationValues,phone:'123'});assert.equal(a.calls.filter(call=>call.mode==='insert').length,0);
});
test('application writes only owner and pending review data, with normalized local phone',async()=>{
 const a=await setup();await a.submit('providerApplicationForm',applicationValues);const write=a.calls.find(call=>call.mode==='insert');
 assert.equal(write.payload.user_id,'owner');assert.equal(write.payload.requested_role,'nurse');assert.equal(write.payload.status,'pending');assert.equal(write.payload.reviewed_by,null);assert.equal(write.payload.reviewed_at,null);assert.equal(write.payload.phone,'0912345678');assert.equal(write.payload.role,undefined);assert.equal(write.payload.id,'uuid-1');assert.match(a.toasts.at(-1),/تم حفظ طلب الاعتماد/);
});
test('duplicate pending profession does not create another application',async()=>{
 const a=await setup({applications:[{...application,user_id:'owner'}]});await a.enter('workspace');await a.submit('providerApplicationForm',applicationValues);assert.equal(a.calls.filter(call=>call.mode==='insert').length,0);assert.match(a.toasts.at(-1),/قيد المراجعة بالفعل/);
});
test('ambiguous application recovery keeps the UUID and payload without another insert',async()=>{
 let first=true;const a=await setup({respond(request,db){if(request.mode==='insert'&&first){first=false;db.provider_applications.push({...request.payload,status:'pending'});return {data:null,error:{message:'response lost'}};}}});
 await a.submit('providerApplicationForm',applicationValues);assert.match(a.toasts.at(-1),/لم نتأكد/);assert.equal(a.document.querySelector('#providerApplicationForm [name="phone"]').disabled,true);
 await a.submit('providerApplicationForm',{...applicationValues,phone:'0922222222'});assert.equal(a.calls.filter(call=>call.mode==='insert').length,1);assert.equal(a.db.provider_applications[0].phone,'0912345678');assert.match(a.toasts.at(-1),/تم حفظ طلب الاعتماد/);
});
test('single-flight application prevents double submit during a pending write',async()=>{
 const pending=deferred();const a=await setup({respond(request){if(request.mode==='insert')return pending.promise;}});await a.submit('providerApplicationForm',applicationValues);await a.submit('providerApplicationForm',applicationValues);assert.equal(a.calls.filter(call=>call.mode==='insert').length,1);
 pending.resolve({data:{id:'uuid-1',user_id:'owner',status:'pending'},error:null});await settle();assert.match(a.toasts.at(-1),/تم حفظ/);
});
test('account switch clears private lists and rejects a late owner response',async()=>{
 const pending=deferred();const a=await setup({respond(request){if(request.table==='provider_applications'&&request.mode==='select')return pending.promise;}});const loading=a.enter('workspace');await settle();await a.switchUser({id:'another',user_metadata:{}});
 pending.resolve({data:[{...application,user_id:'owner',organization_name:'PRIVATE OWNER DATA'}],error:null});await loading;assert.equal(a.document.getElementById('providerApplicationsList').textContent,'');assert.equal(a.document.getElementById('workspaceState').textContent,'');assert.equal(a.toasts.length,0);
});
test('missing admin applicant SELECT disables approval and prevents RPC execution',async()=>{
 const a=await setup({role:'admin',profilesReadable:false,applications:[{...application}]});await a.enter('admin');const approve=reviewButton(a,'adminApplicationsList');assert.equal(approve.disabled,true);assert.match(a.document.getElementById('adminApplicationsList').textContent,/الاعتماد متوقف/);approve.onclick();await settle();assert.equal(a.calls.filter(call=>call.rpc&&call.rpc!=='nurse_app_contract_version').length,0);
});
test('approval verifies role promotion after RPC and reports partial backend failure',async()=>{
 const a=await setup({role:'admin',applications:[{...application}],rpc(name,args,db){const row=db.provider_applications[0];row.status='approved';row.reviewed_by='owner';row.reviewed_at='2026-10-07T10:00:00Z';return {data:null,error:null};}});await a.enter('admin');reviewButton(a,'adminApplicationsList').onclick();await settle();assert.match(a.toasts.at(-1),/لم يتأكد تفعيل/);assert.ok(!a.toasts.some(toast=>toast==='تم تأكيد اعتماد الحساب المهني.'));assert.equal(a.db.profiles.applicant.role,'patient');
});
test('successful professional approval checks pending state and both persisted rows',async()=>{
 const a=await setup({role:'admin',applications:[{...application}]});await a.enter('admin');reviewButton(a,'adminApplicationsList').onclick();await settle();assert.equal(a.db.profiles.applicant.role,'nurse');assert.equal(a.toasts.at(-1),'تم تأكيد اعتماد الحساب المهني.');const rpc=a.calls.find(call=>call.rpc==='approve_provider_application');assert.equal(rpc.args.p_application_id,application.id);assert.equal(rpc.args.p_approve,true);
});
test('organization submission has controlled kind, pending state and no writable review fields',async()=>{
 const a=await setup();await a.submit('organizationForm',organizationValues);const write=a.calls.find(call=>call.mode==='insert');assert.equal(write.payload.owner_profile_id,'owner');assert.equal(write.payload.verification_status,'pending');assert.equal(write.payload.verified_at,undefined);assert.equal(write.payload.verification_note,undefined);assert.equal(write.payload.reviewed_by,undefined);assert.equal(write.payload.whatsapp,undefined);assert.equal(write.payload.website,'https://example.invalid/');
});
test('organization rejects executable links and invalid types before any write',async()=>{
 const a=await setup();await a.submit('organizationForm',{...organizationValues,website:'javascript:alert(1)'});await a.submit('organizationForm',{...organizationValues,kind:'government'});assert.equal(a.calls.filter(call=>call.mode==='insert').length,0);
});
test('organization admin zero-row decision has no success toast and uses status plus timestamp',async()=>{
 const row={id:'org-1',owner_profile_id:'applicant',name:'مؤسسة',kind:'clinic',verification_status:'pending',updated_at:'2026-10-07T09:00:00Z'};const a=await setup({role:'admin',organizations:[row],respond(request){if(request.mode==='update')return {data:null,error:null};}});await a.enter('admin');reviewButton(a,'adminOrganizationsList').onclick();await settle();assert.match(a.toasts.at(-1),/لم يتم تأكيد القرار/);const update=a.calls.find(call=>call.mode==='update');assert.ok(update.filters.some(([,column,value])=>column==='verification_status'&&value==='pending'));assert.ok(update.filters.some(([,column,value])=>column==='updated_at'&&value===row.updated_at));assert.equal(update.payload.verification_status,'verified');
});
test('course admin approval only succeeds with approved active persisted row',async()=>{
 const row={id:'course-1',publisher_id:'applicant',title:'تعليم تمريضي',provider_name:'مركز',description:'وصف الدورة',review_status:'pending',status:'closed',updated_at:'2026-10-07T09:00:00Z'};const a=await setup({role:'admin',courses:[row]});await a.enter('admin');reviewButton(a,'adminCoursesList').onclick();await settle();const update=a.calls.find(call=>call.mode==='update');assert.equal(update.payload.review_status,'approved');assert.equal(update.payload.status,'active');assert.equal(update.payload.reviewed_by,undefined);assert.ok(update.filters.some(([,column,value])=>column==='review_status'&&value==='pending'));assert.equal(a.toasts.at(-1),'تم تأكيد اعتماد ونشر الدورة.');
});
test('a late approval response after account switch cannot toast or refetch private rows',async()=>{
 const pending=deferred();const a=await setup({role:'admin',applications:[{...application}],rpc(){return pending.promise;}});await a.enter('admin');reviewButton(a,'adminApplicationsList').onclick();await settle();await a.switchUser({id:'another',user_metadata:{}});const count=a.calls.length;pending.resolve({data:null,error:null});await settle();assert.equal(a.calls.length,count);assert.equal(a.toasts.length,0);assert.equal(a.document.getElementById('adminApplicationsList').textContent,'');
});
test('application and organization text never becomes HTML',async()=>{
 const a=await setup({applications:[{...application,user_id:'owner',organization_name:'<img src=x onerror=alert(1)>'}],organizations:[{id:'org-1',owner_profile_id:'owner',name:'<script>alert(1)</script>',kind:'clinic',verification_status:'pending'}]});await a.enter('workspace');assert.equal(a.document.querySelector('img'),null);assert.equal(a.document.querySelector('script'),null);assert.match(a.document.getElementById('providerApplicationsList').textContent,/<img/);
});
const nurseListing={id:'nurse-1',profile_id:'applicant',name:'اسم مهني',specialty:'تمريض منزلي',city:'طرابلس',bio:null,years_experience:4,available_for_home_visits:true,verified:false};
const booking={id:'booking-1',user_id:'applicant',service:'تمريض منزلي',patient_name:'مستفيد',phone:'0912345678',booking_date:'2026-10-10',status:'قيد المراجعة',service_request_id:'request-1'};
test('missing contract version blocks every dependent admin mutation',async()=>{
 const a=await setup({role:'admin',contractError:true,applicantRole:'nurse',applications:[{...application}],providers:{nurses:[{...nurseListing}]},courses:[{id:'course-1',publisher_id:'applicant',title:'تعليم',description:'تعليم',review_status:'pending',status:'closed'}],bookings:[{...booking}]});await a.enter('admin');assert.match(a.document.getElementById('adminState').textContent,/لم يُفعّل بعد/);
 const controls=[reviewButton(a,'adminApplicationsList'),reviewButton(a,'adminCoursesList'),reviewButton(a,'adminProviders-nurses','توثيق الملف'),reviewButton(a,'adminBookingsList','تأكيد الطلب')];
 assert.ok(controls.every(node=>node.disabled));for(const node of controls){node.onclick();await settle();}
 assert.equal(a.calls.filter(call=>call.rpc&&call.rpc!=='nurse_app_contract_version').length,0);assert.equal(a.calls.filter(call=>call.mode==='update').length,0);
});
test('contract version is rechecked before action even when the loaded page had authority',async()=>{
 const options={role:'admin',applications:[{...application}]},a=await setup(options);await a.enter('admin');assert.equal(reviewButton(a,'adminApplicationsList').disabled,false);options.contractVersion=0;reviewButton(a,'adminApplicationsList').onclick();await settle();assert.equal(a.calls.filter(call=>call.rpc==='approve_provider_application').length,0);assert.match(a.toasts.at(-1),/لم يُفعّل بعد/);
});
test('provider verification compares all reviewed fields and nullable content',async()=>{
 const a=await setup({role:'admin',applicantRole:'nurse',providers:{nurses:[{...nurseListing}]}});await a.enter('admin');reviewButton(a,'adminProviders-nurses','توثيق الملف').onclick();await settle();const write=a.calls.find(call=>call.mode==='update');assert.equal(write.table,'nurses');assert.deepEqual(Object.keys(write.payload),['verified']);assert.equal(write.payload.verified,true);assert.ok(write.filters.some(([kind,column,value])=>kind==='is'&&column==='bio'&&value===null));assert.ok(write.filters.some(([,column,value])=>column==='verified'&&value===false));assert.ok(write.filters.some(([,column,value])=>column==='name'&&value===nurseListing.name));assert.equal(a.toasts.at(-1),'تم تأكيد توثيق ملف مقدم الخدمة.');
});
test('provider content changed after queue load cannot be verified from stale content',async()=>{
 const a=await setup({role:'admin',applicantRole:'nurse',providers:{nurses:[{...nurseListing}]}});await a.enter('admin');a.db.nurses[0].name='محتوى جديد';reviewButton(a,'adminProviders-nurses','توثيق الملف').onclick();await settle();assert.equal(a.db.nurses[0].verified,false);assert.match(a.toasts.at(-1),/ربما تغيّر محتوى الملف/);
});
test('provider authority must match the owner stored role; a patient record stays unverified',async()=>{
 const a=await setup({role:'admin',providers:{nurses:[{...nurseListing}]}});await a.enter('admin');reviewButton(a,'adminProviders-nurses','توثيق الملف').onclick();await settle();assert.equal(a.calls.filter(call=>call.mode==='update').length,0);assert.match(a.toasts.at(-1),/صفة صاحب الملف/);
});
test('booking review uses only the atomic RPC and verifies both returned statuses',async()=>{
 const a=await setup({role:'admin',bookings:[{...booking}],rpc(name,args,db){assert.equal(name,'review_booking');db.bookings[0].status=args.p_new_status;return {data:[{id:booking.id,status:args.p_new_status,service_request_id:booking.service_request_id,service_request_status:'accepted'}],error:null};}});await a.enter('admin');reviewButton(a,'adminBookingsList','تأكيد الطلب').onclick();await settle();const rpc=a.calls.find(call=>call.rpc==='review_booking');assert.equal(rpc.args.p_expected_status,'قيد المراجعة');assert.equal(rpc.args.p_new_status,'confirmed');assert.equal(a.calls.filter(call=>call.mode==='update'||call.table==='service_requests').length,0);assert.equal(a.toasts.at(-1),'تم تأكيد الحجز والطلب المرتبط.');
});
test('booking RPC response without a matching linked status cannot claim success',async()=>{
 const a=await setup({role:'admin',bookings:[{...booking}],rpc(){return {data:[{id:booking.id,status:'confirmed',service_request_id:booking.service_request_id,service_request_status:'pending'}],error:null};}});await a.enter('admin');reviewButton(a,'adminBookingsList','تأكيد الطلب').onclick();await settle();assert.match(a.toasts.at(-1),/لم يتم تأكيد تحديث الحجز/);assert.ok(!a.toasts.some(value=>value==='تم تأكيد الحجز والطلب المرتبط.'));
});
test('booking status changes after list load block a stale review RPC',async()=>{
 const a=await setup({role:'admin',bookings:[{...booking}]});await a.enter('admin');a.db.bookings[0].status='cancelled';reviewButton(a,'adminBookingsList','تأكيد الطلب').onclick();await settle();assert.equal(a.calls.filter(call=>call.rpc==='review_booking').length,0);assert.match(a.toasts.at(-1),/تغيّر الطلب/);
});
test('bookings without linked requests have no review action',async()=>{
 const a=await setup({role:'admin',bookings:[{...booking,service_request_id:null}]});await a.enter('admin');assert.equal(reviewButton(a,'adminBookingsList','تأكيد الطلب'),undefined);assert.match(a.document.getElementById('adminBookingsList').textContent,/المراجعة متوقفة/);
});
test('missing booking RPC reports blocked activation without direct row mutation',async()=>{
 const a=await setup({role:'admin',bookings:[{...booking}],rpc(){return {data:null,error:{code:'PGRST202'}};}});await a.enter('admin');reviewButton(a,'adminBookingsList','تأكيد الطلب').onclick();await settle();assert.match(a.toasts.at(-1),/لم تُفعّل بعد/);assert.equal(a.calls.filter(call=>call.mode==='update').length,0);
});
test('owner organization edit never writes review authority fields and rejects zero-row response',async()=>{
 const row={id:'org-1',owner_profile_id:'owner',...organizationValues,verification_status:'verified',verification_note:'مراجع',verified_at:'2026-10-05T10:00:00Z',updated_at:'2026-10-05T10:00:00Z'},a=await setup({organizations:[row],respond(request){if(request.mode==='update')return {data:null,error:null};}});await a.enter('workspace');reviewButton(a,'organizationsList','تعديل بيانات المؤسسة').onclick();await a.submit('organizationForm',{...organizationValues,name:'تعديل المؤسسة'});const write=a.calls.find(call=>call.mode==='update');assert.equal(write.payload.verification_status,undefined);assert.equal(write.payload.verification_note,undefined);assert.equal(write.payload.verified_at,undefined);assert.match(a.toasts.at(-1),/لم يتم تأكيد التعديل/);
});
