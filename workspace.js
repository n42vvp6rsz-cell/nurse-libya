'use strict';
// Professional applications and organization review use the current static-app schema.
// Auth metadata is display data: authority always comes from the caller's stored profile.
(() => {
  const app = window.NurseApp;
  if (!app) return;
  const applicationColumns = 'id,user_id,requested_role,license_number,organization_name,city,phone,notes,status,reviewed_by,reviewed_at,created_at';
  const organizationColumns = 'id,owner_profile_id,name,kind,city,area,address,phone,email,website,description,verification_status,verification_note,verified_at,created_at,updated_at';
  const courseColumns = 'id,publisher_id,title,provider_name,description,city,status,review_status,review_note,published_at,updated_at,created_at';
  const bookingColumns = 'id,user_id,service,patient_name,phone,booking_date,status,service_request_id,created_at';
  const providerTypes = [
    {table:'doctors',role:'doctor',label:'الأطباء',owner:'profile_id',fields:['name','specialty','city','bio','years_experience']},
    {table:'nurses',role:'nurse',label:'التمريض',owner:'profile_id',fields:['name','specialty','city','bio','years_experience','available_for_home_visits']},
    {table:'hospitals',role:'hospital',label:'المستشفيات',owner:'owner_profile_id',fields:['name','city','address','description']},
    {table:'laboratories',role:'laboratory',label:'المختبرات',owner:'owner_profile_id',fields:['name','city','address','description']},
    {table:'pharmacies',role:'pharmacy',label:'الصيدليات',owner:'owner_profile_id',fields:['name','city','address','description']}
  ];
  const providerColumns = config => ['id',config.owner,...config.fields,'verified','created_at'].join(',');
  const professions = {doctor:'طبيب / طبيبة',nurse:'ممرض / ممرضة',hospital:'مستشفى',clinic:'عيادة',laboratory:'مختبر',pharmacy:'صيدلية',ambulance:'خدمات إسعاف',instructor:'مدرب / مدربة'};
  const organizationKinds = {hospital:'مستشفى',clinic:'عيادة',ambulance:'خدمات إسعاف',training_center:'مركز تدريب',medical_center:'مركز طبي',other:'مؤسسة أخرى'};
  const cities = ['طرابلس','بنغازي','مصراتة','الخمس','سبها','غريان','طبرق','البيضاء','درنة','زليتن','الزاوية','صبراتة','نالوت'];
  const applicationStatuses = {pending:'قيد المراجعة',approved:'معتمد',rejected:'غير معتمد'};
  const organizationStatuses = {pending:'قيد المراجعة',verified:'موثّقة',rejected:'غير موثّقة'};
  const attempts = new Map(), working = new Map();
  let epoch = 0, workspaceLoad = 0, adminLoad = 0, ownApplications = [], ownOrganizations = [], trustedRole = null, contractReady = false;
  const byId = id => document.getElementById(id);
  const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
  function context() { return {id:app.currentUser?.id,version:app.userVersion,epoch}; }
  function current(c) { return !!c.id && epoch === c.epoch && app.isCurrent(c.id,c.version); }
  function failure(message) { const error = new Error(message); error.userMessage = message; return error; }
  function explain(error) { return error?.userMessage || app.errorMessage(error); }
  function button(text, fn, secondary = true) { const node = el('button',text,secondary?'secondary':''); node.type = 'button'; node.onclick = fn; return node; }
  function section(id, title, intro) {
    const node = el('section'); node.id = id; node.className = 'screen'; node.hidden = true;
    node.append(el('span','نيرس ليبيا','eyebrow'),el('h1',title),el('p',intro)); byId('main').append(node); return node;
  }
  function state(id) { const node = el('p','','notice'); node.id = id; node.setAttribute('role','status'); return node; }
  function list(id) { const node = el('div'); node.id = id; node.className = 'grid'; node.setAttribute('aria-live','polite'); return node; }
  function field(form, label, name, options = {}) {
    const holder = el('label',label), input = el(options.values ? 'select' : options.multiline ? 'textarea' : 'input');
    input.name = name; input.id = `${form.id}-${name}`;
    if (options.values) Object.entries(options.values).forEach(([value,text]) => {const item = el('option',text);item.value=value;input.append(item);});
    else { if(!options.multiline)input.type = options.type || 'text'; input.maxLength = options.max || 160; if (options.multiline) input.rows = 3; }
    if (options.required) input.required = true;
    if (options.type === 'tel' || options.type === 'email' || options.type === 'url') input.dir = 'ltr';
    holder.append(input); form.append(holder); return input;
  }
  function formControls(form, label) {
    const submit = el('button',label); submit.type = 'submit'; submit.dataset.label = label;
    const discard = button('تعديل البيانات وبدء طلب جديد',() => {
      if (working.has(form.id)) return;
      attempts.delete(form.id); setLocked(form,false); discard.hidden = true;
      app.showToast('تحقق من قائمة طلباتك أولًا: قد يكون الطلب السابق محفوظًا بالفعل.');
    }); discard.className = 'secondary attempt-discard'; discard.hidden = true;
    form.append(submit,discard);
  }
  function setLocked(form, busy) {
    const frozen = attempts.has(form.id);
    form.querySelectorAll('input,select,textarea').forEach(node => { node.disabled = busy || frozen; });
    form.querySelectorAll('button').forEach(node => { node.disabled = busy; });
    const submit = form.querySelector('[type="submit"]');
    if (submit) submit.textContent = busy ? 'يرجى الانتظار…' : frozen ? 'تحقق من حفظ الطلب وأعد المحاولة' : submit.dataset.label;
    const discard = form.querySelector('.attempt-discard'); if (discard) discard.hidden = !frozen;
    if (busy) form.setAttribute('aria-busy','true'); else form.removeAttribute('aria-busy');
  }
  async function action(form, task) {
    if (working.has(form.id)) return;
    const c = context(); if (!current(c) || !app.client || !app.authReady) { app.showToast('سجّل الدخول للمواصلة.'); return; }
    working.set(form.id,c); setLocked(form,true);
    try { await task(c); } catch (error) { if (current(c)) app.showToast(explain(error)); }
    finally { if (working.get(form.id) === c) { working.delete(form.id); setLocked(form,false); } }
  }
  function bind(form, task) { form.onsubmit = event => {
    event.preventDefault();
    // Capture enabled fields before the single-flight lock; frozen retries use the
    // original payload because disabled HTML controls are absent from FormData.
    const attempt=attempts.get(form.id), values=attempt?{get:name=>attempt.payload[name]??''}:new FormData(form);
    void action(form,c=>task(form,values,c));
  }; }
  function clean(value,max,required = false) {
    const text = String(value || '').normalize('NFC').trim();
    if ((required && !text) || text.length > max || /[\u0000-\u001f\u007f]/.test(text.replace(/\r?\n/g,''))) throw failure('تحقق من الحقول المطلوبة وطول البيانات.');
    return text;
  }
  function phone(value,required = false) {
    const text = clean(value,25,required).replace(/[٠-٩۰-۹]/g,c=>String(c.charCodeAt(0)-(c>='۰'?1776:1632))).replace(/[\s()-]/g,'');
    if (text && !/^(?:0|\+218|00218)9[1-5]\d{7}$/.test(text)) throw failure('أدخل رقم هاتف ليبي صالحًا مثل 0912345678.');
    return text.startsWith('00218') ? '+'+text.slice(2) : text;
  }
  function city(value) { const text=clean(value,60);if(text && !cities.includes(text))throw failure('اختر المدينة من القائمة.');return text; }
  function website(value) {
    const text=clean(value,500); if(!text)return '';
    try {const url=new URL(text);if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw new Error();return url.href;}
    catch {throw failure('أدخل رابطًا صحيحًا يبدأ بـ https:// أو http://.');}
  }
  function reset(form) { form.reset(); form.querySelectorAll('input,textarea').forEach(node=>{node.value='';}); }
  async function query(request,c) { const result=await request;if(!current(c))return null;if(result.error)throw result.error;return result.data; }
  async function roleFor(c) {
    const row=await query(app.client.from('profiles').select('id,role').eq('id',c.id).maybeSingle(),c);
    if(!current(c))return null;
    if(!row || row.id!==c.id)throw failure('تعذّر التحقق من نوع حسابك. أعد المحاولة.');
    return row.role;
  }
  async function requireAdmin(c) { const role=await roleFor(c);if(!current(c))return false;if(role!=='admin')throw failure('هذه الصفحة متاحة لحساب الإدارة المعتمد فقط.');return true; }
  async function contractVersion(c) {
    try {const result=await app.client.rpc('nurse_app_contract_version');if(!current(c))return false;return !result.error&&result.data===1;}catch{return false;}
  }
  async function requireContract(c) {
    const ready=await contractVersion(c);if(!current(c))return false;contractReady=ready;
    if(!ready)throw failure('تحديث صلاحيات المراجعة لم يُفعّل بعد. الاعتماد وتوثيق الملفات ومراجعة الحجوزات ونشر الدورات متوقفة حتى التفعيل.');
    return true;
  }
  function uuid() { if(!window.crypto?.randomUUID)throw failure('استخدم اتصالًا آمنًا لإرسال الطلب.');return window.crypto.randomUUID(); }
  async function saveNew(form,table,columns,payload,c) {
    let attempt=attempts.get(form.id);
    if(!attempt) {attempt={id:uuid(),payload:{...payload},owner:c.id,tried:false};attempt.payload.id=attempt.id;attempts.set(form.id,attempt);}
    if(attempt.owner!==c.id)throw failure('تغيّر الحساب. افتح الصفحة مجددًا.');
    const ownerColumn=table==='organizations'?'owner_profile_id':'user_id';
    if(attempt.tried) {
      const saved=await query(app.client.from(table).select(columns).eq('id',attempt.id).eq(ownerColumn,c.id).maybeSingle(),c);
      if(!current(c))return null;
      if(saved) { if(saved.id!==attempt.id||saved[ownerColumn]!==c.id)throw failure('تعذّر تأكيد ملكية الطلب.');attempts.delete(form.id);return saved; }
    }
    attempt.tried=true;
    try {
      const saved=await query(app.client.from(table).insert(attempt.payload).select(columns).single(),c);
      if(!current(c))return null;
      if(!saved||saved.id!==attempt.id||saved[ownerColumn]!==c.id)throw new Error('Unconfirmed insert');
      attempts.delete(form.id);return saved;
    } catch(error) {
      if(!current(c))return null;
      throw failure('لم نتأكد من حفظ الطلب. احتفظنا ببياناته؛ زر التحقق يعيد استخدام نفس رقم الطلب لتجنب التكرار.');
    }
  }
  const workspace=section('workspace','الانضمام والمؤسسات','أرسل طلب اعتماد مهني، أو أضف مؤسسة لمراجعتها. إنشاء الحساب وحده لا يمنح اعتمادًا مهنيًا.');
  workspace.append(state('workspaceState'),button('تحديث بياناتي',()=>void loadWorkspace()));
  const applicationPanel=el('div',undefined,'panel'), applicationForm=el('form');applicationForm.id='providerApplicationForm';
  applicationPanel.append(el('h2','طلب اعتماد مهني'),el('p','اختر الصفة المطلوبة. الطلب قيد المراجعة حتى يعتمد فريق الإدارة بياناتك.'));
  field(applicationForm,'الصفة المطلوبة','requested_role',{values:professions,required:true});
  field(applicationForm,'رقم الترخيص أو القيد (اختياري)','license_number',{max:80});
  field(applicationForm,'اسم المؤسسة (اختياري)','organization_name',{max:160});
  field(applicationForm,'المدينة','city',{values:{'':'اختر المدينة',...Object.fromEntries(cities.map(c=>[c,c]))}});
  field(applicationForm,'رقم التواصل','phone',{type:'tel',max:25,required:true});
  field(applicationForm,'معلومات مهنية تساعد المراجعة (اختياري)','notes',{multiline:true,max:2000});
  applicationForm.append(el('p','لا ترسل بيانات المرضى أو صور وثائق حساسة في هذا الحقل.','muted'));formControls(applicationForm,'إرسال طلب الاعتماد');applicationPanel.append(applicationForm);workspace.append(applicationPanel,el('h2','طلبات اعتمادي'),list('providerApplicationsList'));
  const orgPanel=el('div',undefined,'panel'),organizationForm=el('form');organizationForm.id='organizationForm';
  orgPanel.append(el('h2','بيانات المؤسسة'));
  field(organizationForm,'اسم المؤسسة','name',{max:160,required:true});field(organizationForm,'نوع المؤسسة','kind',{values:organizationKinds,required:true});
  field(organizationForm,'المدينة','city',{values:{'':'اختر المدينة',...Object.fromEntries(cities.map(c=>[c,c]))}});
  field(organizationForm,'المنطقة (اختياري)','area',{max:100});field(organizationForm,'العنوان (اختياري)','address',{max:500});
  field(organizationForm,'هاتف المؤسسة (اختياري)','phone',{type:'tel',max:25});field(organizationForm,'البريد الإلكتروني (اختياري)','email',{type:'email',max:254});
  field(organizationForm,'الموقع الإلكتروني (اختياري)','website',{type:'url',max:500});field(organizationForm,'وصف المؤسسة (اختياري)','description',{multiline:true,max:2000});
  organizationForm.append(el('p','بيانات المؤسسة التي تكتبها، بما فيها الهاتف والعنوان، تظهر في الدليل بعد التوثيق.','muted'));formControls(organizationForm,'إرسال المؤسسة للمراجعة');
  const cancelEdit=button('إلغاء التعديل',()=>{if(working.has(organizationForm.id))return;delete organizationForm.dataset.editId;reset(organizationForm);cancelEdit.hidden=true;organizationForm.querySelector('[type="submit"]').dataset.label='إرسال المؤسسة للمراجعة';setLocked(organizationForm,false);});cancelEdit.id='cancelOrganizationEdit';cancelEdit.hidden=true;organizationForm.append(cancelEdit);
  orgPanel.append(organizationForm);workspace.append(orgPanel,el('h2','مؤسساتي'),list('organizationsList'));
  bind(applicationForm,async(form,v,c)=>{
    const requested_role=clean(v.get('requested_role'),30,true);if(!professions[requested_role])throw failure('اختر صفة مهنية متاحة.');
    if(!attempts.has(form.id)&&ownApplications.some(item=>item.status==='pending'&&item.requested_role===requested_role))throw failure('لديك طلب لهذه الصفة قيد المراجعة بالفعل.');
    const actualRole=await roleFor(c);if(!current(c))return;if(actualRole==='admin')throw failure('حساب الإدارة لا يحتاج إلى طلب لتغيير صفته.');
    const payload={user_id:c.id,requested_role,license_number:clean(v.get('license_number'),80),organization_name:clean(v.get('organization_name'),160),city:city(v.get('city')),phone:phone(v.get('phone'),true),notes:clean(v.get('notes'),2000),status:'pending',reviewed_by:null,reviewed_at:null};
    const saved=await saveNew(form,'provider_applications',applicationColumns,payload,c);if(!saved||!current(c))return;
    reset(form);app.showToast('تم حفظ طلب الاعتماد. تابع نتيجته في طلبات اعتمادي.');await loadWorkspace();
  });
  bind(organizationForm,async(form,v,c)=>{
    const kind=clean(v.get('kind'),30,true);if(!organizationKinds[kind])throw failure('اختر نوع مؤسسة متاحًا.');
    const email=clean(v.get('email'),254);if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw failure('أدخل بريدًا إلكترونيًا صحيحًا.');
    const payload={owner_profile_id:c.id,name:clean(v.get('name'),160,true),kind,city:city(v.get('city')),area:clean(v.get('area'),100),address:clean(v.get('address'),500),phone:phone(v.get('phone')),email,website:website(v.get('website')),description:clean(v.get('description'),2000)};
    let saved;
    if(form.dataset.editId) {
      const original=ownOrganizations.find(row=>row.id===form.dataset.editId);if(!original)throw failure('حدّث قائمة مؤسساتك قبل التعديل.');
      let update=app.client.from('organizations').update({...payload,updated_at:new Date().toISOString()}).eq('id',original.id).eq('owner_profile_id',c.id);
      if(original.updated_at)update=update.eq('updated_at',original.updated_at);
      saved=await query(update.select(organizationColumns).maybeSingle(),c);if(!current(c))return;
      if(!saved||saved.id!==original.id||saved.owner_profile_id!==c.id)throw failure('لم يتم تأكيد التعديل؛ ربما تغيّرت البيانات. حدّث مؤسساتك وأعد المحاولة.');
    } else saved=await saveNew(form,'organizations',organizationColumns,{...payload,verification_status:'pending'},c);
    if(!saved||!current(c))return;delete form.dataset.editId;cancelEdit.hidden=true;reset(form);form.querySelector('[type="submit"]').dataset.label='إرسال المؤسسة للمراجعة';app.showToast('تم حفظ بيانات المؤسسة. حالة التوثيق تظهر في مؤسساتي.');await loadWorkspace();
  });
  function renderApplications(rows) {
    const target=byId('providerApplicationsList');target.replaceChildren();
    if(!rows.length)target.append(el('p','لم ترسل طلب اعتماد بعد.','empty'));
    rows.forEach(row=>{const card=el('article',undefined,'card');card.append(el('h3',professions[row.requested_role]||'طلب اعتماد'),el('p',applicationStatuses[row.status]||'حالة غير محددة','status'));if(row.organization_name)card.append(el('p',row.organization_name));if(row.city)card.append(el('p',row.city));card.append(el('small',`رقم الطلب: ${row.id}`));target.append(card);});
    if(rows.length===100)target.append(el('p','يتم عرض أحدث 100 طلب.','muted'));
  }
  function editOrganization(row) {
    if(working.has(organizationForm.id)||attempts.has(organizationForm.id)) {app.showToast('أكمل التحقق من الطلب الحالي قبل تعديل مؤسسة أخرى.');return;}
    ['name','kind','city','area','address','phone','email','website','description'].forEach(name=>{organizationForm.querySelector(`[name="${name}"]`).value=row[name]||'';});
    organizationForm.dataset.editId=row.id;cancelEdit.hidden=false;organizationForm.querySelector('[type="submit"]').dataset.label='حفظ التعديل';setLocked(organizationForm,false);organizationForm.scrollIntoView?.({block:'start'});organizationForm.querySelector('input')?.focus();
  }
  function renderOrganizations(rows) {
    const target=byId('organizationsList');target.replaceChildren();if(!rows.length)target.append(el('p','لم تضف مؤسسة بعد.','empty'));
    rows.forEach(row=>{const card=el('article',undefined,'card');card.append(el('h3',row.name),el('p',organizationStatuses[row.verification_status]||'حالة غير محددة','status'));if(row.city)card.append(el('p',row.city));if(row.verification_note)card.append(el('p',row.verification_note));card.append(button('تعديل بيانات المؤسسة',()=>editOrganization(row)));target.append(card);});
    if(rows.length===100)target.append(el('p','يتم عرض أحدث 100 مؤسسة.','muted'));
  }
  function loadError(target, label, fn) {target.replaceChildren(el('p',label),button('إعادة المحاولة',()=>void fn()));}
  async function loadWorkspace() {
    const c=context(),serial=++workspaceLoad;if(!current(c)||!app.client)return;
    byId('workspaceState').textContent='جارٍ تحميل بياناتك…';byId('providerApplicationsList').textContent='جارٍ تحميل الطلبات…';byId('organizationsList').textContent='جارٍ تحميل المؤسسات…';
    const results=await Promise.allSettled([roleFor(c),query(app.client.from('provider_applications').select(applicationColumns).eq('user_id',c.id).order('created_at',{ascending:false}).limit(100),c),query(app.client.from('organizations').select(organizationColumns).eq('owner_profile_id',c.id).order('created_at',{ascending:false}).limit(100),c)]);
    if(!current(c)||serial!==workspaceLoad)return;
    trustedRole=results[0].status==='fulfilled'?results[0].value:null;
    byId('workspaceState').textContent=trustedRole?`صفة الحساب المعتمدة: ${professions[trustedRole]||(trustedRole==='admin'?'الإدارة':'طالب رعاية')}`:'تعذّر التحقق من صفة الحساب. أعد المحاولة.';
    applicationPanel.hidden=trustedRole==='admin';
    if(results[1].status==='fulfilled') {ownApplications=results[1].value||[];renderApplications(ownApplications);}else{ownApplications=[];loadError(byId('providerApplicationsList'),'تعذّر تحميل طلبات الاعتماد.',loadWorkspace);}
    if(results[2].status==='fulfilled') {ownOrganizations=results[2].value||[];renderOrganizations(ownOrganizations);}else{ownOrganizations=[];loadError(byId('organizationsList'),'تعذّر تحميل المؤسسات.',loadWorkspace);}
  }
  const admin=section('admin','مراجعة الإدارة','الاعتماد متاح لحسابات الإدارة المعتمدة فقط. راجع بيانات الطلب قبل القرار.');
  admin.append(state('adminState'),button('تحديث المراجعات',()=>void loadAdmin()),el('h2','طلبات الاعتماد المهني'),list('adminApplicationsList'),el('h2','مؤسسات بانتظار التوثيق'),list('adminOrganizationsList'),el('h2','دورات بانتظار المراجعة'),list('adminCoursesList'),el('h2','ملفات مقدّمي الخدمة غير الموثّقة'),el('p','توثيق الملف يتيح ظهوره في الدليل. لا تُوثّق ملفًا قبل مراجعة محتواه وصاحبه.','muted'));
  providerTypes.forEach(config=>admin.append(el('h3',config.label),list(`adminProviders-${config.table}`)));
  admin.append(el('h2','مراجعة الحجوزات'),el('p','تأكيد الطلب أو إلغاؤه يحدّث حالته والطلب المرتبط معًا. طلبات الرعاية التي لا تحتوي رابطًا داخليًا تحتاج معالجة قبل المراجعة.','muted'),list('adminBookingsList'));
  const adminListIds = ['adminApplicationsList','adminOrganizationsList','adminCoursesList',...providerTypes.map(config=>`adminProviders-${config.table}`),'adminBookingsList'];
  const reviewLocks=new Map();
  async function reviewTask(key,c,controls,task,needsContract = true) {
    if(reviewLocks.has(key)||!current(c))return;reviewLocks.set(key,c);const disabled=controls.map(b=>b.disabled);controls.forEach(b=>{b.disabled=true;});
    try {if(!await requireAdmin(c))return;if(needsContract&&!await requireContract(c))return;await task();}catch(error){if(current(c))app.showToast(explain(error));}
    finally {if(reviewLocks.get(key)===c){reviewLocks.delete(key);if(current(c))controls.forEach((b,i)=>{b.disabled=disabled[i]||(needsContract&&!contractReady);});}}
  }
  function reviewButtons(card, key, c, task, enabled = true, needsContract = true) {
    const controls=[];controls.push(button('اعتماد',()=>void reviewTask(key,c,controls,()=>task(true),needsContract),false),button('رفض',()=>void reviewTask(key,c,controls,()=>task(false),needsContract)));
    const actions=el('div',undefined,'card-actions');controls.forEach(node=>{node.disabled=!enabled;actions.append(node);});card.append(actions);return controls;
  }
  async function reviewApplication(row,approve,c) {
    const fresh=await query(app.client.from('provider_applications').select(applicationColumns).eq('id',row.id).maybeSingle(),c);if(!current(c))return;
    if(!fresh||fresh.status!=='pending'||fresh.user_id!==row.user_id||fresh.requested_role!==row.requested_role)throw failure('تغيّر هذا الطلب؛ حدّث قائمة المراجعة.');
    const applicant=await query(app.client.from('profiles').select('id,role').eq('id',row.user_id).maybeSingle(),c);if(!current(c))return;
    if(!applicant||applicant.id!==row.user_id)throw failure('لم تُفعّل صلاحية التحقق من ملف مقدم الطلب؛ لا يمكن تأكيد الاعتماد بعد.');
    if(!professions[row.requested_role]||applicant.role==='admin')throw failure('هذه الصفة لا يمكن اعتمادها من هذه الواجهة.');
    const response=await app.client.rpc('approve_provider_application',{p_application_id:row.id,p_approve:approve});if(!current(c))return;if(response.error)throw response.error;
    const checked=await query(app.client.from('provider_applications').select(applicationColumns).eq('id',row.id).maybeSingle(),c);if(!current(c))return;
    if(!checked||checked.status!==(approve?'approved':'rejected')||checked.reviewed_by!==c.id||!checked.reviewed_at)throw failure('لم يتم تأكيد قرار المراجعة. حدّث القائمة قبل إعادة المحاولة.');
    if(approve) {
      const promoted=await query(app.client.from('profiles').select('id,role').eq('id',row.user_id).maybeSingle(),c);if(!current(c))return;
      if(!promoted||promoted.id!==row.user_id||promoted.role!==row.requested_role)throw failure('لم يتأكد تفعيل صفة مقدم الخدمة. قد يكون الطلب تغيّر دون تفعيل الحساب؛ راجع إعدادات قاعدة البيانات.');
    }
    app.showToast(approve?'تم تأكيد اعتماد الحساب المهني.':'تم تأكيد رفض طلب الاعتماد.');await loadAdmin();
  }
  function renderAdminApplications(rows,profiles,c) {
    const target=byId('adminApplicationsList');target.replaceChildren();const pending=rows.filter(row=>row.status==='pending');
    if(!pending.length)target.append(el('p','لا توجد طلبات اعتماد قيد المراجعة.','empty'));
    pending.forEach(row=>{const card=el('article',undefined,'card');card.append(el('h3',professions[row.requested_role]||'صفة غير مدعومة'),el('p',row.organization_name||'طلب اعتماد فردي'));if(row.city)card.append(el('p',row.city));if(row.license_number)card.append(el('p',`الترخيص / القيد: ${row.license_number}`));if(row.notes)card.append(el('p',row.notes));
      const profile=profiles.get(row.user_id),enabled=contractReady&&!!profile&&profile.role!=='admin'&&!!professions[row.requested_role];
      if(!enabled)card.append(el('p','تعذّر التحقق من ملف صاحب الطلب أو الصفة المطلوبة؛ الاعتماد متوقف لحين تصحيح الصلاحيات.','notice'));
      reviewButtons(card,`application:${row.id}`,c,approve=>reviewApplication(row,approve,c),enabled);target.append(card);});
    const reviewed=rows.filter(row=>row.status!=='pending');if(reviewed.length){const details=el('details');details.append(el('summary','الطلبات التي تمت مراجعتها'));reviewed.forEach(row=>details.append(el('p',`${professions[row.requested_role]||row.requested_role} — ${applicationStatuses[row.status]||row.status}`)));target.append(details);}
    if(rows.length===100)target.append(el('p','يتم عرض أحدث 100 طلب؛ توجد مراجعات أقدم محتملة.','muted'));
  }
  function reviewNote(card,id) { const label=el('label','ملاحظة المراجعة (اختياري)'),input=el('textarea');input.id=id;input.maxLength=1000;input.rows=2;label.append(input);card.append(label);return input; }
  function renderAdminOrganizations(rows,c) {
    const target=byId('adminOrganizationsList');target.replaceChildren();if(!rows.length)target.append(el('p','لا توجد مؤسسات قيد المراجعة.','empty'));
    rows.forEach(row=>{const card=el('article',undefined,'card');card.append(el('h3',row.name),el('p',organizationKinds[row.kind]||row.kind),el('p',[row.city,row.area,row.address].filter(Boolean).join('، ')));if(row.description)card.append(el('p',row.description));const note=reviewNote(card,`organization-review-${row.id}`);
      reviewButtons(card,`organization:${row.id}`,c,async approve=>{
        const payload={verification_status:approve?'verified':'rejected',verification_note:clean(note.value,1000),verified_at:approve?new Date().toISOString():null,updated_at:new Date().toISOString()};
        let request=app.client.from('organizations').update(payload).eq('id',row.id).eq('verification_status','pending');if(row.updated_at)request=request.eq('updated_at',row.updated_at);
        const saved=await query(request.select(organizationColumns).maybeSingle(),c);if(!current(c))return;
        if(!saved||saved.id!==row.id||saved.verification_status!==payload.verification_status)throw failure('لم يتم تأكيد القرار؛ ربما تغيّرت بيانات المؤسسة. حدّث القائمة.');
        app.showToast(approve?'تم تأكيد توثيق المؤسسة.':'تم تأكيد رفض توثيق المؤسسة.');await loadAdmin();
      },true,false);target.append(card);});if(rows.length===100)target.append(el('p','يتم عرض أقدم 100 مؤسسة بانتظار المراجعة.','muted'));
  }
  function renderAdminCourses(rows,c) {
    const target=byId('adminCoursesList');target.replaceChildren();if(!rows.length)target.append(el('p','لا توجد دورات قيد المراجعة.','empty'));
    rows.forEach(row=>{const card=el('article',undefined,'card');card.append(el('h3',row.title),el('p',row.provider_name),el('p',row.description));if(row.city)card.append(el('p',row.city));const note=reviewNote(card,`course-review-${row.id}`);
      reviewButtons(card,`course:${row.id}`,c,async approve=>{
        const payload={review_status:approve?'approved':'rejected',status:approve?'active':'closed',review_note:clean(note.value,1000),published_at:approve?new Date().toISOString():null,updated_at:new Date().toISOString()};
        let request=app.client.from('courses').update(payload).eq('id',row.id).eq('review_status','pending');if(row.updated_at)request=request.eq('updated_at',row.updated_at);
        const saved=await query(request.select(courseColumns).maybeSingle(),c);if(!current(c))return;
        if(!saved||saved.id!==row.id||saved.review_status!==payload.review_status||saved.status!==payload.status)throw failure('لم يتم تأكيد المراجعة؛ ربما تغيّرت الدورة. حدّث القائمة.');
        app.showToast(approve?'تم تأكيد اعتماد ونشر الدورة.':'تم تأكيد رفض نشر الدورة.');await loadAdmin();
      },contractReady);target.append(card);});if(rows.length===100)target.append(el('p','يتم عرض أقدم 100 دورة بانتظار المراجعة.','muted'));
  }
  function renderAdminProviders(rows,config,c) {
    const target=byId(`adminProviders-${config.table}`);target.replaceChildren();if(!rows.length)target.append(el('p','لا توجد ملفات متاحة بانتظار التوثيق.','empty'));
    rows.forEach(row=>{
      const card=el('article',undefined,'card');card.append(el('h3',row.name),el('p','غير موثّق','status'));
      ['specialty','city','bio','address','description'].forEach(field=>{if(row[field])card.append(el('p',row[field]));});
      if(row.years_experience!==undefined&&row.years_experience!==null)card.append(el('p',`سنوات الخبرة: ${row.years_experience}`));
      if(config.table==='nurses')card.append(el('p',row.available_for_home_visits?'يقدّم زيارات منزلية':'لا يقدّم زيارات منزلية'));
      const controls=[],actions=el('div',undefined,'card-actions');
      const verify=button('توثيق الملف',()=>void reviewTask(`provider:${config.table}:${row.id}`,c,controls,async()=>{
        const owner=await query(app.client.from('profiles').select('id,role').eq('id',row[config.owner]).maybeSingle(),c);if(!current(c))return;
        if(!owner||owner.id!==row[config.owner]||owner.role!==config.role||owner.id===c.id)throw failure('تعذّر تأكيد صفة صاحب الملف أو صلاحية المراجعة؛ لا يمكن توثيقه.');
        let request=app.client.from(config.table).update({verified:true}).eq('id',row.id).eq(config.owner,row[config.owner]).eq('verified',false);
        // These tables have no updated_at. Compare every reviewed content field so
        // an owner edit between the queue read and the decision cannot be approved.
        config.fields.forEach(field=>{request=row[field]===null||row[field]===undefined?request.is(field,null):request.eq(field,row[field]);});
        const saved=await query(request.select(providerColumns(config)).maybeSingle(),c);if(!current(c))return;
        if(!saved||saved.id!==row.id||saved[config.owner]!==row[config.owner]||saved.verified!==true)throw failure('لم يتم تأكيد التوثيق؛ ربما تغيّر محتوى الملف. حدّث القائمة وراجعه مجددًا.');
        app.showToast('تم تأكيد توثيق ملف مقدم الخدمة.');await loadAdmin();
      }),false);
      const keep=button('تأجيل المراجعة',()=>{if(current(c))app.showToast('لم يُرسل قرار توثيق. يمكنك العودة إلى الملف لاحقًا.');});
      verify.disabled=!contractReady;controls.push(verify,keep);actions.append(verify,keep);card.append(actions);target.append(card);
    });if(rows.length===100)target.append(el('p','يتم عرض أقدم 100 ملف غير موثّق.','muted'));
  }
  function bookingStatus(value) {return ({pending:'pending','قيد المراجعة':'pending',confirmed:'confirmed','تم التأكيد':'confirmed',completed:'completed','مكتمل':'completed',cancelled:'cancelled','ملغي':'cancelled'})[value]||'unknown';}
  async function reviewBooking(row,newStatus,c) {
    const fresh=await query(app.client.from('bookings').select(bookingColumns).eq('id',row.id).maybeSingle(),c);if(!current(c))return;
    if(!fresh||fresh.status!==row.status||fresh.service_request_id!==row.service_request_id||fresh.user_id!==row.user_id)throw failure('تغيّر الطلب؛ حدّث قائمة الحجوزات قبل المراجعة.');
    const response=await app.client.rpc('review_booking',{p_booking_id:row.id,p_expected_status:row.status,p_new_status:newStatus});if(!current(c))return;
    if(response.error){if(['PGRST202','42883','42501'].includes(response.error.code))throw failure('صلاحية مراجعة الحجوزات لم تُفعّل بعد. تعذّر تأكيد القرار.');throw response.error;}
    const saved=Array.isArray(response.data)&&response.data.length===1?response.data[0]:null,requestStatus=newStatus==='confirmed'?'accepted':newStatus;
    if(!saved||saved.id!==row.id||saved.status!==newStatus||saved.service_request_id!==row.service_request_id||saved.service_request_status!==requestStatus)throw failure('لم يتم تأكيد تحديث الحجز والطلب المرتبط؛ حدّث القائمة قبل إعادة المحاولة.');
    const checked=await query(app.client.from('bookings').select(bookingColumns).eq('id',row.id).maybeSingle(),c);if(!current(c))return;
    if(!checked||checked.id!==row.id||checked.status!==newStatus||checked.service_request_id!==row.service_request_id)throw failure('لم يتم تأكيد حالة الحجز المحفوظة. حدّث القائمة.');
    app.showToast(newStatus==='confirmed'?'تم تأكيد الحجز والطلب المرتبط.':newStatus==='completed'?'تم تأكيد إكمال الحجز والطلب المرتبط.':'تم تأكيد إلغاء الحجز والطلب المرتبط.');await loadAdmin();
  }
  function renderAdminBookings(rows,c) {
    const target=byId('adminBookingsList');target.replaceChildren();if(!rows.length)target.append(el('p','لا توجد حجوزات متاحة للمراجعة.','empty'));
    const labels={pending:'قيد المراجعة',confirmed:'تم التأكيد',completed:'مكتمل',cancelled:'ملغي',unknown:'حالة غير مدعومة'};
    rows.forEach(row=>{
      const card=el('article',undefined,'card'),status=bookingStatus(row.status);card.append(el('h3',row.service),el('p',labels[status],'status'),el('p',row.patient_name),el('p',row.booking_date));
      if(row.phone){const contact=el('p',row.phone);contact.dir='ltr';card.append(contact);}card.append(el('small',`رقم الطلب: ${row.id}`));
      if(!row.service_request_id){card.append(el('p','لا يحتوي الحجز طلبًا مرتبطًا؛ المراجعة متوقفة حتى استكمال الربط.','notice'));target.append(card);return;}
      const transitions=status==='pending'?[['تأكيد الطلب','confirmed'],['إلغاء الطلب','cancelled']]:status==='confirmed'?[['إكمال الخدمة','completed'],['إلغاء الطلب','cancelled']]:[],controls=[],actions=el('div',undefined,'card-actions');
      transitions.forEach(([label,next])=>{const control=button(label,()=>void reviewTask(`booking:${row.id}`,c,controls,()=>reviewBooking(row,next,c)),next!=='confirmed');control.disabled=!contractReady;controls.push(control);actions.append(control);});if(controls.length)card.append(actions);target.append(card);
    });if(rows.length===100)target.append(el('p','يتم عرض أحدث 100 حجز.','muted'));
  }
  async function loadAdmin() {
    const c=context(),serial=++adminLoad;if(!current(c)||!app.client)return;
    const ids=adminListIds;ids.forEach(id=>{byId(id).replaceChildren();});byId('adminState').textContent='جارٍ التحقق من صلاحية الإدارة…';
    try {
      if(!await requireAdmin(c)||!current(c)||serial!==adminLoad)return;
      const ready=await contractVersion(c);if(!current(c)||serial!==adminLoad)return;contractReady=ready;
      byId('adminState').textContent=contractReady?'الحساب معتمد للإدارة. يتم عرض البيانات اللازمة للمراجعة فقط.':'الحساب معتمد للإدارة، لكن تحديث صلاحيات المراجعة لم يُفعّل بعد. الاعتماد وتوثيق الملفات ومراجعة الحجوزات ونشر الدورات متوقفة حتى التفعيل.';ids.forEach(id=>{byId(id).textContent='جارٍ تحميل المراجعات…';});
      const results=await Promise.allSettled([query(app.client.from('provider_applications').select(applicationColumns).order('created_at',{ascending:false}).limit(100),c),query(app.client.from('organizations').select(organizationColumns).eq('verification_status','pending').order('created_at',{ascending:true}).limit(100),c),query(app.client.from('courses').select(courseColumns).eq('review_status','pending').order('created_at',{ascending:true}).limit(100),c),...providerTypes.map(config=>query(app.client.from(config.table).select(providerColumns(config)).eq('verified',false).order('created_at',{ascending:true}).limit(100),c)),query(app.client.from('bookings').select(bookingColumns).order('created_at',{ascending:false}).limit(100),c)]);
      if(!current(c)||serial!==adminLoad)return;
      if(results[0].status==='fulfilled') {
        const rows=results[0].value||[],applicants=[...new Set(rows.filter(row=>row.status==='pending').map(row=>row.user_id))];let profiles=new Map();
        if(applicants.length){try{const data=await query(app.client.from('profiles').select('id,role').in('id',applicants),c);if(!current(c)||serial!==adminLoad)return;profiles=new Map((data||[]).map(row=>[row.id,row]));}catch{/* Legacy backend lacks admin SELECT. Approval remains disabled. */}}
        renderAdminApplications(rows,profiles,c);
      }else loadError(byId(ids[0]),'تعذّر تحميل طلبات الاعتماد.',loadAdmin);
      if(results[1].status==='fulfilled')renderAdminOrganizations(results[1].value||[],c);else loadError(byId(ids[1]),'تعذّر تحميل مراجعات المؤسسات.',loadAdmin);
      if(results[2].status==='fulfilled')renderAdminCourses(results[2].value||[],c);else loadError(byId(ids[2]),'تعذّر تحميل مراجعات الدورات.',loadAdmin);
      providerTypes.forEach((config,index)=>{const result=results[3+index];if(result.status==='fulfilled')renderAdminProviders(result.value||[],config,c);else loadError(byId(`adminProviders-${config.table}`),'تعذّر تحميل الملفات أو لم تُفعّل صلاحية التوثيق بعد.',loadAdmin);});
      const bookings=results.at(-1);if(bookings.status==='fulfilled')renderAdminBookings(bookings.value||[],c);else loadError(byId('adminBookingsList'),'تعذّر تحميل الحجوزات أو لم تُفعّل صلاحية المراجعة بعد.',loadAdmin);
    }catch(error){if(current(c)&&serial===adminLoad){byId('adminState').textContent=explain(error);ids.forEach(id=>byId(id).replaceChildren());}}
  }
  function clearPrivate() {
    epoch++;workspaceLoad++;adminLoad++;trustedRole=null;contractReady=false;ownApplications=[];ownOrganizations=[];attempts.clear();working.clear();reviewLocks.clear();
    ['workspaceState','providerApplicationsList','organizationsList','adminState',...adminListIds].forEach(id=>byId(id).replaceChildren());
    [applicationForm,organizationForm].forEach(form=>{reset(form);setLocked(form,false);});delete organizationForm.dataset.editId;cancelEdit.hidden=true;applicationPanel.hidden=false;
    organizationForm.querySelector('[type="submit"]').dataset.label='إرسال المؤسسة للمراجعة';setLocked(organizationForm,false);
  }
  app.registerRoute('workspace',{requiresAuth:true,onEnter:loadWorkspace});app.registerRoute('admin',{requiresAuth:true,onEnter:loadAdmin});
  app.onUserChange(clearPrivate);
  app.onReady(()=>{if(location.hash==='#workspace')void loadWorkspace();if(location.hash==='#admin')void loadAdmin();});
})();
