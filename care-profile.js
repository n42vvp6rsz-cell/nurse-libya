'use strict';
(() => {
  const app=window.NurseApp;if(!app) return;
  const cities=['طرابلس','بنغازي','مصراتة','الخمس','سبها','غريان','طبرق','البيضاء','درنة','زليتن','الزاوية','صبراتة','نالوت'];
  const types={
    doctor:{table:'doctors',owner:'profile_id',label:'ملف الطبيب',fields:['name','specialty','city','bio','years_experience']},
    nurse:{table:'nurses',owner:'profile_id',label:'ملف التمريض',fields:['name','specialty','city','bio','years_experience','available_for_home_visits'],singleton:true},
    hospital:{table:'hospitals',owner:'owner_profile_id',label:'ملف المستشفى',fields:['name','city','address','description']},
    laboratory:{table:'laboratories',owner:'owner_profile_id',label:'ملف المختبر',fields:['name','city','address','description']},
    pharmacy:{table:'pharmacies',owner:'owner_profile_id',label:'ملف الصيدلية',fields:['name','city','address','description']}
  };
  const state={mounted:false,generation:0,loadVersion:0,role:null,type:null,rows:[],editing:null,attempt:null,working:null,form:null,contractReady:false};
  const el=(tag,text,className)=>{const node=document.createElement(tag);if(text !== undefined) node.textContent=text;if(className) node.className=className;return node;};
  const byId=id=>document.getElementById(id);
  const columns=type=>['id',type.owner,...type.fields,'verified','created_at'].join(',');
  const context=()=>({id:app.currentUser?.id,version:app.userVersion,generation:state.generation});
  const current=c=>!!c.id && app.currentUser?.id===c.id && app.userVersion===c.version && state.generation===c.generation;
  function clean(raw,max,required=false,multiline=false) {
    const value=String(raw || '').normalize('NFC').trim();
    if((required && !value) || value.length>max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value) || (!multiline && /[\r\n\t]/u.test(value))) throw new Error('validation');
    return value || null;
  }
  function readPayload(type,form) {
    const get=name=>form.querySelector(`[name="${name}"]`)?.value || '';
    const city=clean(get('city'),60);if(city && !cities.includes(city)) throw new Error('validation');
    const data={name:clean(get('name'),120,true),city};
    if(type.fields.includes('specialty')) data.specialty=clean(get('specialty'),120,type===types.doctor);
    if(type.fields.includes('bio')) data.bio=clean(get('bio'),2000,false,true);
    if(type.fields.includes('address')) data.address=clean(get('address'),300);
    if(type.fields.includes('description')) data.description=clean(get('description'),2000,false,true);
    if(type.fields.includes('years_experience')) {
      const text=get('years_experience').trim(),years=text ? Number(text) : 0;
      if(!Number.isInteger(years) || years<0 || years>60) throw new Error('validation');
      data.years_experience=years;
    }
    if(type.fields.includes('available_for_home_visits')) {
      const choice=get('available_for_home_visits');if(!['true','false'].includes(choice)) throw new Error('validation');
      data.available_for_home_visits=choice==='true';
    }
    return data;
  }
  function field(form,name,label,options={}) {
    const holder=el('label',label),input=el(options.choices ? 'select' : options.multiline ? 'textarea' : 'input');input.name=name;
    if(options.choices) options.choices.forEach(([value,label])=>{const option=el('option',label);option.value=value;input.append(option);});
    else if(options.multiline) {input.rows=4;input.maxLength=options.max || 2000;}
    else {input.type=options.type || 'text';input.maxLength=options.max || 120;}
    if(options.required) input.required=true;
    if(options.type==='number') {input.min='0';input.max='60';input.step='1';input.dir='ltr';}
    holder.append(input);form.append(holder);return input;
  }
  function mount() {
    if(state.mounted) return true;
    const section=byId('care-profile');if(!section) return false;
    const head=el('div',undefined,'section-head'),title=el('div');title.append(el('span','بيانات مقدم الخدمة','eyebrow'),el('h1','ملفي في دليل الرعاية'));
    const refresh=el('button','تحديث','secondary');refresh.type='button';refresh.id='refreshCareProfile';refresh.onclick=()=>void load();head.append(title,refresh);
    const status=el('p','');status.id='careProfileState';status.setAttribute('role','status');
    const panel=el('div',undefined,'card authoring-card');panel.id='careProfilePanel';panel.hidden=true;
    const list=el('div');list.id='ownCareProfiles';list.className='grid';list.setAttribute('aria-live','polite');
    section.replaceChildren(head,status,panel,el('h2','ملفاتي'),list);state.mounted=true;return true;
  }
  function buildForm(type) {
    const panel=byId('careProfilePanel');panel.replaceChildren();
    const heading=el('h2',type.label);heading.id='careProfileFormTitle';const form=el('form');form.id='careProfileForm';form.className='authoring-form';
    field(form,'name',type.fields.includes('bio') ? 'الاسم الكامل' : 'اسم المؤسسة',{required:true});
    if(type.fields.includes('specialty')) field(form,'specialty','التخصص',{required:type===types.doctor});
    field(form,'city','المدينة (اختياري)',{choices:[['','بدون تحديد'],...cities.map(city=>[city,city])]});
    if(type.fields.includes('address')) field(form,'address','العنوان (اختياري)',{max:300});
    if(type.fields.includes('bio')) field(form,'bio','نبذة مهنية (اختياري)',{multiline:true});
    if(type.fields.includes('description')) field(form,'description','وصف المؤسسة (اختياري)',{multiline:true});
    if(type.fields.includes('years_experience')) field(form,'years_experience','سنوات الخبرة (من 0 إلى 60)',{type:'number'});
    if(type.fields.includes('available_for_home_visits')) field(form,'available_for_home_visits','الزيارات المنزلية',{choices:[['false','غير متاحة'],['true','متاحة بعد تنسيق الطلب']]});
    const notice=el('p','');notice.id='careProfileNotice';notice.setAttribute('role','status');
    const actions=el('div',undefined,'form-actions'),submit=el('button','إرسال الملف للمراجعة'),cancel=el('button','إلغاء التعديل','secondary');submit.type='submit';submit.id='saveCareProfile';cancel.type='button';cancel.id='cancelCareProfile';cancel.hidden=true;cancel.onclick=()=>reset();actions.append(submit,cancel);
    form.append(el('p','تظهر البيانات في الدليل بعد مراجعتها. يؤدي تعديل المحتوى المنشور إلى إعادة المراجعة. أدخل معلومات مهنية دقيقة فقط.','muted'),notice,actions);
    form.onsubmit=event=>{event.preventDefault();void save();};panel.append(heading,form);state.form=form;reset();
  }
  function reset() {
    if(!state.form || state.working || state.attempt) return;
    state.editing=null;state.form.querySelectorAll('input,textarea').forEach(input=>{input.value='';});state.form.querySelectorAll('select').forEach(input=>{input.value=input.querySelector('option')?.value || '';});
    byId('careProfileNotice').textContent='';byId('saveCareProfile').textContent='إرسال الملف للمراجعة';byId('cancelCareProfile').hidden=true;byId('careProfileFormTitle').textContent=state.type?.label || 'ملف مقدم الخدمة';
    if(state.type?.singleton && state.rows.length) byId('careProfilePanel').hidden=true;
  }
  function lock(busy) {
    if(!state.form) return;
    state.form.querySelectorAll('input,select,textarea').forEach(input=>{input.disabled=busy || !!state.attempt || !state.contractReady;});state.form.querySelectorAll('button').forEach(button=>{button.disabled=busy || !state.contractReady;});
    const cancel=byId('cancelCareProfile');if(cancel) cancel.disabled=busy || !!state.attempt || !state.contractReady;
    const button=byId('saveCareProfile');if(button) button.textContent=busy ? 'يرجى الانتظار…' : state.attempt ? 'التحقق وإعادة المحاولة' : state.editing ? 'حفظ التعديل وإعادة المراجعة' : 'إرسال الملف للمراجعة';
    if(busy) state.form.setAttribute('aria-busy','true');else state.form.removeAttribute('aria-busy');
  }
  function clear() {
    state.generation++;state.loadVersion++;state.role=null;state.type=null;state.rows=[];state.editing=null;state.attempt=null;state.working=null;state.contractReady=false;
    if(!state.mounted) return;
    if(state.form) {lock(false);reset();}byId('careProfilePanel').hidden=true;byId('ownCareProfiles').replaceChildren();byId('careProfileState').textContent='';
  }
  async function trustedRole(c) {
    const {data,error}=await app.client.from('profiles').select('id,role').eq('id',c.id).single();
    if(!current(c)) return null;
    if(error || !data || data.id!==c.id) throw error || new Error('profile missing');return data.role;
  }
  async function contractReady(c) {
    try {const {data,error}=await app.client.rpc('nurse_app_contract_version');return current(c) && !error && data===1;} catch {return false;}
  }
  function edit(row) {
    if(state.working || state.attempt) {app.showToast('تحقّق من نتيجة الحفظ السابق قبل تعديل ملف آخر.');return;}
    if(!state.type || row[state.type.owner]!==app.currentUser?.id) return;
    reset();state.editing=row.id;byId('careProfilePanel').hidden=false;
    state.form.querySelectorAll('[name]').forEach(input=>{input.value=typeof row[input.name]==='boolean' ? String(row[input.name]) : row[input.name] ?? '';});
    byId('careProfileFormTitle').textContent=`تعديل ${state.type.label}`;byId('careProfileNotice').textContent=row.verified ? 'سيحتاج المحتوى المعدّل إلى مراجعة قبل ظهوره مجددًا في الدليل.' : '';
    byId('cancelCareProfile').hidden=false;lock(false);state.form.scrollIntoView?.({block:'start',behavior:'smooth'});
  }
  function render() {
    const list=byId('ownCareProfiles');list.replaceChildren();
    if(!state.rows.length) {list.append(el('p','لم تضف ملفًا لهذا النوع من الحساب بعد.','empty'));return;}
    state.rows.forEach(row=>{if(row[state.type.owner]!==app.currentUser?.id) return;const card=el('article',undefined,'card opportunity-card');card.append(el('h3',row.name),el('span',row.verified ? 'مراجَع ومنشور في الدليل' : 'بانتظار مراجعة الملف','status'));if(row.specialty) card.append(el('p',row.specialty));if(row.city) card.append(el('p',row.city,'muted'));const button=el('button','تعديل الملف','secondary');button.type='button';button.onclick=()=>edit(row);card.append(button);list.append(card);});
    if(state.rows.length===25) list.append(el('p','يتم عرض أحدث 25 ملفًا.','muted'));
  }
  async function load() {
    if(!mount() || !app.currentUser || !app.client || !app.authReady) return;
    const c=context(),version=++state.loadVersion,status=byId('careProfileState');status.textContent='جارٍ تحميل ملف مقدم الخدمة…';byId('careProfilePanel').hidden=true;
    try {
      const role=await trustedRole(c);if(!current(c) || version!==state.loadVersion) return;
      const type=types[role];
      if(!type) {state.role=role;state.type=null;state.rows=[];byId('ownCareProfiles').replaceChildren();status.textContent='إضافة ملف الرعاية متاحة للطبيب والتمريض والمستشفى والمختبر والصيدلية بعد اعتماد نوع الحساب. ';const link=el('a','تقديم طلب الاعتماد');link.href='#workspace';status.append(link);return;}
      const [result,ready]=await Promise.all([app.client.from(type.table).select(columns(type)).eq(type.owner,c.id).order('created_at',{ascending:false}).limit(25),contractReady(c)]);
      const {data,error}=result;
      if(!current(c) || version!==state.loadVersion) return;if(error) throw error;
      if(state.type!==type) {state.type=type;state.role=role;state.editing=null;state.attempt=null;state.rows=[];buildForm(type);}
      state.role=role;state.type=type;state.contractReady=ready;state.rows=(data || []).filter(row=>row[type.owner]===c.id);render();lock(!!state.working);
      byId('careProfilePanel').hidden=type.singleton && state.rows.length>0 && !state.editing && !state.attempt;
      status.textContent=ready ? 'هذه القائمة تعرض ملفات حسابك فقط. اختر تعديل الملف لتحديث بياناته.' : 'يتطلب حفظ الملف تفعيل إصلاحات قاعدة البيانات. يمكنك عرض ملفاتك الحالية.';
    } catch {if(current(c) && version===state.loadVersion) status.textContent='تعذّر تحميل ملفاتك أو التحقق من نوع الحساب. اضغط تحديث للمحاولة مجددًا.';}
  }
  async function save() {
    if(state.working) return;
    if(!app.currentUser || !app.client || !app.authReady) {app.requireLogin('care-profile');return;}
    if(!state.type || !state.form) return;
    let content;try {content=state.attempt?.content || readPayload(state.type,state.form);} catch {byId('careProfileNotice').textContent='تحقّق من الاسم والتخصص والمدينة وسنوات الخبرة وطول البيانات قبل الحفظ.';return;}
    const c=context(),type=state.type,token={};state.working=token;lock(true);
    try {
      const ready=await contractReady(c);if(!current(c)) return;
      state.contractReady=ready;
      if(!ready) {byId('careProfileNotice').textContent='يتطلب حفظ الملف تفعيل إصلاحات قاعدة البيانات.';return;}
      const role=await trustedRole(c);if(!current(c)) return;
      if(types[role]!==type) {app.showToast('تغيّر نوع حسابك. حدّث الصفحة للتحقق من صلاحية التعديل.');return;}
      let attempt=state.attempt;
      if(!attempt) {const id=state.editing || window.crypto?.randomUUID?.();if(!id) throw new Error('secure UUID unavailable');attempt={id,owner:c.id,type,editing:!!state.editing,content};state.attempt=attempt;}
      if(attempt.owner!==c.id || attempt.type!==type) return;
      let saved;
      if(!attempt.editing) {const found=await app.client.from(type.table).select(columns(type)).eq('id',attempt.id).eq(type.owner,c.id).maybeSingle();if(!current(c)) return;if(found.error) throw found.error;saved=found.data;}
      if(!saved) {const query=attempt.editing ? app.client.from(type.table).update(attempt.content).eq('id',attempt.id).eq(type.owner,c.id) : app.client.from(type.table).insert({...attempt.content,id:attempt.id,[type.owner]:c.id});const result=await query.select(columns(type)).single();if(!current(c)) return;if(result.error) throw result.error;saved=result.data;}
      if(!saved || saved.id!==attempt.id || saved[type.owner]!==c.id) throw new Error('unconfirmed write');
      state.attempt=null;state.working=null;lock(false);reset();app.showToast('تم حفظ بيانات الملف. يمكنك متابعة نتيجة مراجعته من هذه الصفحة.');void load();
    } catch(error) {
      if(!current(c)) return;
      if(error?.code && !['23505','PGRST116'].includes(error.code)) {state.attempt=null;byId('careProfileNotice').textContent='تعذّر حفظ الملف. تحقّق من صلاحية حسابك والحقول ثم حاول مجددًا.';}
      else byId('careProfileNotice').textContent='لم يتأكد الحفظ. اضغط التحقق وإعادة المحاولة؛ احتفظنا بالطلب نفسه لتجنّب إنشاء ملف مكرر.';
    } finally {if(state.working===token) {state.working=null;lock(false);}}
  }
  app.registerRoute('care-profile',{requiresAuth:true,onEnter:load});app.onReady(()=>{mount();if(location.hash==='#care-profile') void load();});app.onUserChange(clear);
})();
