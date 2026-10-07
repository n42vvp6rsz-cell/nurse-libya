const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const {parseHTML}=require('linkedom');
const source=fs.readFileSync('messages.js','utf8');
const ids={owner:'00000000-0000-4000-8000-000000000001',other:'00000000-0000-4000-8000-000000000002',doctor:'00000000-0000-4000-8000-000000000003',nurse:'00000000-0000-4000-8000-000000000004',stranger:'00000000-0000-4000-8000-000000000005',message:'00000000-0000-4000-8000-000000000006'};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const message=(values={})=>({id:ids.message,sender_id:ids.doctor,receiver_id:ids.owner,body:'رد خاص',is_read:false,created_at:'2026-10-07T00:00:00Z',...values});
async function setup(options={}){
  const {document}=parseHTML('<html><body><section id="messages"></section></body></html>');
  Object.defineProperty(Object.getPrototypeOf(document.createElement('select')),'value',{configurable:true,get(){return this.querySelector('option[selected]')?.value??this.querySelector('option')?.value??'';},set(value){this.querySelectorAll('option').forEach(option=>option.value===String(value)?option.setAttribute('selected',''):option.removeAttribute('selected'));}});
  const tables={doctors:[{id:ids.doctor,profile_id:ids.doctor,name:'طبيب تجريبي',city:'طرابلس',verified:true}],nurses:[{id:ids.nurse,profile_id:ids.nurse,name:'تمريض تجريبي',verified:true}],hospitals:[],messages:options.messages||[]};
  Object.assign(tables,options.tables||{});const calls=[],toasts=[],routes={},listeners=[];let user={id:ids.owner},version=1,sequence=10,writes=0;
  const client={from(table){const call={table,filters:[]};const chain={select(value){call.select=value;return chain;},eq(key,value){call.filters.push([key,value]);return chain;},or(value){call.or=value;return chain;},order(key,opts){call.order=(call.order||[]).concat([[key,opts]]);return chain;},async limit(limit){call.limit=limit;calls.push(call);if(options.query){const result=await options.query(call);if(result!==undefined)return result;}
    let rows=tables[table]||[];rows=rows.filter(row=>call.filters.every(([key,value])=>row[key]===value));
    if(table==='messages'&&call.or){const matches=[...call.or.matchAll(/(?:sender_id|receiver_id)\.eq\.([\da-f-]+)/g)].map(match=>match[1]);const unique=[...new Set(matches)];rows=rows.filter(row=>unique.length===1?row.sender_id===unique[0]||row.receiver_id===unique[0]:unique.includes(row.sender_id)&&unique.includes(row.receiver_id));}
    if(table==='messages')rows=[...rows].sort((a,b)=>b.created_at.localeCompare(a.created_at)||b.id.localeCompare(a.id));return {data:rows.slice(0,limit),error:null};}};return chain;},
    async rpc(name,params){const call={rpc:name,params};calls.push(call);if(options.rpc){const result=await options.rpc(call,tables);if(result!==undefined)return result;}
      if(name==='nurse_messages_contract_version')return {data:options.missingGate?null:1,error:options.missingGate?{code:'PGRST202'}:null};
      if(name==='send_private_message'){let row=tables.messages.find(row=>row.id===params.p_message_id);if(!row){writes++;row=message({id:params.p_message_id,sender_id:user.id,receiver_id:params.p_receiver_id,body:params.p_body,created_at:'2026-10-07T12:00:00Z'});tables.messages.push(row);}if(options.commitThenFail&&writes===1&&!options.failed){options.failed=true;throw new Error('lost response');}return {data:[row],error:null};}
      if(name==='mark_private_message_read'){const row=tables.messages.find(row=>row.id===params.p_message_id);if(row)row.is_read=true;return {data:row?[row]:[],error:null};}
    }};
  const api={client,authReady:true,get currentUser(){return user;},get userVersion(){return version;},registerRoute(name,route){routes[name]=route;},onUserChange(fn){listeners.push(fn);},showToast(text){toasts.push(text);}};
  const sandbox={document,console,Date,Intl,URLSearchParams,location:{hash:options.hash||'#messages'},NurseApp:api,crypto:{randomUUID(){return `00000000-0000-4000-8000-${String(++sequence).padStart(12,'0')}`;}}};sandbox.window=sandbox;
  vm.createContext(sandbox);vm.runInContext(source,sandbox);
  const enter=()=>routes.messages.onEnter();if(!options.skipEnter)await enter();
  const open=async id=>{document.getElementById('messagesRecipient').value=id;document.getElementById('messagesStartForm').onsubmit({preventDefault(){}});await tick();await tick();};
  const submit=async body=>{if(body!==undefined)document.getElementById('messagesBody').value=body;document.getElementById('messagesForm').onsubmit({preventDefault(){}});await tick();await tick();};
  const change=id=>{user=id?{id}:null;version++;listeners.forEach(fn=>fn(user,version));};
  return {document,tables,calls,toasts,routes,enter,open,submit,change,get writes(){return writes;}};
}
test('messages route is private; missing backend protection permits only participant reads',async()=>{
  const a=await setup({missingGate:true,messages:[message()]});assert.equal(a.routes.messages.requiresAuth,true);await a.open(ids.doctor);
  assert.match(a.document.getElementById('messagesThread').textContent,/رد خاص/);assert.equal(a.document.getElementById('messagesSend').disabled,true);assert.equal(a.document.getElementById('messagesThread').querySelector('button').disabled,true);
  await a.submit('رسالة غير مرسلة');assert.equal(a.calls.some(call=>call.rpc==='send_private_message'),false);assert.match(a.document.getElementById('messagesNotice').textContent,/تفعيل حماية/);
  const read=a.calls.find(call=>call.table==='messages');assert.match(read.or,new RegExp(ids.owner));assert.equal(read.limit,200);
});
test('new conversation choices use only verified public providers and never query profiles',async()=>{
  const a=await setup({tables:{doctors:[{id:ids.doctor,profile_id:ids.doctor,name:'<img src=x onerror=alert(1)>',verified:true},{id:ids.stranger,profile_id:ids.stranger,name:'UNVERIFIED',verified:false},{id:ids.other,profile_id:ids.owner,name:'SELF',verified:true}]}});
  const select=a.document.getElementById('messagesRecipient');assert.match(select.textContent,/<img/);assert.equal(select.querySelector('img'),null);assert.doesNotMatch(select.textContent,/UNVERIFIED|SELF/);assert.equal(a.calls.some(call=>call.table==='profiles'),false);
  select.value=ids.stranger;a.document.getElementById('messagesStartForm').onsubmit({preventDefault(){}});assert.equal(a.document.getElementById('messagesSend').disabled,true);
});
test('thread suppresses unrelated rows and safely renders message markup as text',async()=>{
  const a=await setup({query(call){if(call.table==='messages')return {data:[message({body:'<img src=x onerror=alert(1)>'}),message({id:ids.stranger,sender_id:ids.other,receiver_id:ids.stranger,body:'STRANGER PRIVATE'}),message({id:ids.nurse,sender_id:ids.nurse,receiver_id:ids.owner,body:'DIFFERENT THREAD'})],error:null};}});await a.open(ids.doctor);
  const box=a.document.getElementById('messagesThread');assert.equal(box.querySelector('img'),null);assert.match(box.textContent,/<img/);assert.doesNotMatch(box.textContent,/STRANGER PRIVATE|DIFFERENT THREAD/);
  const query=a.calls.filter(call=>call.table==='messages').at(-1);assert.match(query.or,/and\(sender_id\.eq/);assert.match(query.or,new RegExp(ids.doctor));
});
test('a public provider deep link is revalidated against the public directory',async()=>{
  const a=await setup({hash:'#messages?provider='+ids.doctor});assert.match(a.document.getElementById('messagesThreadTitle').textContent,/طبيب تجريبي/);assert.equal(a.document.getElementById('messagesSend').disabled,false);
  const b=await setup({hash:'#messages?provider='+ids.stranger});assert.equal(b.document.getElementById('messagesSend').disabled,true);
});
test('text validation rejects empty, oversized and control content before the RPC',async()=>{
  const a=await setup();await a.open(ids.doctor);for(const body of [' \n ', 'a'.repeat(5001),'test\u202e'])await a.submit(body);assert.equal(a.calls.some(call=>call.rpc==='send_private_message'),false);
  await a.submit('  سطر أول\nسطر ثان  ');const call=a.calls.find(call=>call.rpc==='send_private_message');assert.equal(call.params.p_body,'سطر أول\nسطر ثان');assert.equal(call.params.p_receiver_id,ids.doctor);assert.equal('p_sender_id'in call.params,false);
});
test('rapid repeated sends share one request and validate the returned reference',async()=>{
  const pending=deferred();const a=await setup({rpc(call){if(call.rpc==='send_private_message')return pending.promise;}});await a.open(ids.doctor);await a.submit('رسالة واحدة');await a.submit();assert.equal(a.calls.filter(call=>call.rpc==='send_private_message').length,1);
  const payload=a.calls.find(call=>call.rpc==='send_private_message').params;pending.resolve({data:[message({id:payload.p_message_id,sender_id:ids.owner,receiver_id:ids.doctor,body:payload.p_body})],error:null});await tick();await tick();assert.match(a.toasts.join(' '),/تم إرسال/);
});
test('lost send response retries the same UUID and frozen body without a duplicate',async()=>{
  const a=await setup({commitThenFail:true});await a.open(ids.doctor);await a.submit('النص الأصلي');assert.equal(a.document.getElementById('messagesBody').disabled,true);assert.match(a.document.getElementById('messagesNotice').textContent,/لم يتأكد/);
  await a.submit('نص لن يرسل');const calls=a.calls.filter(call=>call.rpc==='send_private_message');assert.equal(calls.length,2);assert.equal(calls[0].params.p_message_id,calls[1].params.p_message_id);assert.equal(calls[1].params.p_body,'النص الأصلي');assert.equal(a.writes,1);assert.match(a.toasts.join(' '),/تم إرسال/);assert.equal(a.document.getElementById('messagesBody').value,'');
});
test('empty or mismatched RPC response cannot report a sent message',async()=>{
  for(const data of [[],null,[message({sender_id:ids.stranger})]]){const a=await setup({rpc(call){if(call.rpc==='send_private_message')return {data,error:null};}});await a.open(ids.doctor);await a.submit('نص آمن');assert.equal(a.toasts.some(text=>/تم إرسال/.test(text)),false);assert.match(a.document.getElementById('messagesNotice').textContent,/لم يتأكد/);}
});
test('receiver read marking sends only the message UUID and verifies the immutable row',async()=>{
  const a=await setup({messages:[message()]});await a.open(ids.doctor);const button=a.document.getElementById('messagesThread').querySelector('button');button.onclick();await tick();await tick();
  const call=a.calls.find(call=>call.rpc==='mark_private_message_read');assert.deepEqual({...call.params},{p_message_id:ids.message});assert.equal(a.tables.messages[0].is_read,true);assert.match(a.document.getElementById('messagesThread').textContent,/مقروءة/);
  const b=await setup({messages:[message()],rpc(call){if(call.rpc==='mark_private_message_read')return {data:[message({body:'CHANGED BODY',is_read:true})],error:null};}});await b.open(ids.doctor);b.document.getElementById('messagesThread').querySelector('button').onclick();await tick();await tick();assert.match(b.toasts.join(' '),/تعذّر تأكيد/);assert.doesNotMatch(b.document.getElementById('messagesThread').textContent,/CHANGED BODY/);
});
test('account switch clears private rows, draft and unknown send effects',async()=>{
  const pending=deferred();const a=await setup({messages:[message()],rpc(call){if(call.rpc==='send_private_message')return pending.promise;}});await a.open(ids.doctor);await a.submit('OLD PRIVATE DRAFT');const params=a.calls.find(call=>call.rpc==='send_private_message').params;a.change(ids.other);
  assert.equal(a.document.getElementById('messagesInbox').textContent,'');assert.equal(a.document.getElementById('messagesThread').textContent,'');assert.equal(a.document.getElementById('messagesBody').value,'');
  pending.resolve({data:[message({id:params.p_message_id,sender_id:ids.owner,receiver_id:ids.doctor,body:params.p_body})],error:null});await tick();await tick();assert.equal(a.toasts.length,0);assert.equal(a.document.getElementById('messagesThread').textContent,'');
});
test('late inbox cannot display the previous account after a change',async()=>{
  const pending=deferred();const a=await setup({skipEnter:true,query(call){if(call.table==='messages')return pending.promise;}});const request=a.enter();await tick();a.change(ids.other);pending.resolve({data:[message({body:'OLD ACCOUNT PRIVATE'})],error:null});await request;assert.equal(a.document.getElementById('messagesInbox').textContent,'');
});
test('late thread response cannot replace a different selected conversation',async()=>{
  const pending=deferred();const a=await setup({query(call){if(call.table==='messages'&&call.or.includes('and(')&&call.or.includes(ids.doctor))return pending.promise;}});await a.open(ids.doctor);await a.open(ids.nurse);pending.resolve({data:[message({body:'OLD THREAD PRIVATE'})],error:null});await tick();await tick();assert.doesNotMatch(a.document.getElementById('messagesThread').textContent,/OLD THREAD PRIVATE/);assert.match(a.document.getElementById('messagesThreadTitle').textContent,/تمريض تجريبي/);
});
test('newer inbox refresh wins over an older response',async()=>{
  let reads=0;const pending=deferred();const a=await setup({skipEnter:true,query(call){if(call.table==='messages'){reads++;return reads===1?pending.promise:{data:[message({body:'NEWEST INBOX'})],error:null};}}});const first=a.enter();await tick();await a.enter();pending.resolve({data:[message({body:'OLDER INBOX'})],error:null});await first;assert.match(a.document.getElementById('messagesInbox').textContent,/NEWEST INBOX/);assert.doesNotMatch(a.document.getElementById('messagesInbox').textContent,/OLDER INBOX/);
});
test('provider fetch failure exposes retry and does not create partial recipient choices',async()=>{
  const a=await setup({query(call){if(call.table==='nurses')return {data:null,error:{code:'503'}};}});assert.match(a.document.getElementById('messagesRecipient').textContent,/تعذّر تحميل/);assert.equal(a.document.getElementById('messagesStart').disabled,true);assert.equal(a.document.getElementById('messagesRecipient').querySelectorAll('option').length,1);
});
