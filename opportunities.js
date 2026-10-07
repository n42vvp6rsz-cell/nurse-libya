'use strict';
(() => {
  const app = window.NurseApp;
  if (!app) return;
  const cities = ['طرابلس','بنغازي','مصراتة','الخمس','سبها','غريان','طبرق','البيضاء','درنة','زليتن','الزاوية','صبراتة','نالوت'];
  const jobRoles = new Set(['doctor','nurse','hospital','clinic','laboratory','pharmacy','ambulance','instructor','admin']);
  const courseRoles = new Set([...jobRoles].filter(role => role !== 'ambulance'));
  const columns = {
    job: 'id,publisher_id,title,organization_name,description,city,employment_type,requirements,contact_email,contact_phone,expires_at,status,created_at',
    course: 'id,publisher_id,title,provider_name,description,city,start_date,end_date,price,seats,contact_phone,registration_url,category,level,duration_minutes,learning_outcomes,is_free,status,review_status,review_note,updated_at,created_at'
  };
  const state = {mounted:false,loadVersion:0,role:null,editing:{job:null,course:null},attempt:{job:null,course:null},busy:new Map(),forms:{},lists:{}};
  const table = kind => kind === 'job' ? 'jobs' : 'courses';
  const owner = () => ({id:app.currentUser?.id,version:app.userVersion});
  const current = identity => !!identity.id && app.currentUser?.id === identity.id && app.userVersion === identity.version;
  const node = (tag, text, className) => { const el=document.createElement(tag); if(text !== undefined) el.textContent=text; if(className) el.className=className; return el; };
  const value = (form,name) => form.querySelector(`[name="${name}"]`)?.value || '';
  function clean(raw,max,required=false,multiline=false) {
    const text=String(raw || '').normalize('NFC').trim();
    if ((required && !text) || text.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(text) || (!multiline && /[\r\n\t]/u.test(text))) throw new Error('validation');
    return text || null;
  }
  function phone(raw) {
    const text=clean(raw,40);
    if (!text) return null;
    const normalized=text.replace(/[٠-٩]/g,c=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(c))).replace(/[۰-۹]/g,c=>String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c))).replace(/[\s()-]/g,'');
    if (!/^\+?\d{7,15}$/.test(normalized)) throw new Error('validation');
    return normalized;
  }
  function date(raw) {
    if (!raw) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || raw.slice(0,4) < '1000') throw new Error('validation');
    const parsed=new Date(`${raw}T00:00:00Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0,10) !== raw) throw new Error('validation');
    return raw;
  }
  function today() {
    const parts=new Intl.DateTimeFormat('en',{timeZone:'Africa/Tripoli',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
    return ['year','month','day'].map(type=>parts.find(part=>part.type===type).value).join('-');
  }
  function url(raw) {
    const text=clean(raw,1000);
    if (!text) return null;
    const parsed=new URL(text);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('validation');
    return parsed.href;
  }
  function number(raw,integer=false) {
    if (!String(raw).trim()) return null;
    const result=Number(raw);
    if (!Number.isFinite(result) || result < 0 || result > 1000000 || (integer && (!Number.isInteger(result) || result === 0))) throw new Error('validation');
    return result;
  }
  function payload(kind,form) {
    const city=clean(value(form,'city'),50);
    if (city && !cities.includes(city)) throw new Error('validation');
    const data={title:clean(value(form,'title'),150,true),description:clean(value(form,'description'),5000,true,true),city,contact_phone:phone(value(form,'contact_phone'))};
    if (kind === 'job') {
      const email=clean(value(form,'contact_email'),254),expiry=date(value(form,'expires_at'));
      if ((email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) || (expiry && expiry < today())) throw new Error('validation');
      Object.assign(data,{organization_name:clean(value(form,'organization_name'),120,true),employment_type:clean(value(form,'employment_type'),80),requirements:clean(value(form,'requirements'),2000,false,true),contact_email:email,expires_at:expiry ? `${expiry}T23:59:59+02:00` : null,status:'active'});
    } else {
      const start=date(value(form,'start_date')),end=date(value(form,'end_date'));
      if ((end && (!start || end < start)) || (!state.editing.course && start && start < today())) throw new Error('validation');
      const free=value(form,'is_free') === 'true',price=number(value(form,'price'));
      if (!free && price === null) throw new Error('validation');
      const outcomes=(clean(value(form,'learning_outcomes'),2000,false,true) || '').split(/\r?\n/).map(item=>item.trim()).filter(Boolean);
      if (outcomes.length > 20 || outcomes.some(item=>item.length > 200)) throw new Error('validation');
      Object.assign(data,{provider_name:clean(value(form,'provider_name'),120,true),start_date:start,end_date:end,registration_url:url(value(form,'registration_url')),category:clean(value(form,'category'),100),level:clean(value(form,'level'),100),duration_minutes:number(value(form,'duration_minutes'),true),seats:number(value(form,'seats'),true),learning_outcomes:outcomes,is_free:free,price:free ? 0 : price,status:'closed',review_status:'pending'});
    }
    return data;
  }
  function field(form,name,label,options={}) {
    const wrapper=node('label',label),input=node(options.multiline ? 'textarea' : options.choices ? 'select' : 'input');
    input.name=name;
    if (options.choices) options.choices.forEach(([val,text])=>{const option=node('option',text);option.value=val;input.append(option);});
    else {if(options.multiline) input.rows=options.rows || 3;else input.type=options.type || 'text';}
    if (options.required) input.required=true;
    if(options.max) input.maxLength=options.max;
    if(options.type === 'number') {input.min='0';input.step=options.integer ? '1' : '0.01';}
    if (['tel','email','url','date','number'].includes(options.type)) input.dir='ltr';
    wrapper.append(input);form.append(wrapper);return input;
  }
  function buildForm(kind) {
    const card=node('div',undefined,'card authoring-card'),heading=node('h2',kind === 'job' ? 'إعلان وظيفة' : 'دورة للتقييم والنشر');
    const form=node('form');form.id=kind === 'job' ? 'publishJobForm' : 'publishCourseForm';form.className='authoring-form';
    field(form,'title','العنوان',{required:true,max:150});
    field(form,kind === 'job' ? 'organization_name' : 'provider_name',kind === 'job' ? 'اسم الجهة' : 'اسم الجهة المقدمة',{required:true,max:120});
    field(form,'city','المدينة (اختياري)',{choices:[['','بدون تحديد'],...cities.map(city=>[city,city])]});
    field(form,'description','الوصف',{required:true,max:5000,multiline:true,rows:5});
    if(kind === 'job') {
      field(form,'employment_type','نوع العمل (اختياري)',{choices:[['','بدون تحديد'],['دوام كامل','دوام كامل'],['دوام جزئي','دوام جزئي'],['مناوبات','مناوبات'],['عقد مؤقت','عقد مؤقت'],['تطوع','تطوع']]});
      field(form,'requirements','المتطلبات (اختياري)',{max:2000,multiline:true});
      field(form,'contact_email','بريد التواصل (اختياري)',{type:'email',max:254});
      field(form,'expires_at','آخر يوم للإعلان (اختياري)',{type:'date'});
    } else {
      field(form,'category','المجال (اختياري)',{max:100});field(form,'level','المستوى (اختياري)',{max:100});
      field(form,'start_date','تاريخ البداية (اختياري)',{type:'date'});field(form,'end_date','تاريخ النهاية (اختياري)',{type:'date'});
      field(form,'duration_minutes','مدة الدورة بالدقائق (اختياري)',{type:'number',integer:true});field(form,'seats','عدد المقاعد (اختياري)',{type:'number',integer:true});
      field(form,'is_free','رسوم الدورة',{choices:[['true','مجانية'],['false','برسوم معلنة من الجهة']]});
      field(form,'price','الرسوم بالدينار الليبي',{type:'number'});field(form,'registration_url','رابط معلومات التسجيل (اختياري، HTTPS)',{type:'url',max:1000});
      field(form,'learning_outcomes','مخرجات التعلم (اختياري، كل نتيجة في سطر)',{max:2000,multiline:true});
    }
    field(form,'contact_phone','هاتف التواصل (اختياري)',{type:'tel',max:40});
    const note=node('p',kind === 'job' ? 'تظهر الوظيفة في الدليل بعد حفظها. تحقّق من بيانات الجهة ووسائل التواصل قبل النشر.' : 'تُحفظ الدورة مغلقة وقيد المراجعة. لا تمثل المراجعة اعتمادًا مهنيًا، ولا تتم معالجة الدفع عبر المنصة.', 'muted');
    const message=node('p','');message.id=kind === 'job' ? 'publishJobNotice' : 'publishCourseNotice';message.setAttribute('role','status');
    const buttons=node('div',undefined,'form-actions'),save=node('button',kind === 'job' ? 'نشر الوظيفة' : 'إرسال الدورة للمراجعة'),cancel=node('button','إلغاء التعديل','secondary');
    save.type='submit';cancel.type='button';cancel.hidden=true;cancel.onclick=()=>resetForm(kind);buttons.append(save,cancel);form.append(note,message,buttons);card.append(heading,form);
    state.forms[kind]={form,heading,message,save,cancel};
    form.onsubmit=event=>{event.preventDefault();void submit(kind);};
    return card;
  }
  function resetForm(kind) {
    if(state.busy.has(kind) || state.attempt[kind]) return;
    const ui=state.forms[kind];state.editing[kind]=null;
    ui.form.querySelectorAll('input,textarea').forEach(input=>{input.value='';});
    ui.form.querySelectorAll('select').forEach(select=>{select.value=select.querySelector('option')?.value || '';});
    ui.cancel.hidden=true;ui.message.textContent='';ui.save.textContent=kind === 'job' ? 'نشر الوظيفة' : 'إرسال الدورة للمراجعة';
    ui.heading.textContent=kind === 'job' ? 'إعلان وظيفة' : 'دورة للتقييم والنشر';
  }
  function mount() {
    if(state.mounted) return true;
    const section=document.getElementById('publish');if(!section) return false;
    const head=node('div',undefined,'section-head'),title=node('div');title.append(node('span','للجهات ومقدمي الخدمات','eyebrow'),node('h1','إدارة الوظائف والدورات'));
    const refresh=node('button','تحديث','secondary');refresh.type='button';refresh.id='refreshOpportunities';refresh.onclick=()=>void load();head.append(title,refresh);
    const status=node('p','');status.id='publishState';status.setAttribute('role','status');
    const forms=node('div',undefined,'authoring-grid');forms.id='publishForms';forms.append(buildForm('job'),buildForm('course'));
    const lists=node('div',undefined,'authoring-grid');['job','course'].forEach(kind=>{const wrapper=node('div');wrapper.append(node('h2',kind === 'job' ? 'وظائفي' : 'دوراتي'));const list=node('div');list.id=kind === 'job' ? 'ownJobsList' : 'ownCoursesList';list.setAttribute('aria-live','polite');state.lists[kind]=list;wrapper.append(list);lists.append(wrapper);});
    section.replaceChildren(head,status,forms,lists);state.mounted=true;resetForm('job');resetForm('course');return true;
  }
  function clear() {
    state.loadVersion++;state.role=null;state.editing={job:null,course:null};state.attempt={job:null,course:null};state.busy.clear();
    if(!state.mounted) return;
    ['job','course'].forEach(kind=>{state.forms[kind].form.querySelectorAll('input,select,textarea,button').forEach(input=>{input.disabled=false;});resetForm(kind);state.lists[kind].replaceChildren();});
    document.getElementById('publishState').textContent='';document.getElementById('publishForms').hidden=true;
  }
  async function trustedRole(identity) {
    const {data,error}=await app.client.from('profiles').select('role').eq('id',identity.id).single();
    if(!current(identity)) return null;
    if(error || !data?.role) throw error || new Error('profile missing');
    return data.role;
  }
  function edit(kind,row) {
    if(state.busy.has(kind) || state.attempt[kind]) {app.showToast('تحقّق من نتيجة الحفظ السابق قبل تعديل إعلان آخر.');return;}
    if(row.publisher_id !== app.currentUser?.id || !(kind === 'job' ? jobRoles : courseRoles).has(state.role)) return;
    resetForm(kind);state.editing[kind]=row.id;
    const ui=state.forms[kind];
    ui.form.querySelectorAll('[name]').forEach(input=>{let content=row[input.name];if(input.name === 'expires_at' && content) {const parts=new Intl.DateTimeFormat('en',{timeZone:'Africa/Tripoli',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(content));content=['year','month','day'].map(type=>parts.find(part=>part.type===type).value).join('-');}if(input.name === 'learning_outcomes') content=Array.isArray(content) ? content.filter(item=>typeof item==='string').join('\n') : '';if(input.name === 'is_free') content=String(!!row.is_free);input.value=content ?? '';});
    ui.heading.textContent=kind === 'job' ? 'تعديل الوظيفة' : 'تعديل الدورة وإعادة مراجعتها';ui.save.textContent=kind === 'job' ? 'حفظ ونشر التعديل' : 'حفظ وإرسال للمراجعة';ui.cancel.hidden=false;ui.message.textContent=kind === 'course' ? 'يُوقف النشر أثناء مراجعة التعديل.' : '';
    ui.form.scrollIntoView?.({block:'start',behavior:'smooth'});
  }
  function render(kind,rows) {
    const list=state.lists[kind];list.replaceChildren();
    if(!rows?.length) {list.append(node('p',kind === 'job' ? 'لم تنشر وظائف بعد.' : 'لم ترسل دورات بعد.','empty'));return;}
    rows.forEach(row=>{
      if(row.publisher_id !== app.currentUser?.id) return;
      const card=node('article',undefined,'card opportunity-card');card.append(node('h3',row.title),node('p',kind === 'job' ? row.organization_name : row.provider_name));
      const status=kind === 'job' ? (row.status === 'active' ? 'منشورة' : 'مغلقة') : ({draft:'مسودة',pending:'قيد المراجعة',approved:row.status === 'active' ? 'مراجَعة ومنشورة' : 'مراجَعة ومغلقة',rejected:'تحتاج تعديلًا'}[row.review_status] || 'غير محدد');
      card.append(node('span',status,'status'));if(row.city) card.append(node('p',row.city,'muted'));
      if(kind === 'course' && row.review_note) card.append(node('p',`ملاحظة المراجعة: ${row.review_note}`,'muted'));
      if(kind === 'job' && row.expires_at) {const expired=new Date(row.expires_at) < new Date();card.append(node('p',expired ? 'انتهت مدة الإعلان.' : `ينتهي الإعلان: ${new Intl.DateTimeFormat('ar-LY',{timeZone:'Africa/Tripoli'}).format(new Date(row.expires_at))}`,'muted'));}
      const actions=node('div',undefined,'form-actions');
      if((kind === 'job' ? jobRoles : courseRoles).has(state.role)) {
        const editButton=node('button','تعديل','secondary');editButton.type='button';editButton.onclick=()=>edit(kind,row);actions.append(editButton);
        if(row.status === 'active') {const close=node('button','إغلاق الإعلان','secondary');close.type='button';close.onclick=()=>void closeEntry(kind,row);actions.append(close);}
      }
      card.append(actions);list.append(card);
    });
    if(rows.length === 100) list.append(node('p','يتم عرض أحدث 100 إعلان.','muted'));
  }
  async function load() {
    if(!mount() || !app.currentUser || !app.client || !app.authReady) return;
    const identity=owner(),version=++state.loadVersion,status=document.getElementById('publishState');
    status.textContent='جارٍ تحميل إعلاناتك…';document.getElementById('publishForms').hidden=true;
    try {
      const role=await trustedRole(identity);if(!current(identity) || version !== state.loadVersion) return;
      state.role=role;
      const results=await Promise.all(['job','course'].map(kind=>app.client.from(table(kind)).select(columns[kind]).eq('publisher_id',identity.id).order('created_at',{ascending:false}).limit(100)));
      if(!current(identity) || version !== state.loadVersion) return;
      results.forEach((result,index)=>{const kind=index===0 ? 'job' : 'course';if(result.error) state.lists[kind].textContent='تعذّر تحميل إعلاناتك. اضغط تحديث للمحاولة مجددًا.';else render(kind,result.data || []);});
      document.getElementById('publishForms').hidden=!jobRoles.has(role);
      state.forms.course.form.parentElement.hidden=!courseRoles.has(role);
      status.textContent=jobRoles.has(role) ? 'هذه القائمة تعرض إعلانات حسابك فقط.' : 'النشر متاح لمقدمي الخدمات بعد مراجعة نوع الحساب. يمكنك تقديم طلب من صفحة التقديم كمقدم خدمة.';
      if(!jobRoles.has(role)) {const link=node('a','تقديم طلب مقدم خدمة');link.href='#workspace';status.append(document.createTextNode(' '),link);}
    } catch {if(current(identity) && version===state.loadVersion) status.textContent='تعذّر التحقق من صلاحية النشر. اضغط تحديث لإعادة المحاولة.';}
  }
  function lock(kind,active) {
    const ui=state.forms[kind];ui.form.querySelectorAll('input,select,textarea,button').forEach(input=>{input.disabled=active;});
    ui.form.setAttribute('aria-busy',String(active));
    if(!active && state.attempt[kind]) {
      ui.form.querySelectorAll('input,select,textarea').forEach(input=>{input.disabled=true;});ui.cancel.disabled=true;ui.save.textContent='التحقق وإعادة المحاولة';
    }
  }
  async function perform(kind,task) {
    if(state.busy.has(kind)) return;
    if(!app.currentUser || !app.client || !app.authReady) {app.requireLogin('publish');return;}
    const identity=owner(),token={};state.busy.set(kind,token);lock(kind,true);
    try {
      const role=await trustedRole(identity);if(!current(identity)) return;
      if(!(kind === 'job' ? jobRoles : courseRoles).has(role)) {app.showToast('نوع حسابك الحالي لا يملك صلاحية النشر.');return;}
      await task(identity);
    } catch(error) {if(current(identity)) app.showToast(app.errorMessage(error));}
    finally {if(state.busy.get(kind)===token) {state.busy.delete(kind);lock(kind,false);}}
  }
  async function submit(kind) {
    if(state.busy.has(kind)) return;
    const ui=state.forms[kind];let content;
    try {content=state.attempt[kind]?.content || payload(kind,ui.form);} catch {ui.message.textContent='تحقّق من الحقول والأرقام والتواريخ وروابط HTTPS قبل الحفظ.';return;}
    await perform(kind,async identity=>{
      let attempt=state.attempt[kind];
      if(attempt && attempt.userId !== identity.id) return;
      if(!attempt) {
        const id=state.editing[kind] || window.crypto?.randomUUID?.();
        if(!id) {ui.message.textContent='تعذّر تجهيز طلب الحفظ. استخدم متصفحًا حديثًا واتصال HTTPS.';return;}
        attempt={id,userId:identity.id,editing:!!state.editing[kind],content};state.attempt[kind]=attempt;
      }
      try {
        let row;
        if(!attempt.editing) {
          const found=await app.client.from(table(kind)).select(columns[kind]).eq('id',attempt.id).eq('publisher_id',identity.id).maybeSingle();
          if(!current(identity)) return;
          if(found.error) throw found.error;
          row=found.data;
        }
        if(!row) {
          const query=attempt.editing ? app.client.from(table(kind)).update(attempt.content).eq('id',attempt.id).eq('publisher_id',identity.id) : app.client.from(table(kind)).insert({...attempt.content,id:attempt.id,publisher_id:identity.id});
          const result=await query.select(columns[kind]).single();
          if(!current(identity)) return;
          if(result.error) throw result.error;
          row=result.data;
        }
        if(!row || row.id !== attempt.id || row.publisher_id !== identity.id) throw new Error('unconfirmed write');
        state.attempt[kind]=null;state.busy.delete(kind);lock(kind,false);resetForm(kind);
        app.showToast(kind === 'job' ? 'تم حفظ الوظيفة. تظهر الإعلانات النشطة غير المنتهية في الدليل.' : 'تم حفظ الدورة قيد المراجعة وهي مغلقة للنشر.');void load();
      } catch(error) {
        if(!current(identity)) return;
        // A network failure can happen after commit. Reuse the same ID and frozen payload on retry.
        if(error?.code && !['23505','PGRST116'].includes(error.code)) {state.attempt[kind]=null;ui.message.textContent='تعذّر حفظ الإعلان. تحقّق من صلاحيات حسابك والحقول ثم حاول مجددًا.';}
        else ui.message.textContent='لم يتأكد الحفظ. اضغط التحقق وإعادة المحاولة؛ سيُستخدم الطلب نفسه لتجنّب إنشاء إعلان مكرر.';
      }
    });
  }
  async function closeEntry(kind,row) {
    if(state.attempt[kind]) {app.showToast('تحقّق من نتيجة الحفظ السابق قبل إغلاق إعلان.');return;}
    await perform(kind,async identity=>{
      if(row.publisher_id !== identity.id) return;
      const {data,error}=await app.client.from(table(kind)).update({status:'closed'}).eq('id',row.id).eq('publisher_id',identity.id).select('id,publisher_id,status').single();
      if(!current(identity)) return;
      if(error || !data || data.id !== row.id || data.publisher_id !== identity.id || data.status !== 'closed') {app.showToast('لم يتأكد إغلاق الإعلان. حدّث القائمة قبل المحاولة مجددًا.');return;}
      app.showToast('تم إغلاق الإعلان.');void load();
    });
  }
  app.registerRoute('publish',{requiresAuth:true,onEnter:load});
  app.onReady(()=>{mount();if(location.hash === '#publish') void load();});
  app.onUserChange(clear);
})();
