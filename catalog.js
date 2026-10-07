'use strict';
(() => {
  const app = window.NurseApp;
  if (!app) return;
  const cities = ['طرابلس','بنغازي','مصراتة','الخمس','سبها','غريان','طبرق','البيضاء','درنة','زليتن','الزاوية','صبراتة','نالوت'];
  const limit = 200;
  const kinds = {doctor:'طبيب / طبيبة',nurse:'ممرض / ممرضة',hospital:'مستشفى',clinic:'عيادة',ambulance:'جهة إسعاف',training_center:'مركز تدريب',medical_center:'مركز طبي',laboratory:'مختبر',pharmacy:'صيدلية',other:'مؤسسة أخرى'};
  const definitions = {
    providers:{title:'مقدمو الرعاية',intro:'ابحث حسب المدينة والمهنة والتخصص، ثم أرسل طلب تنسيق الخدمة.',types:['doctor','nurse']},
    organizations:{title:'المؤسسات الصحية',intro:'المؤسسات والمستشفيات والمختبرات والصيدليات المتاحة في الدليل.',types:['hospital','clinic','ambulance','training_center','medical_center','laboratory','pharmacy','other']},
    jobs:{title:'الوظائف الصحية',intro:'تصفح الفرص المفتوحة وأرسل تقديمك من حسابك.'},
    courses:{title:'الدورات والتدريب',intro:'اطّلع على الدورات المنشورة، وتابع طلب الالتحاق بالدورات المجانية.'}
  };
  const state = Object.fromEntries(Object.keys(definitions).map(key => [key,{rows:[],version:0,loaded:false,bounded:false}]));
  let privateVersion = 0;
  const mineVersion={jobs:0,courses:0};
  let applications = [], enrollments = [];
  const inFlight = new Set();
  const node = (tag,text,className) => {const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element;};
  const byId = id => document.getElementById(id);
  const normalize = value => String(value || '').normalize('NFC').trim();
  const textKey = value => normalize(value).toLocaleLowerCase('ar');
  const current = (id,version) => app.isCurrent(id,version);
  const today = () => new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Tripoli',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).filter(part => ['year','month','day'].includes(part.type)).reduce((result,part) => ({...result,[part.type]:part.value}),{});
  const todayString = () => {const parts=today();return `${parts.year}-${parts.month}-${parts.day}`;};
  const statusNames = {submitted:'تم إرسال التقديم',reviewing:'قيد المراجعة',shortlisted:'ضمن القائمة المختصرة',accepted:'تم القبول',rejected:'لم يُقبل',withdrawn:'تم سحب التقديم',pending:'قيد المراجعة',active:'التحاق نشط',completed:'مكتمل',cancelled:'ملغى',refunded:'مسترد'};
  const empty = message => node('p',message,'empty');
  function retryState(container,message,retry) {
    container.replaceChildren(empty(message));
    const button=node('button','إعادة المحاولة','secondary');button.type='button';button.onclick=retry;container.append(button);
  }
  function makeFilters(key) {
    const form=node('form',undefined,'catalog-filters'); form.setAttribute('role','search');
    const searchLabel=node('label','البحث');const search=node('input');search.type='search';search.id=`${key}Search`;search.placeholder='الاسم أو التخصص';search.maxLength=100;searchLabel.append(search);
    const cityLabel=node('label','المدينة');const city=node('select');city.id=`${key}City`;
    [['','كل المدن'],...cities.map(value=>[value,value])].forEach(([value,label])=>{const option=node('option',label);option.value=value;city.append(option);});cityLabel.append(city);form.append(searchLabel,cityLabel);
    if (definitions[key].types) {
      const kindLabel=node('label',key==='providers'?'المهنة':'نوع المؤسسة');const kind=node('select');kind.id=`${key}Kind`;
      [['','كل الأنواع'],...definitions[key].types.map(value=>[value,kinds[value]])].forEach(([value,label])=>{const option=node('option',label);option.value=value;kind.append(option);});kindLabel.append(kind);form.append(kindLabel);
    }
    form.onsubmit=event=>event.preventDefault();form.oninput=()=>render(key);form.onchange=()=>render(key);return form;
  }
  function createScreen(key) {
    const screen=byId(key);if(!screen)return;
    const header=node('div',undefined,'section-head');const title=node('div');title.append(node('span','دليل نيرس ليبيا','eyebrow'),node('h1',definitions[key].title));
    const refresh=node('button','تحديث','secondary');refresh.id=`${key}Refresh`;refresh.type='button';refresh.onclick=()=>void load(key);header.append(title,refresh);
    const summary=node('p');summary.id=`${key}Status`;summary.setAttribute('role','status');
    const results=node('div',undefined,'grid');results.id=`${key}Results`;
    screen.replaceChildren(header,node('p',definitions[key].intro,'muted'),makeFilters(key),summary,results);
    if(key==='jobs'||key==='courses') {
      const mine=node('section',undefined,'catalog-mine');mine.id=`${key}Mine`;mine.hidden=true;mine.setAttribute('aria-label',key==='jobs'?'تقديماتي للوظائف':'طلبات التحاقي');screen.append(mine);
    }
  }
  async function publicQuery(table,columns,filters,order='name') {
    let query=app.client.from(table).select(columns);
    for(const [column,value] of filters)query=query.eq(column,value);
    if(table==='jobs')query=query.or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`);
    const {data,error}=await query.order(order,{ascending:order==='name'}).limit(limit);
    if(error)throw error;
    return Array.isArray(data)?data:[];
  }
  async function fetchRows(key) {
    if(key==='providers') {
      const result=await Promise.allSettled([
        publicQuery('doctors','id,profile_id,name,specialty,hospital_name,city,bio,years_experience,verified',[['verified',true]]),
        publicQuery('nurses','id,profile_id,name,specialty,city,bio,years_experience,available_for_home_visits,verified',[['verified',true]])
      ]);
      if(result.some(item=>item.status==='rejected'))throw new Error('Directory unavailable');
      return {rows:result.flatMap((item,index)=>item.value.filter(row=>row.verified===true).map(row=>({...row,kind:index===0?'doctor':'nurse'}))),bounded:result.some(item=>item.value.length>=limit)};
    }
    if(key==='organizations') {
      const tables=['organizations','hospitals','laboratories','pharmacies'];
      const results=await Promise.allSettled(tables.map(table=>table==='organizations'
        ?publicQuery(table,'id,name,kind,city,area,address,description,verification_status',[['verification_status','verified']])
        :publicQuery(table,`id,${table==='hospitals'?'owner_profile_id,':''}name,city,address,description,verified`,[['verified',true]])));
      if(results.some(item=>item.status==='rejected'))throw new Error('Directory unavailable');
      return {rows:results.flatMap((item,index)=>item.value.filter(row=>index===0?row.verification_status==='verified':row.verified===true).map(row=>({...row,kind:index===0?row.kind:['','hospital','laboratory','pharmacy'][index],table:tables[index]}))),bounded:results.some(item=>item.value.length>=limit)};
    }
    if(key==='jobs') {
      const rows=await publicQuery('jobs','id,title,organization_name,city,employment_type,description,requirements,status,expires_at',[['status','active']],'created_at');
      return {rows:rows.filter(row=>row.status==='active'&&(!row.expires_at||Number.isFinite(Date.parse(row.expires_at))&&Date.parse(row.expires_at)>Date.now())),bounded:rows.length>=limit};
    }
    const rows=await publicQuery('courses','id,title,provider_name,city,start_date,end_date,price,seats,description,category,level,duration_minutes,learning_outcomes,is_free,status,review_status',[['status','active'],['review_status','approved']],'created_at');
    return {rows:rows.filter(row=>row.status==='active'&&row.review_status==='approved'),bounded:rows.length>=limit};
  }
  async function load(key) {
    const container=byId(`${key}Results`);if(!container)return;
    const version=++state[key].version;state[key].loaded=false;state[key].rows=[];
    container.replaceChildren(empty('جارٍ التحميل…'));container.setAttribute('aria-busy','true');byId(`${key}Status`).textContent='جارٍ تحميل القائمة…';byId(`${key}Refresh`).disabled=true;
    try {
      if(!app.client||!app.authReady)throw new Error('Unavailable');
      const result=await fetchRows(key);if(version!==state[key].version)return;
      Object.assign(state[key],result,{loaded:true});render(key);
      if(key==='jobs'||key==='courses')void loadMine(key);
    } catch(error) {
      if(version!==state[key].version)return;
      retryState(container,'تعذّر تحميل الدليل. تحقق من الاتصال ثم أعد المحاولة.',()=>void load(key));byId(`${key}Status`).textContent='تعذّر تحميل القائمة.';
    } finally {if(version===state[key].version){container.removeAttribute('aria-busy');byId(`${key}Refresh`).disabled=false;}}
  }
  function bookingButton(kind,profileId) {
    const service={doctor:'doctors',nurse:'home-nursing',hospital:'hospitals'}[kind];
    if(!service)return null;
    const button=node('button','طلب تنسيق الخدمة','secondary');button.type='button';
    button.onclick=()=>{if(typeof app.chooseService==='function')app.chooseService(service,{providerProfileId:profileId||null});else location.hash='services';};return button;
  }
  function detail(card,value,className='muted') {if(normalize(value))card.append(node('p',value,className));}
  function publicCard(key,row) {
    const card=node('article',undefined,'card catalog-card');
    card.append(node('span',key==='providers'||key==='organizations'?kinds[row.kind]||'مؤسسة صحية':key==='jobs'?'فرصة عمل':'تدريب','eyebrow'),node('h2',row.name||row.title));
    detail(card,row.city||'المدينة غير محددة');
    if(key==='providers') {
      detail(card,[row.specialty,row.hospital_name].filter(Boolean).join(' · '));detail(card,row.bio);
      if(Number.isInteger(row.years_experience)&&row.years_experience>0)detail(card,`الخبرة: ${row.years_experience} سنة`);
      if(row.kind==='nurse'&&!row.available_for_home_visits)detail(card,'الزيارات المنزلية غير متاحة حاليًا.');
      else {const action=bookingButton(row.kind,row.profile_id);if(action)card.append(action);}
    } else if(key==='organizations') {
      detail(card,[row.area,row.address].filter(Boolean).join(' · '));detail(card,row.description);
      if(row.table==='hospitals'){const action=bookingButton('hospital',row.owner_profile_id);if(action)card.append(action);}
    } else if(key==='jobs') {
      detail(card,row.organization_name);detail(card,row.employment_type);detail(card,row.description);detail(card,row.requirements);
      if(row.expires_at)detail(card,`آخر موعد: ${new Intl.DateTimeFormat('ar-LY',{timeZone:'Africa/Tripoli',dateStyle:'medium'}).format(new Date(row.expires_at))}`);
      const existing=applications.find(item=>item.job_id===row.id);
      if(app.currentUser&&existing)detail(card,statusNames[existing.status]||'تم إرسال التقديم');
      else if(!app.currentUser){const link=node('a','سجّل الدخول للتقديم','button secondary');link.href='#jobs';link.onclick=event=>{event.preventDefault();app.requireLogin?app.requireLogin('jobs'):location.hash='login';};card.append(link);}
      else card.append(applicationForm(row));
    } else {
      detail(card,row.provider_name);detail(card,[row.category,row.level].filter(Boolean).join(' · '));detail(card,row.description);
      if(row.start_date)detail(card,`تاريخ البداية: ${row.start_date}`);
      if(Number.isInteger(row.duration_minutes)&&row.duration_minutes>0)detail(card,`المدة: ${row.duration_minutes} دقيقة`);
      if(Array.isArray(row.learning_outcomes)&&row.learning_outcomes.some(item=>typeof item==='string')) {const list=node('ul');row.learning_outcomes.filter(item=>typeof item==='string').slice(0,20).forEach(item=>list.append(node('li',item)));card.append(list);}
      const existing=enrollments.find(item=>item.course_id===row.id);
      if(app.currentUser&&existing)detail(card,statusNames[existing.status]||'تم إرسال طلب الالتحاق');
      else if(row.end_date&&row.end_date<todayString())detail(card,'انتهت فترة هذه الدورة.');
      else if(row.seats!==null&&row.seats!==undefined&&(!Number.isInteger(row.seats)||row.seats<=0))detail(card,'لا توجد مقاعد متاحة معلنة.');
      else if(row.is_free!==true)detail(card,'الالتحاق المدفوع غير متاح حاليًا.');
      else {detail(card,'دورة مجانية');const button=node('button',app.currentUser?'طلب الالتحاق':'سجّل الدخول للالتحاق','secondary');button.type='button';button.onclick=()=>{if(!app.currentUser){app.requireLogin?app.requireLogin('courses'):location.hash='login';return;}void enroll(row,button);};card.append(button);}
    }
    return card;
  }
  function render(key) {
    if(!state[key].loaded)return;
    const query=textKey(byId(`${key}Search`).value),city=byId(`${key}City`).value,kind=byId(`${key}Kind`)?.value;
    const rows=state[key].rows.filter(row=>(!city||normalize(row.city)===city)&&(!kind||row.kind===kind)&&(!query||textKey([row.name,row.title,row.specialty,row.city,row.organization_name,row.provider_name,row.description,row.bio,row.kind&&kinds[row.kind]].filter(Boolean).join(' ')).includes(query)));
    const container=byId(`${key}Results`);container.replaceChildren();rows.forEach(row=>container.append(publicCard(key,row)));
    if(!rows.length)container.append(empty(state[key].rows.length?'لا توجد نتائج تطابق البحث. جرّب مدينة أو كلمة أخرى.':'لا توجد بيانات منشورة متاحة حاليًا.'));
    byId(`${key}Status`).textContent=`النتائج: ${rows.length}${state[key].bounded?' · تعرض القائمة أول 200 سجل من كل نوع؛ قد توجد نتائج إضافية.':''}`;
  }
  function applicationForm(row) {
    const details=node('details');details.append(node('summary','التقديم للوظيفة'));
    const form=node('form',undefined,'catalog-action-form');const label=node('label','نبذة عن خبرتك (اختياري)');const note=node('textarea');note.maxLength=1000;note.rows=3;note.placeholder='اكتب ما يتعلق بالوظيفة فقط.';label.append(note);
    const button=node('button','إرسال التقديم','secondary');button.type='submit';form.append(label,button);details.append(form);
    form.onsubmit=event=>{event.preventDefault();void submitApplication(row,normalize(note.value),button);};return details;
  }
  async function findOwned(table,foreignKey,rowId,ownerColumn,userId,columns) {
    const {data,error}=await app.client.from(table).select(columns).eq(foreignKey,rowId).eq(ownerColumn,userId).maybeSingle();if(error)throw error;return data;
  }
  async function privateAction(key,rowId,button,operation) {
    const userId=app.currentUser?.id,version=app.userVersion;if(!userId||!app.authReady||!app.client)return;
    const lock=`${key}:${userId}:${rowId}`;if(inFlight.has(lock))return;inFlight.add(lock);
    const original=button.textContent;button.disabled=true;button.textContent='جارٍ الإرسال…';button.setAttribute('aria-busy','true');
    try {await operation(userId,version);}catch(error){if(current(userId,version))app.showToast('تعذّر تأكيد العملية. حدّث طلباتك قبل المحاولة مجددًا.');}
    finally {inFlight.delete(lock);if(current(userId,version)){button.disabled=false;button.textContent=original;button.removeAttribute('aria-busy');}}
  }
  async function submitApplication(row,note,button) {
    if(note.length>1000){app.showToast('النبذة يجب ألا تتجاوز 1000 حرف.');return;}
    await privateAction('job',row.id,button,async(userId,version)=>{
      const columns='id,job_id,status,created_at';let saved=await findOwned('job_applications','job_id',row.id,'applicant_id',userId,columns);if(!current(userId,version))return;
      if(!saved) {
        const {data:job,error:jobError}=await app.client.from('jobs').select('id,status,expires_at').eq('id',row.id).eq('status','active').maybeSingle();
        if(!current(userId,version))return;if(jobError||!job||job.expires_at&&(!Number.isFinite(Date.parse(job.expires_at))||Date.parse(job.expires_at)<=Date.now())){app.showToast('هذه الوظيفة لم تعد مفتوحة للتقديم.');return;}
        try {const {data,error}=await app.client.from('job_applications').insert({job_id:row.id,applicant_id:userId,cover_note:note||null,status:'submitted'}).select(columns).single();if(error)throw error;saved=data;}
        catch {if(!current(userId,version))return;saved=await findOwned('job_applications','job_id',row.id,'applicant_id',userId,columns);}
      }
      if(!current(userId,version))return;if(!saved)throw new Error('Unconfirmed');app.showToast('تقديمك محفوظ. يمكنك متابعة حالته في تقديماتي.');await loadMine('jobs');
    });
  }
  async function enroll(row,button) {
    await privateAction('course',row.id,button,async(userId,version)=>{
      const columns='id,course_id,status,payment_status,enrolled_at';let saved=await findOwned('course_enrollments','course_id',row.id,'user_id',userId,columns);if(!current(userId,version))return;
      if(!saved) {
        const {data:course,error:courseError}=await app.client.from('courses').select('id,status,review_status,is_free,end_date,seats').eq('id',row.id).eq('status','active').eq('review_status','approved').maybeSingle();
        if(!current(userId,version))return;
        if(courseError||!course||course.is_free!==true||course.end_date&&course.end_date<todayString()||course.seats!==null&&course.seats!==undefined&&(!Number.isInteger(course.seats)||course.seats<=0)){app.showToast('هذه الدورة غير متاحة للالتحاق المجاني حاليًا.');return;}
        try {const {data,error}=await app.client.from('course_enrollments').insert({course_id:row.id,user_id:userId,status:'pending',payment_status:'free'}).select(columns).single();if(error)throw error;saved=data;}
        catch {if(!current(userId,version))return;saved=await findOwned('course_enrollments','course_id',row.id,'user_id',userId,columns);}
      }
      if(!current(userId,version))return;if(!saved)throw new Error('Unconfirmed');app.showToast(`طلب التحاقك محفوظ. الحالة: ${statusNames[saved.status]||'قيد المراجعة'}.`);await loadMine('courses');
    });
  }
  async function withdraw(record,button) {
    await privateAction('withdraw',record.id,button,async(userId,version)=>{
      const {data,error}=await app.client.from('job_applications').update({status:'withdrawn'}).eq('id',record.id).eq('applicant_id',userId).in('status',['submitted','reviewing','shortlisted']).select('id,job_id,status,created_at').maybeSingle();
      if(!current(userId,version))return;if(error||!data||data.status!=='withdrawn')throw error||new Error('Unconfirmed');app.showToast('تم سحب التقديم.');await loadMine('jobs');
    });
  }
  async function loadMine(key) {
    const container=byId(`${key}Mine`);if(!container)return;
    const userId=app.currentUser?.id,userVersion=app.userVersion,version=privateVersion,request=++mineVersion[key];
    if(!userId){container.hidden=true;container.replaceChildren();return;}container.hidden=false;container.replaceChildren(node('h2',key==='jobs'?'تقديماتي للوظائف':'طلبات التحاقي'),empty('جارٍ تحميل طلباتك…'));
    try {
      const table=key==='jobs'?'job_applications':'course_enrollments',owner=key==='jobs'?'applicant_id':'user_id';
      const columns=key==='jobs'?'id,job_id,status,created_at':'id,course_id,status,payment_status,enrolled_at';
      const {data,error}=await app.client.from(table).select(columns).eq(owner,userId).order(key==='jobs'?'created_at':'enrolled_at',{ascending:false}).limit(100);
      if(version!==privateVersion||request!==mineVersion[key]||!current(userId,userVersion))return;if(error)throw error;
      if(key==='jobs')applications=data||[];else enrollments=data||[];
      const records=key==='jobs'?applications:enrollments;container.replaceChildren(node('h2',key==='jobs'?'تقديماتي للوظائف':'طلبات التحاقي'));
      if(!records.length)container.append(empty('لا توجد طلبات في حسابك بعد.'));
      records.forEach(record=>{const row=state[key].rows.find(item=>item.id===record[key==='jobs'?'job_id':'course_id']);const card=node('article',undefined,'card booking-card');const content=node('div');content.append(node('h3',row?.title||(key==='jobs'?'تقديم لوظيفة':'طلب التحاق بدورة')),node('p',statusNames[record.status]||'حالة غير معروفة','muted'));card.append(content);
        if(key==='jobs'&&['submitted','reviewing','shortlisted'].includes(record.status)){const button=node('button','سحب التقديم','secondary');button.type='button';button.onclick=()=>void withdraw(record,button);card.append(button);}container.append(card);});
      if(records.length===100)container.append(node('p','تظهر أحدث 100 طلب.','muted'));render(key);
    } catch(error){if(version!==privateVersion||request!==mineVersion[key]||!current(userId,userVersion))return;retryState(container,'تعذّر تحميل طلباتك الخاصة.',()=>void loadMine(key));}
  }
  Object.keys(definitions).forEach(key=>{createScreen(key);app.registerRoute(key,{requiresAuth:false,onEnter:()=>void load(key)});});
  app.onUserChange(()=>{privateVersion++;applications=[];enrollments=[];Object.keys(state).forEach(key=>{state[key].version++;if(state[key].loaded)render(key);});['jobs','courses'].forEach(key=>{const container=byId(`${key}Mine`);if(container){container.replaceChildren();container.hidden=true;}if(location.hash.replace(/^#/,'')===key&&app.authReady)void load(key);});});
})();
