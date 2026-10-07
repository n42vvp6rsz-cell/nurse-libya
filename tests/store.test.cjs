const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {parseHTML}=require('linkedom');
const source=fs.readFileSync('store.js','utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const copy=value=>JSON.parse(JSON.stringify(value));
const productId='00000000-0000-4000-8000-000000000001';
const product={id:productId,title:'منتج اختبار محاكاة',description:'وصف اختبار',category:'مستلزمات',image_url:null,price_minor:1005,currency:'LYD',stock_quantity:3,is_active:true,created_at:'2026-10-07T00:00:00Z',updated_at:'2026-10-07T00:00:00Z'};
const checkoutFields={customer_name:'مستلم اختباري',phone:'0928482128',city:'طرابلس',address:'عنوان اختبار واضح'};
async function setup(options={}) {
  const {document}=parseHTML('<html><body><section id="store"></section><section id="orders"></section><section id="store-admin"></section></body></html>');
  Object.defineProperty(Object.getPrototypeOf(document.createElement('select')),'value',{configurable:true,get(){return this.querySelector('option[selected]')?.value ?? this.querySelector('option')?.value ?? '';},set(value){this.querySelectorAll('option').forEach(option=>{if(option.value===String(value))option.setAttribute('selected','');else option.removeAttribute('selected');});}});
  const database={store_products:copy(options.products || [product]),store_orders:copy(options.orders || []),store_order_items:copy(options.items || [])};
  const calls=[],toasts=[],routes={},listeners=[];let currentUser=options.guest ? null : {id:'owner-a',user_metadata:{role:'admin'}},version=1,sequence=100,committedFailure=false,productFailure=false;
  const client={from(table){const q={table,type:'select',filters:[]};const chain={select(columns){q.columns=columns;return chain;},eq(name,value){q.filters.push([name,value]);return chain;},order(name,details){q.order=name;q.orderOptions=details;return chain;},limit(limit){q.limit=limit;return chain;},insert(data){q.type='insert';q.data=copy(data);return chain;},update(data){q.type='update';q.data=copy(data);return chain;},single(){q.single=true;return execute();},maybeSingle(){q.maybe=true;return execute();},then(resolve,reject){return execute().then(resolve,reject);}};
      async function execute(){calls.push(copy(q));if(table==='profiles')return {data:{id:currentUser?.id,role:options.role || 'patient'},error:null};if(options.orderListPromise && table==='store_orders' && q.limit)return options.orderListPromise;
        let rows=(database[table] || []).filter(row=>q.filters.every(([key,value])=>row[key]===value));
        if(q.type==='insert'){const row={...q.data,currency:'LYD',created_at:'2026-10-07T01:00:00Z',updated_at:'2026-10-07T01:00:00Z'};database[table].push(row);rows=[row];if(options.productCommitThenFail && !productFailure){productFailure=true;throw new Error('product response lost');}}
        if(q.type==='update'){rows=options.zeroProductUpdate ? [] : rows;rows.forEach(row=>Object.assign(row,q.data,{updated_at:'2026-10-07T02:00:00Z'}));}
        if(q.single || q.maybe)return {data:rows[0] || null,error:q.single && !rows.length ? {code:'PGRST116'} : null};return {data:rows,error:null};}
      return chain;
    },async rpc(name,payload){calls.push({rpc:name,payload:payload ? copy(payload) : null,owner:currentUser?.id});
      if(name==='nurse_store_contract_version')return options.missingGate ? {data:null,error:{code:'PGRST202'}} : {data:1,error:null};
      if(name==='checkout_store_order'){
        if(options.checkoutPromise)return options.checkoutPromise;if(options.checkoutError)return {data:null,error:{code:'22023'}};
        const data=copy(payload),total=data.p_items.reduce((sum,item)=>sum+item.expected_unit_price_minor*item.quantity,0);
        const row={id:data.p_order_id,user_id:currentUser.id,customer_name:data.p_customer_name,phone:data.p_phone,city:data.p_city,address:data.p_address,notes:null,status:'pending',currency:'LYD',payment_method:'cash_on_delivery',total_minor:total,created_at:'2026-10-07T01:00:00Z',updated_at:'2026-10-07T01:00:00Z'};
        if(!options.unconfirmedOrder){database.store_orders.push(row);data.p_items.forEach(item=>database.store_order_items.push({order_id:row.id,product_id:item.product_id,title:database.store_products.find(p=>p.id===item.product_id).title,quantity:item.quantity,unit_price_minor:item.expected_unit_price_minor,line_total_minor:item.quantity*item.expected_unit_price_minor,currency:'LYD'}));}
        if(options.commitThenFail && !committedFailure){committedFailure=true;throw new Error('response lost');}return {data:[{id:row.id,status:row.status,total_minor:total,currency:'LYD',created_at:row.created_at}],error:null};
      }
      if(name==='transition_store_order'){if(options.transitionError)return {data:null,error:{code:'40001'}};const order=database.store_orders.find(row=>row.id===payload.p_order_id);if(!order || order.status!==payload.p_expected_status)return {data:null,error:{code:'40001'}};order.status=payload.p_new_status;return {data:[{id:order.id,status:order.status,total_minor:order.total_minor,currency:order.currency,updated_at:'2026-10-07T02:00:00Z'}],error:null};}
      return {data:null,error:{code:'PGRST202'}};
    }};
  const api={client,authReady:true,get currentUser(){return currentUser;},get userVersion(){return version;},registerRoute(name,route){routes[name]=route;},onReady(fn){fn(api);},onUserChange(fn){listeners.push(fn);},showToast(message){toasts.push(message);},requireLogin(page){calls.push({login:page});}};
  const sandbox={document,console,URL,Date,Intl,location:{hash:''},NurseApp:api,crypto:{randomUUID(){return `00000000-0000-4000-8000-${String(++sequence).padStart(12,'0')}`;}}};sandbox.window=sandbox;vm.createContext(sandbox);vm.runInContext(source,sandbox);if(!options.skipLoad)await routes.store.onEnter();
  const form=()=>document.getElementById('storeCheckoutForm');const fill=(values,target=form())=>Object.entries(values).forEach(([key,value])=>{target.querySelector(`[name="${key}"]`).value=String(value);});
  const add=()=>document.querySelector('#storeProducts article button')?.onclick();const submit=async values=>{if(values)fill(values);form().onsubmit({preventDefault(){}});await tick();await tick();await tick();};
  const emit=user=>{currentUser=user;version++;listeners.forEach(fn=>fn(currentUser,version));};
  const admin=async()=>{await routes['store-admin'].onEnter();};const productForm=()=>document.getElementById('storeProductForm');const saveProduct=async values=>{if(values)fill(values,productForm());productForm().onsubmit({preventDefault(){}});await tick();await tick();await tick();};
  return {document,database,calls,toasts,routes,form,fill,add,submit,emit,admin,productForm,saveProduct};
}
test('public catalog filters active products and renders text safely with HTTPS images only',async()=>{
  const a=await setup({products:[{...product,title:'<img src=x onerror=alert(1)>',image_url:'javascript:alert(1)'},{...product,id:'00000000-0000-4000-8000-000000000002',title:'HIDDEN',is_active:false}]});
  assert.equal(a.document.querySelector('#storeProducts img'),null);assert.match(a.document.getElementById('storeProducts').textContent,/<img/);assert.doesNotMatch(a.document.getElementById('storeProducts').textContent,/HIDDEN/);
  const query=a.calls.find(call=>call.table==='store_products');assert.ok(query.filters.some(([key,value])=>key==='is_active' && value===true));assert.doesNotMatch(query.columns,/phone|email|patient/);
});
test('Libyan minor prices use 1000 dirhams per dinar without fabricated inventory',async()=>{
  const a=await setup();assert.ok(a.document.getElementById('storeProducts').textContent.includes((1005/1000).toLocaleString('ar-LY',{minimumFractionDigits:3,maximumFractionDigits:3})+' د.ل'));const empty=await setup({products:[]});assert.match(empty.document.getElementById('storeProducts').textContent,/لا توجد منتجات منشورة/);assert.equal(empty.document.querySelectorAll('#storeProducts article').length,0);
});
test('missing contract blocks programmatic checkout without recording an order',async()=>{
  const a=await setup({missingGate:true});a.add();await a.submit(checkoutFields);assert.equal(a.calls.some(call=>call.rpc==='checkout_store_order'),false);assert.equal(a.document.getElementById('storeCheckoutButton').disabled,true);assert.match(a.document.getElementById('storeCheckoutState').textContent,/تفعيل/);
});
test('cart bounds latest stock and allows removal without promising availability',async()=>{
  const a=await setup({products:[{...product,stock_quantity:1}]});a.add();a.add();assert.match(a.document.getElementById('storeCartItems').textContent,/الكمية: 1/);assert.equal(a.toasts.length,1);assert.match(a.document.getElementById('storeCart').textContent,/تُراجع الكمية/);const remove=[...a.document.querySelectorAll('#storeCartItems button')].find(control=>control.textContent==='إزالة');remove.onclick();assert.match(a.document.getElementById('storeCartItems').textContent,/السلة فارغة/);
});
test('catalog search and category use actual catalog values',async()=>{
  const a=await setup();const search=a.document.querySelector('#storeFilters [name="search"]');search.value='غير موجود';a.document.getElementById('storeFilters').oninput();assert.match(a.document.getElementById('storeProducts').textContent,/لا توجد منتجات تطابق/);search.value='اختبار';a.document.getElementById('storeFilters').oninput();assert.equal(a.document.querySelectorAll('#storeProducts article').length,1);
});
test('guest checkout preserves intent through the auth route and never submits anonymously',async()=>{
  const a=await setup({guest:true});a.add();await a.submit(checkoutFields);assert.ok(a.calls.some(call=>call.login==='store'));assert.equal(a.calls.some(call=>call.rpc==='checkout_store_order'),false);
});
test('checkout validates name, Libyan phone, allowed city and delivery address before server mutation',async()=>{
  const a=await setup();a.add();for(const invalid of [{customer_name:'1'},{customer_name:'اسم\u202e مزور'},{phone:'+19999999999'},{phone:'0000000000'},{city:'غير معروف'},{address:'قصير'.slice(0,3)}])await a.submit({...checkoutFields,...invalid});assert.equal(a.calls.some(call=>call.rpc==='checkout_store_order'),false);
});
test('checkout sends only immutable intent and expected comparison price, then verifies owner snapshots',async()=>{
  const a=await setup();a.add();await a.submit({...checkoutFields,phone:'٠٩٢٨٤٨٢١٢٨'});const call=a.calls.find(call=>call.rpc==='checkout_store_order');assert.ok(call);assert.equal(call.payload.p_phone,'+218928482128');assert.equal(call.payload.p_items[0].expected_unit_price_minor,1005);assert.equal('total_minor' in call.payload,false);assert.equal('user_id' in call.payload,false);assert.equal(call.payload.p_notes,null);assert.ok(a.calls.some(call=>call.table==='store_orders' && call.filters.some(([key,value])=>key==='user_id' && value==='owner-a')));assert.ok(a.toasts.some(message=>/تم حفظ طلب الشراء/.test(message)));assert.match(a.document.getElementById('storeCartItems').textContent,/السلة فارغة/);
});
test('two rapid checkout submissions make one transaction and one order',async()=>{
  const a=await setup();a.add();a.fill(checkoutFields);a.form().onsubmit({preventDefault(){}});a.form().onsubmit({preventDefault(){}});await tick();await tick();await tick();assert.equal(a.calls.filter(call=>call.rpc==='checkout_store_order').length,1);assert.equal(a.database.store_orders.length,1);
});
test('lost checkout response recovers original frozen UUID before changed inventory without a duplicate',async()=>{
  const a=await setup({commitThenFail:true});a.add();await a.submit(checkoutFields);const first=a.calls.find(call=>call.rpc==='checkout_store_order');assert.equal(a.form().querySelector('input').disabled,true);a.fill({...checkoutFields,customer_name:'تعديل غير مرسل'});a.database.store_products[0].price_minor=5000;a.database.store_products[0].stock_quantity=0;a.database.store_products[0].is_active=false;await a.routes.store.onEnter();await a.submit();assert.equal(a.calls.filter(call=>call.rpc==='checkout_store_order').length,1);assert.equal(a.database.store_orders.length,1);assert.equal(a.database.store_orders[0].id,first.payload.p_order_id);assert.equal(a.database.store_orders[0].customer_name,checkoutFields.customer_name);assert.ok(a.toasts.some(message=>/تم التحقق من الطلب المحفوظ/.test(message)));
});
test('saved snapshot mismatch retains attempt and never produces false success',async()=>{
  const a=await setup({commitThenFail:true});a.add();await a.submit(checkoutFields);a.database.store_order_items[0].unit_price_minor=2000;a.database.store_order_items[0].line_total_minor=2000;a.database.store_orders[0].total_minor=2000;await a.submit();assert.equal(a.toasts.some(message=>/تم حفظ طلب الشراء/.test(message)),false);assert.match(a.document.getElementById('storeCheckoutState').textContent,/لا يطابق/);assert.equal(a.calls.filter(call=>call.rpc==='checkout_store_order').length,1);
});
test('a transaction summary without a persisted order never counts as success',async()=>{
  const a=await setup({unconfirmedOrder:true});a.add();await a.submit(checkoutFields);assert.equal(a.toasts.some(message=>/تم حفظ طلب الشراء/.test(message)),false);assert.match(a.document.getElementById('storeCheckoutState').textContent,/لم تتأكد/);assert.equal(a.form().querySelector('input').disabled,true);
});
test('failed checkout edits unlock only after authoritative own-order absence',async()=>{
  const a=await setup({checkoutError:true});a.add();await a.submit(checkoutFields);assert.equal(a.form().querySelector('input').disabled,true);a.document.getElementById('storeEditCheckout').onclick();await tick();await tick();assert.equal(a.form().querySelector('input').disabled,false);assert.match(a.document.getElementById('storeCheckoutState').textContent,/لم يظهر طلب/);
});
test('account changes clear cart, delivery inputs, attempt and private order content',async()=>{
  const a=await setup({checkoutError:true});a.add();await a.submit(checkoutFields);a.emit({id:'owner-b'});assert.equal(a.form().querySelector('[name="address"]').value,'');assert.equal(a.document.getElementById('storeOrderReference').textContent,'');assert.match(a.document.getElementById('storeCartItems').textContent,/السلة فارغة/);assert.equal(a.document.getElementById('storeOrdersList').textContent,'');assert.equal(a.document.getElementById('storeAdminPanel').hidden,true);
});
test('late checkout response cannot confirm a different account',async()=>{
  let resolve;const promise=new Promise(r=>resolve=r);const a=await setup({checkoutPromise:promise});a.add();await a.submit(checkoutFields);const call=a.calls.find(call=>call.rpc==='checkout_store_order');a.emit({id:'owner-b'});resolve({data:[{id:call.payload.p_order_id,status:'pending',total_minor:1005,currency:'LYD'}],error:null});await tick();await tick();assert.equal(a.toasts.some(message=>/تم حفظ طلب الشراء/.test(message)),false);assert.equal(a.document.getElementById('storeOrderReference').textContent,'');
});
test('own order listing filters current owner and suppresses late account responses',async()=>{
  let resolve;const promise=new Promise(r=>resolve=r);const a=await setup({orderListPromise:promise});const request=a.routes.orders.onEnter();await tick();a.emit({id:'owner-b'});resolve({data:[{id:productId,user_id:'owner-a',customer_name:'PRIVATE',status:'pending',total_minor:1005,currency:'LYD'}],error:null});await request;assert.equal(a.document.getElementById('storeOrdersList').textContent,'');assert.ok(a.calls.some(call=>call.table==='store_orders' && call.filters.some(([key,value])=>key==='user_id' && value==='owner-a')));
});
test('admin authority uses own stored role rather than forged user metadata',async()=>{
  const a=await setup({role:'patient'});await a.admin();assert.equal(a.document.getElementById('storeAdminPanel').hidden,true);assert.match(a.document.getElementById('storeAdminState').textContent,/المعتمدة للإدارة/);assert.equal(a.calls.some(call=>call.table==='store_orders'),false);assert.ok(a.calls.find(call=>call.table==='profiles').filters.some(([key,value])=>key==='id' && value==='owner-a'));
});
test('admin product authoring leaves currency and timestamps server controlled',async()=>{
  const a=await setup({role:'admin'});await a.admin();await a.saveProduct({title:'منتج محاكاة جديد',description:'وصف',category:'فئة',image_url:'https://example.test/product.png',price_minor:'12345',stock_quantity:'2',is_active:'false'});const insert=a.calls.find(call=>call.type==='insert');assert.ok(insert);assert.equal(insert.table,'store_products');for(const key of ['currency','created_at','updated_at','user_id','role'])assert.equal(key in insert.data,false);assert.equal(insert.data.price_minor,12345);assert.equal(insert.data.is_active,false);assert.ok(a.toasts.some(message=>/تم تأكيد حفظ المنتج/.test(message)));
});
test('admin rejects invalid inventory and unsafe image URLs before product writes',async()=>{
  const a=await setup({role:'admin'});await a.admin();const valid={title:'منتج اختباري',price_minor:'1000',stock_quantity:'1',is_active:'true'};for(const invalid of [{price_minor:'1.2'},{price_minor:'0'},{stock_quantity:'-1'},{image_url:'http://example.test/p.png'},{image_url:'https://user:pass@example.test/p.png'},{title:'\u202eمحاولة'}])await a.saveProduct({...valid,...invalid});assert.equal(a.calls.some(call=>call.type==='insert'),false);
});
test('admin product lost response retries same saved UUID without a second insert',async()=>{
  const a=await setup({role:'admin',productCommitThenFail:true});await a.admin();await a.saveProduct({title:'منتج اختباري',price_minor:'1000',stock_quantity:'1',is_active:'false'});assert.equal(a.productForm().querySelector('input').disabled,true);await a.saveProduct();assert.equal(a.calls.filter(call=>call.type==='insert').length,1);assert.ok(a.toasts.some(message=>/تم تأكيد حفظ المنتج/.test(message)));
});
test('admin product update includes ID and timestamp comparison and rejects zero rows',async()=>{
  const a=await setup({role:'admin',zeroProductUpdate:true});await a.admin();a.document.querySelector('#storeAdminProducts button').onclick();await a.saveProduct({title:'اسم معدل'});const update=a.calls.find(call=>call.type==='update');assert.ok(update.filters.some(([key,value])=>key==='id' && value===productId));assert.ok(update.filters.some(([key,value])=>key==='updated_at' && value===product.updated_at));assert.equal(a.toasts.some(message=>/تم تأكيد حفظ المنتج/.test(message)),false);
});
test('admin reviews order through expected-status RPC without direct order writes',async()=>{
  const order={id:productId,user_id:'owner-b',customer_name:'عميل تجريبي',phone:'+218928482128',city:'طرابلس',address:'عنوان اختبار',status:'pending',total_minor:1005,currency:'LYD',created_at:'2026-10-07T00:00:00Z'};
  const a=await setup({role:'admin',orders:[order]});await a.admin();a.document.querySelector('#storeAdminOrders button').onclick();await tick();await tick();await tick();const review=a.calls.find(call=>call.rpc==='transition_store_order');assert.deepEqual(review.payload,{p_order_id:productId,p_expected_status:'pending',p_new_status:'confirmed'});assert.equal(a.calls.some(call=>call.table==='store_orders' && call.type!=='select'),false);assert.equal(a.database.store_orders[0].status,'confirmed');
});
test('admin stale review rejection never displays a confirmed decision',async()=>{
  const a=await setup({role:'admin',transitionError:true,orders:[{id:productId,user_id:'owner-b',customer_name:'عميل',status:'pending',total_minor:1005,currency:'LYD'}]});await a.admin();a.document.querySelector('#storeAdminOrders button').onclick();await tick();await tick();assert.equal(a.toasts.some(message=>/تم تأكيد حالة/.test(message)),false);assert.equal(a.database.store_orders[0].status,'pending');
});
test('recovered cancelled order displays its saved terminal state and never starts a new transaction',async()=>{
  const a=await setup({commitThenFail:true});a.add();await a.submit(checkoutFields);a.database.store_orders[0].status='cancelled';await a.submit();assert.equal(a.calls.filter(call=>call.rpc==='checkout_store_order').length,1);assert.match(a.toasts.at(-1),/الطلب المحفوظ.*ملغي/);assert.equal(a.toasts.some(message=>/تم حفظ طلب الشراء/.test(message)),false);
});
test('stale product attempt can load latest saved data before a new edit',async()=>{
  const a=await setup({role:'admin',zeroProductUpdate:true});await a.admin();a.document.querySelector('#storeAdminProducts button').onclick();await a.saveProduct({title:'تعديل لم يحفظ'});assert.equal(a.productForm().querySelector('input').disabled,true);Object.assign(a.database.store_products[0],{title:'تعديل محفوظ آخر',updated_at:'2026-10-07T03:00:00Z'});a.document.getElementById('storeEditProductAttempt').onclick();await tick();await tick();assert.equal(a.productForm().querySelector('[name="title"]').value,'تعديل محفوظ آخر');assert.equal(a.productForm().querySelector('input').disabled,false);assert.match(a.document.getElementById('storeProductState').textContent,/أحدث بيانات/);
});
test('admin order product details are constrained to the selected order and captured owner',async()=>{
  const order={id:productId,user_id:'owner-b',customer_name:'عميل تجريبي',phone:'+218928482128',city:'طرابلس',address:'عنوان اختبار',notes:null,status:'pending',total_minor:1005,currency:'LYD',payment_method:'cash_on_delivery',created_at:'2026-10-07T00:00:00Z'};
  const item={order_id:productId,product_id:productId,title:'<img src=x>',quantity:1,unit_price_minor:1005,line_total_minor:1005,currency:'LYD'};const a=await setup({role:'admin',orders:[order],items:[item]});await a.admin();[...a.document.querySelectorAll('#storeAdminOrders button')].find(control=>control.textContent==='عرض منتجات الطلب').onclick();await tick();await tick();assert.equal(a.document.querySelector('#storeAdminOrders img'),null);assert.match(a.document.getElementById('storeAdminOrders').textContent,/<img/);const detail=a.calls.filter(call=>call.table==='store_orders' && call.maybe).at(-1);assert.ok(detail.filters.some(([key,value])=>key==='id' && value===productId));assert.ok(detail.filters.some(([key,value])=>key==='user_id' && value==='owner-b'));
});
test('cart permits at most twenty unique product intents before checkout',async()=>{
  const products=Array.from({length:21},(_,i)=>({...product,id:`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,title:'منتج اختباري '+i}));const a=await setup({products});[...a.document.querySelectorAll('#storeProducts article button')].forEach(control=>control.onclick());assert.equal(a.document.getElementById('storeCartItems').children.length,20);assert.equal(a.toasts.length,1);await a.submit(checkoutFields);assert.equal(a.calls.find(call=>call.rpc==='checkout_store_order').payload.p_items.length,20);
});
