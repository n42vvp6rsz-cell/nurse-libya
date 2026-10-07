'use strict';
(() => {
  const app=window.NurseApp;if(!app)return;
  const byId=id=>document.getElementById(id);
  const node=(tag,text,className)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;return el;};
  const validId=value=>/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value||'');
  const columns='id,sender_id,receiver_id,body,is_read,created_at';
  const limit=200;
  const state={mounted:false,generation:0,inboxVersion:0,threadVersion:0,enterVersion:0,peer:null,rows:[],providers:new Map(),contract:false,threadLoaded:false,attempts:new Map(),locks:new Set()};
  const context=()=>({id:app.currentUser?.id,version:app.userVersion,generation:state.generation});
  const current=c=>!!c.id&&app.currentUser?.id===c.id&&app.userVersion===c.version&&c.generation===state.generation;
  const owned=(row,id)=>validId(row?.id)&&validId(row?.sender_id)&&validId(row?.receiver_id)&&row.sender_id!==row.receiver_id&&(row.sender_id===id||row.receiver_id===id)&&typeof row.body==='string';
  const other=(row,id)=>row.sender_id===id?row.receiver_id:row.sender_id;
  const peerLabel=id=>state.providers.get(id)?.label||'محادثة خاصة · '+id.slice(0,8);
  function time(value){const date=new Date(value);return Number.isFinite(date.getTime())?new Intl.DateTimeFormat('ar-LY',{timeZone:'Africa/Tripoli',dateStyle:'short',timeStyle:'short'}).format(date):'وقت غير متاح';}
  function empty(message){return node('p',message,'empty');}
  function retry(container,message,action){const button=node('button','إعادة المحاولة','secondary');button.type='button';button.onclick=()=>void action();container.replaceChildren(empty(message),button);}
  function formState(){
    const form=byId('messagesForm');if(!form)return;
    const pending=state.attempts.get(state.peer),locked=state.locks.has(state.peer);
    byId('messagesBody').disabled=!state.contract||!state.peer||!state.threadLoaded||!!pending||locked;
    byId('messagesSend').disabled=!state.contract||!state.peer||!state.threadLoaded||locked;
    byId('messagesSend').textContent=locked?'جارٍ التأكيد…':pending?'التحقق وإعادة المحاولة':'إرسال الرسالة';
    if(locked)form.setAttribute('aria-busy','true');else form.removeAttribute('aria-busy');
    byId('messagesNotice').textContent=pending?'لم يتأكد وصول الرسالة. نصها محفوظ هنا لهذه المحاولة؛ التحقق يستخدم المرجع نفسه لتجنّب التكرار.':!state.contract?'إرسال الرسائل وتعليمها كمقروءة ينتظران تفعيل حماية الرسائل في قاعدة البيانات. يمكنك قراءة محادثاتك المتاحة.':'';
    byId('messagesRecipient').disabled=state.providers.size===0;
    byId('messagesStart').disabled=state.providers.size===0;
    byId('messagesThreadTitle').textContent=state.peer?peerLabel(state.peer):'اختر محادثة';
    byId('messagesThread').querySelectorAll('.message-read').forEach(button=>{if(!button.hasAttribute('aria-busy'))button.disabled=!state.contract;});
  }
  function mount(){
    const screen=byId('messages');if(!screen||state.mounted)return;state.mounted=true;
    const heading=node('div',undefined,'section-head'),title=node('div');title.append(node('span','مساحتك الخاصة','eyebrow'),node('h1','الرسائل'));
    const refresh=node('button','تحديث','secondary');refresh.id='messagesRefresh';refresh.type='button';refresh.onclick=()=>void enter();heading.append(title,refresh);
    const status=node('p');status.id='messagesState';status.setAttribute('role','status');
    const notice=node('p',undefined,'notice');notice.id='messagesNotice';notice.setAttribute('role','status');
    const start=node('form',undefined,'catalog-filters');start.id='messagesStartForm';const label=node('label','بدء محادثة مع مقدم رعاية منشور');const select=node('select');select.id='messagesRecipient';select.append(Object.assign(node('option','اختر مقدم الرعاية'),{value:''}));label.append(select);
    const button=node('button','فتح المحادثة','secondary');button.id='messagesStart';button.type='submit';start.append(label,button);start.onsubmit=event=>{event.preventDefault();const id=select.value;if(state.providers.has(id))void choose(id);};
    const layout=node('div',undefined,'messages-layout'),inbox=node('aside',undefined,'messages-inbox card');inbox.setAttribute('aria-label','محادثاتي');inbox.id='messagesInbox';
    const panel=node('section',undefined,'messages-panel card'),threadTitle=node('h2','اختر محادثة');threadTitle.id='messagesThreadTitle';
    const thread=node('div',undefined,'messages-thread');thread.id='messagesThread';thread.setAttribute('aria-label','الرسائل في المحادثة');
    const form=node('form',undefined,'messages-form');form.id='messagesForm';const bodyLabel=node('label','نص الرسالة');const body=node('textarea');body.id='messagesBody';body.name='body';body.maxLength=5000;body.rows=4;body.required=true;body.placeholder='رسائل تنسيق الرعاية فقط؛ تجنّب مشاركة معلومات صحية حساسة.';bodyLabel.append(body);
    const send=node('button','إرسال الرسالة');send.id='messagesSend';send.type='submit';form.append(bodyLabel,send);form.onsubmit=event=>{event.preventDefault();void sendMessage();};panel.append(threadTitle,thread,form);layout.append(inbox,panel);
    screen.replaceChildren(heading,node('p','رسائل نصية داخل نيرس ليبيا بين طرفي المحادثة. حدّث الصفحة لعرض الردود الجديدة؛ هذه المساحة ليست للطوارئ.','muted'),start,status,notice,layout);formState();
  }
  function renderInbox(){
    const user=app.currentUser?.id,box=byId('messagesInbox');if(!box)return;box.replaceChildren(node('h2','محادثاتي'));
    const threads=new Map();state.rows.forEach(row=>{const id=other(row,user);if(!threads.has(id))threads.set(id,{row,count:0});if(row.receiver_id===user&&!row.is_read)threads.get(id).count++;});
    threads.forEach(({row,count},id)=>{const button=node('button',undefined,'message-preview secondary');button.type='button';button.setAttribute('aria-pressed',String(state.peer===id));button.append(node('strong',peerLabel(id)),node('span',row.body.slice(0,120)),node('small',time(row.created_at)+(count?' · غير المقروءة الظاهرة: '+count:'')));button.onclick=()=>void choose(id);box.append(button);});
    if(!threads.size)box.append(empty('لا توجد محادثات متاحة حاليًا.'));formState();
  }
  async function providers(c,version){
    const definitions=[['doctors','profile_id','طبيب'],['nurses','profile_id','تمريض'],['hospitals','owner_profile_id','مستشفى']];
    const results=await Promise.allSettled(definitions.map(async([table,owner,kind])=>{const {data,error}=await app.client.from(table).select(`id,${owner},name,city,verified`).eq('verified',true).order('name').limit(limit);if(error)throw error;return (data||[]).filter(row=>row.verified===true&&validId(row[owner])&&row[owner]!==c.id).map(row=>({id:row[owner],label:[row.name,kind,row.city].filter(Boolean).join(' · ')}));}));
    if(!current(c)||version!==state.enterVersion)return;
    if(results.some(result=>result.status==='rejected'))throw new Error('Provider directory unavailable');
    state.providers=new Map(results.flatMap(result=>result.value).map(row=>[row.id,row]));
    const select=byId('messagesRecipient');select.replaceChildren(Object.assign(node('option','اختر مقدم الرعاية'),{value:''}));state.providers.forEach((row,id)=>{const option=node('option',row.label);option.value=id;select.append(option);});
    formState();renderInbox();
  }
  async function inbox(c=context()){
    if(!current(c)||!app.client)return;const version=++state.inboxVersion;const box=byId('messagesInbox');box.replaceChildren(empty('جارٍ تحميل المحادثات…'));
    try{
      const {data,error}=await app.client.from('messages').select(columns).or(`sender_id.eq.${c.id},receiver_id.eq.${c.id}`).order('created_at',{ascending:false}).order('id',{ascending:false}).limit(limit);
      if(!current(c)||version!==state.inboxVersion)return;if(error)throw error;
      state.rows=(Array.isArray(data)?data:[]).filter(row=>owned(row,c.id));renderInbox();byId('messagesState').textContent='تعرض المحادثات من أحدث 200 رسالة متاحة لحسابك؛ قد توجد رسائل أقدم.';
    }catch{if(current(c)&&version===state.inboxVersion){state.rows=[];retry(box,'تعذّر تحميل المحادثات.',()=>inbox());byId('messagesState').textContent='تعذّر تحميل المحادثات.';}}
  }
  async function choose(id){
    if(!validId(id)||id===app.currentUser?.id)return;
    if(!state.providers.has(id)&&!state.rows.some(row=>other(row,app.currentUser?.id)===id))return;
    const changed=state.peer!==id;state.peer=id;state.threadLoaded=false;if(changed)byId('messagesBody').value=state.attempts.get(id)?.body||'';renderInbox();await thread();
  }
  async function thread(){
    const c=context(),peer=state.peer;if(!current(c)||!validId(peer)||!app.client)return;
    const version=++state.threadVersion;state.threadLoaded=false;formState();const box=byId('messagesThread');box.replaceChildren(empty('جارٍ تحميل الرسائل…'));
    try{
      const {data,error}=await app.client.from('messages').select(columns).or(`and(sender_id.eq.${c.id},receiver_id.eq.${peer}),and(sender_id.eq.${peer},receiver_id.eq.${c.id})`).order('created_at',{ascending:false}).order('id',{ascending:false}).limit(limit);
      if(!current(c)||version!==state.threadVersion||state.peer!==peer)return;if(error)throw error;
      const rows=(Array.isArray(data)?data:[]).filter(row=>owned(row,c.id)&&other(row,c.id)===peer).reverse();box.replaceChildren();
      rows.forEach(row=>{const card=node('article',undefined,'message-bubble'+(row.sender_id===c.id?' message-own':''));card.append(node('span',row.sender_id===c.id?'أنت':peerLabel(peer),'eyebrow'),node('p',row.body),node('small',time(row.created_at)+(row.sender_id===c.id?(row.is_read?' · مقروءة':' · أُرسلت'):(row.is_read?' · مقروءة':' · جديدة'))));
        if(row.receiver_id===c.id&&!row.is_read){const mark=node('button','تحديد كمقروءة','secondary message-read');mark.type='button';mark.disabled=!state.contract;mark.onclick=()=>void markRead(row,mark);card.append(mark);}box.append(card);});
      if(!rows.length)box.append(empty('لا توجد رسائل في هذه المحادثة بعد.'));state.threadLoaded=true;formState();
    }catch{if(current(c)&&version===state.threadVersion&&state.peer===peer){retry(box,'تعذّر تحميل الرسائل.',thread);formState();}}
  }
  async function enter(){
    mount();const c=context(),screen=byId('messages');if(!screen)return;
    if(!current(c)||!app.client||!app.authReady){screen.querySelector('#messagesState').textContent='سجّل الدخول لقراءة محادثاتك.';return;}
    const version=++state.enterVersion;state.contract=false;formState();
    const gate=async()=>{try{const {data,error}=await app.client.rpc('nurse_messages_contract_version');if(current(c)&&version===state.enterVersion){state.contract=!error&&data===1;formState();}}catch{if(current(c)&&version===state.enterVersion){state.contract=false;formState();}}};
    const directory=async()=>{try{await providers(c,version);}catch{if(current(c)&&version===state.enterVersion){state.providers.clear();byId('messagesRecipient').replaceChildren(Object.assign(node('option','تعذّر تحميل مقدمي الرعاية؛ اضغط تحديث'),{value:''}));formState();}}};
    await Promise.allSettled([gate(),directory(),inbox(c)]);
    if(!current(c)||version!==state.enterVersion)return;
    const requested=new URLSearchParams((location.hash||'').split('?')[1]||'').get('provider');
    if(validId(requested)&&state.providers.has(requested))await choose(requested);else if(state.peer)await thread();
  }
  function bodyValue(){const body=String(byId('messagesBody').value||'').normalize('NFC').trim();if(!body||body.length>5000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(body))throw new Error('validation');return body;}
  function resultRow(data){return Array.isArray(data)?data.length===1?data[0]:null:data;}
  async function sendMessage(){
    const c=context(),peer=state.peer;if(!current(c)||!app.client||!state.contract||!state.threadLoaded||!validId(peer)||state.locks.has(peer))return;
    let attempt=state.attempts.get(peer);if(!attempt){try{const id=crypto.randomUUID();if(!validId(id))throw new Error('UUID unavailable');attempt=Object.freeze({id,receiver_id:peer,sender_id:c.id,body:bodyValue()});state.attempts.set(peer,attempt);}catch{app.showToast('اكتب رسالة من 1 إلى 5000 حرف بلا رموز تحكم.');return;}}
    state.locks.add(peer);formState();
    try{
      const {data,error}=await app.client.rpc('send_private_message',{p_message_id:attempt.id,p_receiver_id:attempt.receiver_id,p_body:attempt.body});
      if(!current(c))return;if(error)throw error;const row=resultRow(data);
      if(!owned(row,c.id)||row.id!==attempt.id||row.sender_id!==c.id||row.receiver_id!==peer||row.body!==attempt.body)throw new Error('Unconfirmed message');
      state.attempts.delete(peer);if(state.peer===peer){byId('messagesBody').value='';app.showToast('تم إرسال الرسالة داخل نيرس ليبيا.');await thread();}await inbox(c);
    }catch{if(current(c)&&state.peer===peer)byId('messagesNotice').textContent='لم يتأكد وصول الرسالة. اضغط التحقق وإعادة المحاولة لاستخدام المرجع والنص نفسيهما.';}
    finally{if(current(c)){state.locks.delete(peer);formState();}}
  }
  async function markRead(row,button){
    const c=context();if(!current(c)||!state.contract||row.receiver_id!==c.id||button.disabled)return;
    button.disabled=true;button.setAttribute('aria-busy','true');
    try{const {data,error}=await app.client.rpc('mark_private_message_read',{p_message_id:row.id});if(!current(c))return;const saved=resultRow(data);if(error||!owned(saved,c.id)||saved.id!==row.id||saved.receiver_id!==c.id||saved.sender_id!==row.sender_id||saved.body!==row.body||saved.is_read!==true)throw new Error('Unconfirmed read');await Promise.allSettled([inbox(c),thread()]);}
    catch{if(current(c))app.showToast('تعذّر تأكيد حالة القراءة. حدّث المحادثة ثم حاول مجددًا.');}
    finally{if(current(c)){button.disabled=!state.contract;button.removeAttribute('aria-busy');}}
  }
  function reset(){
    state.generation++;state.enterVersion++;state.inboxVersion++;state.threadVersion++;state.contract=false;state.peer=null;state.rows=[];state.providers.clear();state.attempts.clear();state.locks.clear();state.threadLoaded=false;
    if(!state.mounted)return;byId('messagesInbox').replaceChildren();byId('messagesThread').replaceChildren();byId('messagesBody').value='';byId('messagesRecipient').replaceChildren(Object.assign(node('option','اختر مقدم الرعاية'),{value:''}));byId('messagesState').textContent='';formState();
  }
  mount();app.onUserChange(reset);app.registerRoute('messages',{requiresAuth:true,onEnter:enter});
})();
