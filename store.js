'use strict';
(() => {
  const app = window.NurseApp;
  if (!app) return;
  const cities = ['طرابلس','بنغازي','مصراتة','الخمس','سبها','غريان','طبرق','البيضاء','درنة','زليتن','الزاوية','صبراتة','نالوت'];
  const productColumns = 'id,title,description,category,image_url,price_minor,currency,stock_quantity,is_active,created_at,updated_at';
  const orderColumns = 'id,user_id,customer_name,phone,city,address,notes,status,total_minor,currency,payment_method,created_at,updated_at,cancelled_at';
  const itemColumns = 'order_id,product_id,title,quantity,unit_price_minor,currency,line_total_minor';
  const labels = {pending:'قيد المراجعة',confirmed:'تم التأكيد',completed:'مكتمل',cancelled:'ملغي'};
  const state = {mounted:false,epoch:0,catalogVersion:0,ordersVersion:0,adminVersion:0,products:[],cart:new Map(),gate:false,role:null,attempt:null,working:null,productAttempt:null,productWorking:null,productEdit:null,adminProducts:[],reviews:new Set()};
  const byId = id => document.getElementById(id);
  const el = (tag,text,className) => { const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node; };
  const button = (text,action,className='secondary') => { const node=el('button',text,className);node.type='button';node.onclick=action;return node; };
  const context = () => ({id:app.currentUser?.id || null,version:app.userVersion,epoch:state.epoch});
  const current = c => c.epoch===state.epoch && c.version===app.userVersion && c.id===(app.currentUser?.id || null);
  const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value || '');
  const fail = message => Object.assign(new Error(message),{display:message});
  const explain = error => error?.display || ({
    'product price changed; refresh and review the cart':'تغيّر سعر منتج. تحقق من المحاولة السابقة ثم حدّث المنتجات وراجع السلة.',
    'insufficient stock; refresh the cart':'الكمية المطلوبة غير متوفرة. تحقق من المحاولة السابقة ثم حدّث المنتجات وراجع السلة.',
    'product is unavailable; refresh the cart':'أصبح منتج غير متاح. تحقق من المحاولة السابقة ثم حدّث المنتجات وراجع السلة.',
    'order changed; refresh before reviewing':'تغيّرت حالة الطلب. حدّث القائمة قبل إصدار قرار آخر.',
    'available and reserved stock exceeds inventory capacity':'المخزون المتاح والطلبات المحجوزة يتجاوزان الحد المسموح. راجع الكمية.'
  })[error?.message] || 'تعذّر تأكيد العملية. تحقق من الاتصال ثم أعد المحاولة.';
  const integer = (value,min,max) => Number.isSafeInteger(value) && value>=min && value<=max;
  const money = value => integer(value,0,Number.MAX_SAFE_INTEGER) ? (value/1000).toLocaleString('ar-LY',{minimumFractionDigits:3,maximumFractionDigits:3})+' د.ل' : 'السعر غير متاح';
  const safeImage = value => {try {const url=new URL(value);return url.protocol==='https:' && !url.username && !url.password ? url.href : null;}catch{return null;}};
  function clean(raw,max,min=0) {
    const value=String(raw || '').normalize('NFC').trim();
    if(value.length<min || value.length>max || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value))throw fail('أدخل بيانات صحيحة ضمن الحدود الموضحة.');
    return value;
  }
  function phone(raw) {
    const text=String(raw || '').replace(/[٠-٩]/g,ch=>String(ch.charCodeAt(0)-1632)).replace(/[۰-۹]/g,ch=>String(ch.charCodeAt(0)-1776)).replace(/[\s()-]/g,'');
    const normalized=text.replace(/^00218/,'+218').replace(/^0(?=\d{9}$)/,'+218');
    if(!/^\+218[0-9]{9}$/.test(normalized) || /^(\+218)(\d)\2{8}$/.test(normalized))throw fail('أدخل رقم هاتف ليبي صحيحًا، مثل 09xxxxxxxx أو +2189xxxxxxxx.');
    return normalized;
  }
  function field(form,name,label,options={}) {
    const holder=el('label',label),input=el(options.choices ? 'select' : options.multiline ? 'textarea' : 'input');input.name=name;
    if(options.choices)options.choices.forEach(([value,text])=>{const option=el('option',text);option.value=value;input.append(option);});
    else {input.type=options.type || 'text';input.maxLength=options.max || 100;if(options.type==='number'){input.min=String(options.min??0);input.max=String(options.limit??100000000);input.step='1';input.dir='ltr';}}
    if(options.required)input.required=true;if(options.multiline)input.rows=3;
    holder.append(input);form.append(holder);return input;
  }
  const get = (form,name) => form.querySelector(`[name="${name}"]`)?.value || '';
  const resetForm = form => form?.querySelectorAll('input,textarea,select').forEach(input=>{input.value=input.tagName==='SELECT' ? input.querySelector('option')?.value || '' : '';});
  async function query(request,c) {const response=await request;if(!current(c))return null;if(response.error)throw response.error;return response.data;}
  async function gate(c) {try {const {data,error}=await app.client.rpc('nurse_store_contract_version');return current(c) && !error && data===1;}catch{return false;}}
  async function trustedAdmin(c) {
    if(!c.id)return false;
    const row=await query(app.client.from('profiles').select('id,role').eq('id',c.id).single(),c);
    if(!current(c))return false;
    state.role=row?.id===c.id ? row.role : null;return state.role==='admin';
  }
  function mount() {
    if(state.mounted)return true;
    const store=byId('store'),orders=byId('orders'),admin=byId('store-admin');if(!store || !orders || !admin)return false;
    const head=el('div',undefined,'section-head'),titles=el('div');titles.append(el('span','مستلزمات الرعاية','eyebrow'),el('h1','المتجر'));head.append(titles,button('تحديث المنتجات',()=>void loadStore()));
    const status=el('p','');status.id='storeState';status.setAttribute('role','status');
    const filters=el('form',undefined,'catalog-filters');filters.id='storeFilters';field(filters,'search','ابحث عن منتج',{max:160});field(filters,'category','الفئة',{choices:[['','كل الفئات']]});filters.oninput=()=>renderProducts();filters.onsubmit=event=>{event.preventDefault();renderProducts();};
    const grid=el('div',undefined,'grid');grid.id='storeProducts';grid.setAttribute('aria-live','polite');
    const cart=el('div',undefined,'card');cart.id='storeCart';const items=el('div');items.id='storeCartItems';const total=el('p');total.id='storeCartTotal';cart.append(el('h2','السلة'),items,total,el('p','السعر والمخزون المعروضان آخر بيانات متاحة. يُحسب المبلغ وتُراجع الكمية عند حفظ الطلب.','muted'));
    const form=el('form',undefined,'authoring-form');form.id='storeCheckoutForm';field(form,'customer_name','اسم المستلم',{required:true,max:100});field(form,'phone','رقم هاتف ليبي',{required:true,type:'tel',max:25});field(form,'city','المدينة',{required:true,choices:[['','اختر المدينة'],...cities.map(city=>[city,city])]});field(form,'address','عنوان التسليم (5 إلى 500 حرف)',{required:true,max:500});
    const notice=el('p','');notice.id='storeCheckoutState';notice.setAttribute('role','status');const ref=el('p','');ref.id='storeOrderReference';
    const actions=el('div',undefined,'form-actions'),submit=el('button','إرسال طلب الشراء');submit.type='submit';submit.id='storeCheckoutButton';const edit=button('التحقق قبل تعديل الطلب',()=>void editCheckout());edit.id='storeEditCheckout';edit.hidden=true;actions.append(submit,edit);
    form.append(el('p','طريقة الطلب: الدفع نقدًا عند التسليم بعد تأكيد الطلب. أدخل بيانات التسليم فقط؛ لا تُرسل معلومات صحية. إرسال الطلب لا يؤكد التوصيل.','muted'),notice,ref,actions);form.onsubmit=event=>{event.preventDefault();void checkout();};cart.append(form);
    store.replaceChildren(head,status,filters,grid,cart);
    const orderStatus=el('p','');orderStatus.id='storeOrdersState';orderStatus.setAttribute('role','status');const orderList=el('div',undefined,'grid');orderList.id='storeOrdersList';
    orders.replaceChildren(el('h1','طلباتي من المتجر'),button('تحديث الطلبات',()=>void loadOrders()),orderStatus,orderList);
    const adminState=el('p','');adminState.id='storeAdminState';adminState.setAttribute('role','status');const panel=el('div',undefined,'card');panel.id='storeAdminPanel';panel.hidden=true;
    const productForm=el('form',undefined,'authoring-form');productForm.id='storeProductForm';field(productForm,'title','اسم المنتج (2 إلى 160 حرفًا)',{required:true,max:160});field(productForm,'description','وصف المنتج (اختياري)',{max:2000});field(productForm,'category','الفئة (اختياري)',{max:80});field(productForm,'image_url','رابط صورة HTTPS (اختياري)',{max:2000,type:'url'});field(productForm,'price_minor','السعر بالدرهم: 1000 درهم = 1 دينار',{type:'number',required:true,min:1,limit:100000000});field(productForm,'stock_quantity','المخزون (0 إلى 100000)',{type:'number',required:true,min:0,limit:100000});field(productForm,'is_active','حالة عرض المنتج',{choices:[['false','غير منشور'],['true','منشور']]});
    const productNotice=el('p','');productNotice.id='storeProductState';productNotice.setAttribute('role','status');const save=el('button','حفظ المنتج');save.type='submit';save.id='storeSaveProduct';const cancel=button('إلغاء التعديل',()=>resetProduct());cancel.id='storeCancelProduct';cancel.hidden=true;const checkProduct=button('التحقق قبل تغيير بيانات المنتج',()=>void editProductAttempt());checkProduct.id='storeEditProductAttempt';checkProduct.hidden=true;productForm.append(productNotice,save,cancel,checkProduct);productForm.onsubmit=event=>{event.preventDefault();void saveProduct();};
    const inventory=el('div',undefined,'grid');inventory.id='storeAdminProducts';const reviews=el('div',undefined,'grid');reviews.id='storeAdminOrders';panel.append(el('h2','إدارة المنتجات'),productForm,inventory,el('h2','مراجعة طلبات الشراء'),reviews);
    admin.replaceChildren(el('h1','إدارة المتجر'),button('تحديث الإدارة',()=>void loadAdmin()),adminState,panel);state.mounted=true;renderCart();lockCheckout();return true;
  }
  function validProduct(row) {return uuid(row?.id) && typeof row.title==='string' && row.title.length>=2 && row.currency==='LYD' && integer(row.price_minor,1,100000000) && integer(row.stock_quantity,0,100000) && typeof row.is_active==='boolean';}
  function renderProducts() {
    if(!state.mounted)return;
    const grid=byId('storeProducts');grid.replaceChildren();const form=byId('storeFilters'),search=get(form,'search').trim().toLocaleLowerCase(),category=get(form,'category');
    const rows=state.products.filter(row=>row.is_active && (!category || row.category===category) && (!search || [row.title,row.description,row.category].some(value=>String(value || '').toLocaleLowerCase().includes(search))));
    if(!rows.length)grid.append(el('p',state.products.length ? 'لا توجد منتجات تطابق البحث.' : 'لا توجد منتجات منشورة حاليًا.','empty'));
    rows.forEach(row=>{const card=el('article',undefined,'card'),image=safeImage(row.image_url);if(image){const img=el('img');img.src=image;img.alt=row.title;img.loading='lazy';img.referrerPolicy='no-referrer';img.className='product-image';card.append(img);}card.append(el('h3',row.title));if(row.category)card.append(el('p',row.category,'eyebrow'));if(row.description)card.append(el('p',row.description));card.append(el('p',money(row.price_minor)),el('p',row.stock_quantity>0 ? 'متاح للطلب، بعد مراجعة الكمية' : 'غير متوفر حاليًا','muted'));
      const add=button('إضافة إلى السلة',()=>addToCart(row.id));add.disabled=!state.gate || row.stock_quantity<1 || !!state.attempt || !!state.working;card.append(add);grid.append(card);});
  }
  function addToCart(id) {
    if(!state.gate || state.attempt || state.working)return;
    const row=state.products.find(product=>product.id===id && product.is_active);if(!row)return;
    const quantity=(state.cart.get(id)||0)+1;if(quantity>Math.min(99,row.stock_quantity) || (!state.cart.has(id) && state.cart.size>=20)){app.showToast('الكمية المطلوبة تتجاوز الحد المتاح في السلة.');return;}state.cart.set(id,quantity);renderCart();
  }
  function renderCart() {
    if(!state.mounted)return;const list=byId('storeCartItems');list.replaceChildren();let subtotal=0;
    state.cart.forEach((quantity,id)=>{const product=state.products.find(row=>row.id===id),line=el('div',undefined,'cart-item');line.append(el('strong',product?.title || 'منتج غير متاح'),el('span','الكمية: '+quantity));if(product){subtotal+=product.price_minor*quantity;line.append(el('span',money(product.price_minor*quantity)));}
      const less=button('−',()=>{if(state.attempt || state.working)return;if(quantity<=1)state.cart.delete(id);else state.cart.set(id,quantity-1);renderCart();}),more=button('+',()=>addToCart(id)),remove=button('إزالة',()=>{if(state.attempt || state.working)return;state.cart.delete(id);renderCart();});less.setAttribute('aria-label','إنقاص كمية '+(product?.title || 'المنتج'));more.setAttribute('aria-label','زيادة كمية '+(product?.title || 'المنتج'));[less,more,remove].forEach(control=>{control.disabled=!!state.attempt || !!state.working || !state.gate;});line.append(less,more,remove);list.append(line);});
    if(!state.cart.size)list.append(el('p','السلة فارغة.'));byId('storeCartTotal').textContent='مجموع أسعار المنتجات المعروضة: '+money(subtotal);lockCheckout();
  }
  function lockCheckout() {
    if(!state.mounted)return;const form=byId('storeCheckoutForm'),locked=!!state.attempt || !!state.working;
    form.querySelectorAll('input,select').forEach(input=>{input.disabled=locked || !state.gate;});const submit=byId('storeCheckoutButton');submit.disabled=!!state.working || !state.gate || (!state.attempt && !state.cart.size);submit.textContent=state.working ? 'يرجى الانتظار…' : state.attempt ? 'التحقق وإعادة المحاولة' : app.currentUser ? 'إرسال طلب الشراء' : 'تسجيل الدخول لإتمام الطلب';
    byId('storeEditCheckout').hidden=!state.attempt;byId('storeEditCheckout').disabled=!!state.working;form.toggleAttribute('aria-busy',!!state.working);
  }
  async function loadStore() {
    if(!mount())return;const c=context(),version=++state.catalogVersion;byId('storeState').textContent='جارٍ تحميل المنتجات…';
    try {if(!app.client)throw fail('تعذّر الاتصال بالمتجر.');state.gate=await gate(c);if(!current(c) || version!==state.catalogVersion)return;
      const rows=await query(app.client.from('store_products').select(productColumns).eq('is_active',true).order('title',{ascending:true}).limit(200),c);if(!current(c) || version!==state.catalogVersion)return;
      state.products=(rows || []).filter(validProduct).filter(row=>row.is_active===true);const select=byId('storeFilters').querySelector('[name="category"]'),selected=select.value;select.replaceChildren();[['','كل الفئات'],...[...new Set(state.products.map(row=>row.category).filter(Boolean))].sort().map(value=>[value,value])].forEach(([value,text])=>{const option=el('option',text);option.value=value;select.append(option);});select.value=selected;
      byId('storeState').textContent=state.gate ? 'تُراجع طلبات الشراء قبل تأكيدها. الدفع نقدًا عند التسليم.' : 'الشراء متوقف حتى تفعيل قاعدة بيانات المتجر. يمكنك عرض المنتجات المنشورة إن توفرت.';renderProducts();renderCart();
    } catch {if(current(c) && version===state.catalogVersion){state.products=[];state.gate=false;byId('storeState').textContent='المتجر غير متاح حاليًا. أعد المحاولة لاحقًا.';renderProducts();renderCart();}}
  }
  function checkoutPayload() {
    const form=byId('storeCheckoutForm'),customer=clean(get(form,'customer_name'),100,2);let letters=0;for(const ch of customer){if(/\p{L}/u.test(ch))letters++;else if(!/[\p{M}\s.'’\-]/u.test(ch))throw fail('أدخل اسم المستلم الصحيح.');}if(letters<2)throw fail('أدخل اسم المستلم الصحيح.');
    const city=get(form,'city');if(!cities.includes(city))throw fail('اختر مدينة التسليم.');if(!state.cart.size || state.cart.size>20)throw fail('أضف منتجًا متاحًا إلى السلة.');
    const items=[...state.cart].sort(([a],[b])=>a.localeCompare(b)).map(([product_id,quantity])=>{const product=state.products.find(row=>row.id===product_id && row.is_active);if(!product || !integer(quantity,1,Math.min(99,product.stock_quantity)))throw fail('تغيّر توفر منتج في السلة. حدّث المنتجات وراجع الكمية.');return Object.freeze({product_id,quantity,expected_unit_price_minor:product.price_minor});});
    const id=window.crypto?.randomUUID?.();if(!uuid(id))throw fail('تعذّر إنشاء مرجع آمن للطلب.');
    return Object.freeze({p_order_id:id,p_items:Object.freeze(items),p_customer_name:customer,p_phone:phone(get(form,'phone')),p_city:city,p_address:clean(get(form,'address'),500,5),p_notes:null});
  }
  async function orderDetails(id,c,expectedOwner=c.id) {
    const order=await query(app.client.from('store_orders').select(orderColumns).eq('id',id).eq('user_id',expectedOwner).maybeSingle(),c);if(!current(c) || !order)return null;if(order.id!==id || order.user_id!==expectedOwner)throw fail('تعذّر التحقق من ملكية الطلب.');
    const items=await query(app.client.from('store_order_items').select(itemColumns).eq('order_id',id).order('product_id',{ascending:true}),c);if(!current(c))return null;
    if(!Array.isArray(items) || !items.length || items.length>20 || new Set(items.map(item=>item.product_id)).size!==items.length || items.some(item=>item.order_id!==id || !uuid(item.product_id) || !integer(item.quantity,1,99) || !integer(item.unit_price_minor,1,100000000) || !integer(item.line_total_minor,1,Number.MAX_SAFE_INTEGER) || item.line_total_minor!==item.quantity*item.unit_price_minor || item.currency!=='LYD') || order.currency!=='LYD' || order.payment_method!=='cash_on_delivery' || !integer(order.total_minor,1,Number.MAX_SAFE_INTEGER) || items.reduce((sum,item)=>sum+item.line_total_minor,0)!==order.total_minor || !labels[order.status])throw fail('تعذّر التحقق من تفاصيل الطلب المحفوظ.');
    return {order,items};
  }
  function matchesAttempt(details,attempt) {
    const p=attempt.payload,o=details.order;if(o.id!==p.p_order_id || o.user_id!==attempt.owner.id || o.customer_name!==p.p_customer_name || o.phone!==p.p_phone || o.city!==p.p_city || o.address!==p.p_address || (o.notes || null)!==p.p_notes)return false;
    const items=details.items.map(({product_id,quantity,unit_price_minor})=>({product_id,quantity,expected_unit_price_minor:unit_price_minor})).sort((a,b)=>a.product_id.localeCompare(b.product_id));return JSON.stringify(items)===JSON.stringify(p.p_items);
  }
  async function recover(attempt) {const details=await orderDetails(attempt.payload.p_order_id,attempt.owner);if(details && !matchesAttempt(details,attempt))throw fail('مرجع الطلب لا يطابق بيانات هذه المحاولة؛ لا ترسل طلبًا آخر قبل المراجعة.');return details;}
  function checkoutSaved(details,attempt,recovered=false) {
    if(!current(attempt.owner))return;state.attempt=null;state.cart.clear();resetForm(byId('storeCheckoutForm'));byId('storeOrderReference').textContent='رقم الطلب: '+details.order.id;byId('storeCheckoutState').textContent='تم التحقق من حفظ الطلب وهو '+labels[details.order.status]+'. المبلغ المحفوظ: '+money(details.order.total_minor);renderCart();renderProducts();app.showToast(recovered ? 'تم التحقق من الطلب المحفوظ. حالته: '+labels[details.order.status] : 'تم حفظ طلب الشراء. راجع طلباتك لمتابعة التأكيد.');location.hash='orders';
  }
  async function checkout() {
    if(!mount() || state.working)return;if(!app.currentUser){app.requireLogin('store');return;}if(!state.gate){byId('storeCheckoutState').textContent='الشراء متوقف حتى تفعيل قاعدة بيانات المتجر.';return;}
    let attempt=state.attempt;try {if(!attempt){attempt={owner:context(),payload:checkoutPayload()};state.attempt=attempt;}}catch(error){byId('storeCheckoutState').textContent=explain(error);return;}
    const token={};state.working=token;byId('storeOrderReference').textContent='مرجع المحاولة: '+attempt.payload.p_order_id;lockCheckout();renderProducts();renderCart();
    try {if(!await gate(attempt.owner))throw fail('الشراء متوقف حتى تفعيل قاعدة بيانات المتجر.');if(!current(attempt.owner))return;
      let saved=await recover(attempt);const recovered=!!saved;if(!current(attempt.owner))return;if(!saved){const response=await app.client.rpc('checkout_store_order',attempt.payload);if(!current(attempt.owner))return;if(response.error)throw response.error;const summary=Array.isArray(response.data)&&response.data.length===1 ? response.data[0] : null;if(!summary || summary.id!==attempt.payload.p_order_id || !labels[summary.status] || summary.currency!=='LYD' || !integer(summary.total_minor,1,Number.MAX_SAFE_INTEGER))throw fail('لم تتأكد نتيجة حفظ الطلب.');saved=await recover(attempt);if(!current(attempt.owner))return;if(!saved || saved.order.total_minor!==summary.total_minor)throw fail('لم تتأكد تفاصيل الطلب المحفوظ.');}
      checkoutSaved(saved,attempt,recovered);
    }catch(error){if(current(attempt.owner))byId('storeCheckoutState').textContent=explain(error)+' احتُفظ بمرجع المحاولة وبياناتها. اضغط التحقق وإعادة المحاولة قبل إنشاء طلب جديد. إذا أغلقت الصفحة، راجع طلباتك قبل إعادة الإرسال.';}
    finally {if(state.working===token){state.working=null;lockCheckout();renderCart();renderProducts();}}
  }
  async function editCheckout() {
    const attempt=state.attempt;if(!attempt || state.working)return;const token={};state.working=token;lockCheckout();
    try {const saved=await recover(attempt);if(!current(attempt.owner))return;if(saved){checkoutSaved(saved,attempt,true);return;}state.attempt=null;byId('storeOrderReference').textContent='';byId('storeCheckoutState').textContent='لم يظهر طلب بهذا المرجع عند التحقق. يمكنك تعديل البيانات قبل محاولة جديدة.';}
    catch(error){if(current(attempt.owner))byId('storeCheckoutState').textContent=explain(error)+' ما زالت البيانات محفوظة لهذه المحاولة.';}
    finally {if(state.working===token){state.working=null;lockCheckout();renderCart();renderProducts();}}
  }
  function orderCard(order,items) {
    const card=el('article',undefined,'card');card.append(el('h3','طلب '+order.id),el('p',labels[order.status] || 'حالة غير مدعومة','status'),el('p','المبلغ: '+money(order.total_minor)),el('p','الدفع نقدًا عند التسليم'),el('p','تاريخ الطلب: '+String(order.created_at || '').slice(0,10)));
    if(items){items.forEach(item=>card.append(el('p',item.title+' × '+item.quantity+' — '+money(item.line_total_minor))));card.append(el('p','المستلم: '+order.customer_name),el('p','الهاتف: '+order.phone),el('p','التسليم: '+order.city+' — '+order.address));}return card;
  }
  async function loadOrders() {
    if(!mount() || !app.currentUser)return;const c=context(),version=++state.ordersVersion,list=byId('storeOrdersList');list.replaceChildren();byId('storeOrdersState').textContent='جارٍ تحميل الطلبات…';
    try {if(!await gate(c))throw fail('طلبات المتجر غير متاحة حتى تفعيل قاعدة البيانات.');if(!current(c) || version!==state.ordersVersion)return;
      const rows=await query(app.client.from('store_orders').select(orderColumns).eq('user_id',c.id).order('created_at',{ascending:false}).limit(100),c);if(!current(c) || version!==state.ordersVersion)return;
      (rows || []).filter(row=>row.user_id===c.id && uuid(row.id)).forEach(order=>{const card=orderCard(order),details=button('عرض تفاصيل الطلب',async()=>{if(!current(c) || details.disabled)return;details.disabled=true;try {const saved=await orderDetails(order.id,c);if(!current(c) || version!==state.ordersVersion)return;if(!saved)throw fail('تعذّر العثور على الطلب.');card.replaceChildren(...orderCard(saved.order,saved.items).childNodes);}catch(error){if(current(c) && version===state.ordersVersion){app.showToast(explain(error));details.disabled=false;}}});card.append(details);list.append(card);});
      byId('storeOrdersState').textContent=list.children.length ? 'أحدث طلباتك محفوظة هنا. الطلب المؤكد يظل نقدًا عند التسليم.' : 'لا توجد طلبات متجر محفوظة لهذا الحساب.';
    }catch(error){if(current(c) && version===state.ordersVersion)byId('storeOrdersState').textContent=explain(error);}
  }
  function productLock() {
    if(!state.mounted)return;const form=byId('storeProductForm'),locked=!!state.productWorking || !!state.productAttempt || !state.gate || state.role!=='admin';form.querySelectorAll('input,select').forEach(input=>{input.disabled=locked;});byId('storeSaveProduct').disabled=!!state.productWorking || !state.gate || state.role!=='admin';byId('storeSaveProduct').textContent=state.productWorking ? 'يرجى الانتظار…' : state.productAttempt ? 'التحقق وإعادة حفظ المنتج' : 'حفظ المنتج';byId('storeCancelProduct').disabled=!!state.productWorking || !!state.productAttempt;byId('storeCancelProduct').hidden=!state.productEdit;byId('storeEditProductAttempt').hidden=!state.productAttempt;byId('storeEditProductAttempt').disabled=!!state.productWorking || !state.gate || state.role!=='admin';
  }
  function resetProduct() {if(state.productWorking || state.productAttempt)return;state.productEdit=null;resetForm(byId('storeProductForm'));byId('storeProductState').textContent='';productLock();}
  function editProduct(row) {if(state.productWorking || state.productAttempt)return;resetProduct();state.productEdit=row;byId('storeProductForm').querySelectorAll('[name]').forEach(input=>{input.value=typeof row[input.name]==='boolean' ? String(row[input.name]) : row[input.name]??'';});productLock();}
  async function findProduct(attempt) {return query(app.client.from('store_products').select(productColumns).eq('id',attempt.id).maybeSingle(),attempt.owner);}
  const matchesProduct = (row,attempt) => !!row && row.id===attempt.id && Object.entries(attempt.payload).every(([key,value])=>(row[key]??null)===value);
  async function editProductAttempt() {
    const attempt=state.productAttempt;if(!attempt || state.productWorking)return;const token={};state.productWorking=token;productLock();
    try {if(!await trustedAdmin(attempt.owner) || !await gate(attempt.owner))throw fail('تعذّر تأكيد صلاحية إدارة المتجر.');if(!current(attempt.owner))return;const row=await findProduct(attempt);if(!current(attempt.owner))return;
      if(!attempt.editing && row && !matchesProduct(row,attempt))throw fail('مرجع المنتج موجود بمحتوى مختلف. حدّث الإدارة قبل تعديل المنتج.');state.productAttempt=null;state.productWorking=null;if(matchesProduct(row,attempt)){resetProduct();byId('storeProductState').textContent='تم التحقق من حفظ بيانات المنتج السابقة.';app.showToast('تم تأكيد حفظ المنتج.');await loadAdmin();return;}
      if(attempt.editing && row){state.productEdit=row;byId('storeProductForm').querySelectorAll('[name]').forEach(input=>{input.value=typeof row[input.name]==='boolean' ? String(row[input.name]) : row[input.name]??'';});byId('storeProductState').textContent='تم تحميل أحدث بيانات المنتج؛ راجعها قبل حفظ تعديل جديد.';}else if(!row){state.productEdit=null;byId('storeProductState').textContent='لم يظهر منتج بهذا المرجع عند التحقق؛ يمكنك تعديل البيانات قبل محاولة جديدة.';}else throw fail('مرجع المنتج موجود بمحتوى مختلف. حدّث الإدارة قبل تعديل المنتج.');
    }catch(error){if(current(attempt.owner))byId('storeProductState').textContent=explain(error);}
    finally {if(state.productWorking===token)state.productWorking=null;productLock();}
  }
  async function saveProduct() {
    if(!state.mounted || state.productWorking || state.role!=='admin' || !state.gate)return;let attempt=state.productAttempt;
    try {if(!attempt){const form=byId('storeProductForm'),image=clean(get(form,'image_url'),2000),priceText=get(form,'price_minor').trim(),stockText=get(form,'stock_quantity').trim(),price=Number(priceText),stock=Number(stockText);if(!/^\d+$/.test(priceText) || !/^\d+$/.test(stockText) || !integer(price,1,100000000) || !integer(stock,0,100000) || (image && !safeImage(image)))throw fail('أدخل سعرًا ومخزونًا صحيحين ورابط HTTPS صالحًا عند استخدام صورة.');
      const active=get(form,'is_active');if(!['true','false'].includes(active))throw fail('اختر حالة نشر المنتج.');const id=state.productEdit?.id || window.crypto?.randomUUID?.();if(!uuid(id))throw fail('تعذّر إنشاء مرجع المنتج.');attempt={owner:context(),id,expected:state.productEdit?.updated_at || null,editing:!!state.productEdit,payload:Object.freeze({title:clean(get(form,'title'),160,2),description:clean(get(form,'description'),2000)||null,category:clean(get(form,'category'),80)||null,image_url:image ? safeImage(image) : null,price_minor:price,stock_quantity:stock,is_active:active==='true'})};state.productAttempt=attempt;}}
    catch(error){byId('storeProductState').textContent=explain(error);return;}
    const token={};state.productWorking=token;productLock();
    try {if(!await trustedAdmin(attempt.owner) || !await gate(attempt.owner))throw fail('تعذّر تأكيد صلاحية إدارة المتجر.');if(!current(attempt.owner))return;let row=await findProduct(attempt);if(!current(attempt.owner))return;
      if(!matchesProduct(row,attempt)){if(attempt.editing && (!row || row.updated_at!==attempt.expected))throw fail('تغيّر المنتج منذ فتحه. حدّث الإدارة قبل إعادة التعديل.');if(!attempt.editing && row)throw fail('مرجع المنتج موجود بمحتوى مختلف.');const operation=attempt.editing ? app.client.from('store_products').update(attempt.payload).eq('id',attempt.id).eq('updated_at',attempt.expected) : app.client.from('store_products').insert({id:attempt.id,...attempt.payload});row=await query(operation.select(productColumns).single(),attempt.owner);if(!current(attempt.owner))return;if(!matchesProduct(row,attempt))throw fail('لم يتأكد حفظ المنتج.');}
      state.productAttempt=null;state.productWorking=null;resetProduct();app.showToast('تم تأكيد حفظ المنتج.');await loadAdmin();
    }catch(error){if(current(attempt.owner))byId('storeProductState').textContent=explain(error)+' احتُفظ بمرجع الحفظ وبياناته؛ تحقق وأعد المحاولة.';}
    finally {if(state.productWorking===token){state.productWorking=null;productLock();}}
  }
  async function reviewOrder(order,next,c,controls) {
    if(!current(c) || state.reviews.has(order.id))return;state.reviews.add(order.id);controls.forEach(control=>{control.disabled=true;});
    try {if(!await trustedAdmin(c) || !await gate(c))throw fail('تعذّر تأكيد صلاحية إدارة المتجر.');if(!current(c))return;
      const response=await app.client.rpc('transition_store_order',{p_order_id:order.id,p_expected_status:order.status,p_new_status:next});if(!current(c))return;if(response.error)throw response.error;const row=Array.isArray(response.data)&&response.data.length===1 ? response.data[0] : null;if(!row || row.id!==order.id || row.status!==next || row.currency!=='LYD' || row.total_minor!==order.total_minor)throw fail('لم يتأكد قرار مراجعة الطلب. حدّث القائمة قبل المحاولة مجددًا.');
      app.showToast('تم تأكيد حالة الطلب: '+labels[next]);await loadAdmin();
    }catch(error){if(current(c))app.showToast(explain(error));}
    finally {if(current(c)){state.reviews.delete(order.id);controls.forEach(control=>{control.disabled=false;});}}
  }
  async function loadAdmin() {
    if(!mount() || !app.currentUser)return;const c=context(),version=++state.adminVersion,panel=byId('storeAdminPanel');panel.hidden=true;byId('storeAdminProducts').replaceChildren();byId('storeAdminOrders').replaceChildren();byId('storeAdminState').textContent='جارٍ التحقق من صلاحية الإدارة…';
    try {if(!await trustedAdmin(c))throw fail('إدارة المتجر متاحة للحسابات المعتمدة للإدارة فقط.');if(!current(c) || version!==state.adminVersion)return;state.gate=await gate(c);if(!current(c) || version!==state.adminVersion)return;if(!state.gate)throw fail('إدارة المتجر متوقفة حتى تفعيل قاعدة بيانات المتجر.');
      const results=await Promise.allSettled([query(app.client.from('store_products').select(productColumns).order('created_at',{ascending:false}).limit(200),c),query(app.client.from('store_orders').select(orderColumns).order('created_at',{ascending:false}).limit(100),c)]);if(!current(c) || version!==state.adminVersion)return;
      panel.hidden=false;byId('storeAdminState').textContent='المنتجات والطلبات متاحة للمراجعة بحساب الإدارة.';productLock();
      if(results[0].status==='fulfilled'){state.adminProducts=(results[0].value||[]).filter(validProduct);state.adminProducts.forEach(row=>{const card=el('article',undefined,'card');card.append(el('h3',row.title),el('p',money(row.price_minor)),el('p','المخزون: '+row.stock_quantity),el('p',row.is_active ? 'منشور' : 'غير منشور'),button('تعديل المنتج',()=>editProduct(row)));byId('storeAdminProducts').append(card);});if(!state.adminProducts.length)byId('storeAdminProducts').textContent='لا توجد منتجات مسجلة.';}else byId('storeAdminProducts').textContent='تعذّر تحميل المنتجات.';
      if(results[1].status==='fulfilled'){(results[1].value||[]).filter(row=>uuid(row.id)).forEach(order=>{const card=orderCard(order),controls=[],transitions=order.status==='pending' ? [['تأكيد الطلب','confirmed'],['إلغاء الطلب','cancelled']] : order.status==='confirmed' ? [['إكمال الطلب','completed'],['إلغاء الطلب','cancelled']] : [];card.append(el('p',order.customer_name),el('p',order.phone),el('p',order.city+' — '+order.address));transitions.forEach(([label,next])=>{const control=button(label,()=>void reviewOrder(order,next,c,controls));controls.push(control);card.append(control);});
        const content=el('div'),details=button('عرض منتجات الطلب',async()=>{if(!current(c) || details.disabled)return;details.disabled=true;try {if(!await trustedAdmin(c))throw fail('تعذّر تأكيد صلاحية إدارة المتجر.');if(!current(c))return;const saved=await orderDetails(order.id,c,order.user_id);if(!current(c) || version!==state.adminVersion)return;if(!saved)throw fail('تعذّر العثور على الطلب.');content.replaceChildren();saved.items.forEach(item=>content.append(el('p',item.title+' × '+item.quantity+' — '+money(item.line_total_minor))));}catch(error){if(current(c) && version===state.adminVersion){app.showToast(explain(error));details.disabled=false;}}});card.append(details,content);byId('storeAdminOrders').append(card);});if(!byId('storeAdminOrders').children.length)byId('storeAdminOrders').textContent='لا توجد طلبات متجر للمراجعة.';}else byId('storeAdminOrders').textContent='تعذّر تحميل طلبات المتجر.';
    }catch(error){if(current(c) && version===state.adminVersion){byId('storeAdminState').textContent=explain(error);state.role=null;panel.hidden=true;productLock();}}
  }
  function clearPrivate() {
    state.epoch++;state.catalogVersion++;state.ordersVersion++;state.adminVersion++;state.cart.clear();state.attempt=null;state.working=null;state.productAttempt=null;state.productWorking=null;state.productEdit=null;state.role=null;state.gate=false;state.adminProducts=[];state.reviews.clear();
    if(!state.mounted)return;['storeOrdersList','storeAdminProducts','storeAdminOrders'].forEach(id=>byId(id).replaceChildren());['storeCheckoutState','storeOrderReference','storeOrdersState','storeAdminState','storeProductState'].forEach(id=>{byId(id).textContent='';});resetForm(byId('storeCheckoutForm'));resetForm(byId('storeProductForm'));byId('storeAdminPanel').hidden=true;renderCart();renderProducts();productLock();
    if(app.authReady && location.hash.replace(/^#/,'').split('?')[0]==='store')void loadStore();
  }
  app.registerRoute('store',{requiresAuth:false,onEnter:loadStore});app.registerRoute('orders',{requiresAuth:true,onEnter:loadOrders});app.registerRoute('store-admin',{requiresAuth:true,onEnter:loadAdmin});app.onUserChange(clearPrivate);app.onReady(()=>{mount();});
})();
