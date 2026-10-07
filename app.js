'use strict';
const $ = id => document.getElementById(id);
let services = [];
let servicesLoaded = false;
let client, currentUser = null, pendingService = '', pendingPage = '', pendingProviderId = '', toastTimer;
let bookingVersion = 0, profileVersion = 0, userVersion = 0, authEventVersion = 0, serviceVersion = 0, routeVersion = 0;
let authReady = false, recovery = false, profileCache = null, profileDirty = false, bookingAttempt = null;
const busyTasks = new Map(), readyListeners = new Set(), userListeners = new Set();
const extraRoutes = new Map();
const corePages = new Set(['home','login','register','booking','bookings','profile','forgot','password','privacy','contact']);
const privatePages = new Set(['booking','bookings','profile','password']);
const validPage = page => /^[a-z][a-z0-9-]*$/.test(page || '') && (corePages.has(page) || extraRoutes.has(page));
const isCurrent = (id, version) => currentUser?.id === id && userVersion === version;
const westernDigits = value => String(value || '').replace(/[٠-٩]/g, ch => String(ch.charCodeAt(0)-1632)).replace(/[۰-۹]/g, ch => String(ch.charCodeAt(0)-1776));
function validName(value) {
  const name = String(value || '').normalize('NFC').trim();
  let letters = 0;
  for (const ch of name) {
    if (ch === '\u0640' || /\p{M}/u.test(ch) || /[\s'’.-]/u.test(ch)) continue;
    if (!/\p{L}/u.test(ch) || !/[\p{Script=Arabic}\p{Script=Latin}]/u.test(ch)) return null;
    letters++;
  }
  return letters >= 2 && name.length <= 100 ? name : null;
}
function validPhone(value) {
  const phone = westernDigits(value).replace(/[\s()-]/g,'');
  return /^\+?\d{8,15}$/.test(phone) && !/^(\+?)(\d)\2+$/.test(phone) ? phone : null;
}
function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const [year,month,day] = value.split('-').map(Number);
  const days = [31,year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,31,30,31,30,31,31,30,31,30,31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month-1];
}
function today() {
  const parts = new Intl.DateTimeFormat('en', {timeZone:'Africa/Tripoli',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  return ['year','month','day'].map(type => parts.find(p => p.type === type).value).join('-');
}
function showToast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message; $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; },10000);
}
function errorMessage(error) {
  if (error?.code === 'invalid_credentials') return 'البريد الإلكتروني أو كلمة المرور غير صحيحة.';
  if (error?.code === 'email_not_confirmed') return 'يرجى تأكيد بريدك الإلكتروني قبل الدخول.';
  if (error?.code === 'weak_password') return 'اختر كلمة مرور أقوى تحتوي على أحرف وأرقام ورموز.';
  if (error?.code === 'same_password') return 'اختر كلمة مرور مختلفة عن الحالية.';
  if (error?.status === 429 || /rate.*limit/i.test(error?.message || '')) return 'محاولات كثيرة؛ يرجى الانتظار قبل المحاولة مجددًا.';
  return 'تعذّر إتمام العملية. تحقق من الاتصال وحاول مجددًا.';
}
function releaseBusy(container, token) {
  if (busyTasks.get(container) !== token) return;
  busyTasks.delete(container);
  token.controls.forEach(([el,disabled]) => { el.disabled = disabled; });
  token.button.textContent = token.label; container.removeAttribute('aria-busy');
  if (container.id === 'bookingForm') bookingAttemptUI();
}
async function busy(container, task) {
  if (!container || busyTasks.has(container)) return;
  const button = container.tagName === 'BUTTON' ? container : container.querySelector('button[type="submit"],button:not([type])') || container.querySelector('button');
  if (!button || button.disabled) return;
  const controls = container.tagName === 'BUTTON' ? [container] : [...container.querySelectorAll('input,select,textarea,button')];
  const token = {button,label:button.textContent,controls:controls.map(el => [el,el.disabled]),version:userVersion};
  busyTasks.set(container,token);
  controls.forEach(el => { el.disabled = true; });
  button.textContent = 'يرجى الانتظار…'; container.setAttribute('aria-busy','true');
  try {
    if (!client || !authReady) throw new Error('Service unavailable');
    await task({isActive:() => busyTasks.get(container) === token,version:token.version});
  } catch (error) {
    if (busyTasks.get(container) === token && token.version === userVersion) showToast(errorMessage(error));
  } finally { releaseBusy(container,token); }
}
function notify(listeners, ...args) {
  listeners.forEach(fn => { try { fn(...args); } catch { console.error('NurseApp callback failed'); } });
}
function identityUI(profile = profileCache) {
  const name = profile?.full_name || currentUser?.user_metadata?.full_name || currentUser?.email?.split('@')[0] || '';
  $('welcomeName').textContent = currentUser ? 'أهلًا ' + name : 'الرعاية أقرب إليك.';
  $('profileName').textContent = name; $('profileEmail').textContent = currentUser?.email || '';
  if (currentUser && !$('bookingName').value) $('bookingName').value = name;
  if (currentUser && !$('bookingPhone').value) $('bookingPhone').value = profile?.phone || currentUser?.user_metadata?.phone || '';
  $('accountLink').textContent = currentUser ? 'حسابي' : 'تسجيل الدخول';
}
function setUser(user) {
  const previousId = currentUser?.id || null, nextId = user?.id || null;
  const changed = previousId !== nextId;
  currentUser = user || null;
  if (changed) {
    userVersion++; bookingVersion++; profileVersion++;
    profileCache = null; profileDirty = false; bookingAttempt = null;
    [...busyTasks].forEach(([container,token]) => releaseBusy(container,token));
    ['bookingForm','passwordForm','profileForm','loginForm','registerForm'].forEach(id => $(id)?.reset());
    $('bookingsList').replaceChildren(); $('profileState').textContent = '';
    if ($('profileSaveState')) $('profileSaveState').textContent = '';
    if ($('bookingState')) $('bookingState').textContent = '';
    if ($('bookingReference')) $('bookingReference').textContent = '';
    $('toast').textContent = ''; $('toast').hidden = true; clearTimeout(toastTimer);
    if (previousId) { pendingService = ''; pendingProviderId = ''; pendingPage = ''; }
    bookingAttemptUI();
  }
  identityUI();
  if (changed) notify(userListeners,currentUser,userVersion);
  return changed;
}
function fillProfileForm(profile) {
  const form = $('profileForm');
  if (!form || profileDirty) return;
  const name = form.querySelector('[name="full_name"]'), phone = form.querySelector('[name="phone"]');
  if (name) name.value = profile?.full_name || '';
  if (phone) phone.value = profile?.phone || '';
}
async function loadProfile() {
  if (!currentUser || !client) return;
  const version = ++profileVersion, id = currentUser.id, owner = userVersion;
  try {
    const {data,error} = await client.from('profiles').select('full_name,phone').eq('id',id).single();
    if (version !== profileVersion || !isCurrent(id,owner)) return;
    if (error || !data) throw error || new Error('Missing profile');
    profileCache = data; identityUI(data); fillProfileForm(data); $('profileState').textContent = '';
  } catch {
    if (version === profileVersion && isCurrent(id,owner)) $('profileState').textContent = 'تعذّر تحميل بيانات الملف الشخصي. بيانات الدخول ما زالت متاحة؛ حاول لاحقًا.';
  }
}
function callbackUrl() {
  const query = new URLSearchParams();
  if (validPage(pendingPage)) query.set('return',pendingPage);
  if (pendingService && (!pendingPage || pendingPage === 'booking')) {
    query.set('return','booking'); query.set('service',pendingService);
    if (pendingProviderId) query.set('provider',pendingProviderId);
  }
  return location.origin + location.pathname + (query.toString() ? '?' + query.toString() : '');
}
function uuid() {
  const secure = window.crypto || document.defaultView?.crypto;
  if (secure?.randomUUID) return secure.randomUUID();
  if (!secure?.getRandomValues) throw new Error('Secure random unavailable');
  const bytes = secure.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6]&15)|64; bytes[8] = (bytes[8]&63)|128;
  const h = [...bytes].map(b => b.toString(16).padStart(2,'0')).join('');
  return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);
}
const validUuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value || '');
function bookableService(value) {
  if (!servicesLoaded) return null;
  const slugMatches = services.filter(([,,slug]) => slug && slug === value);
  const matches = slugMatches.length ? slugMatches : services.filter(([name]) => name === value);
  if (matches.length !== 1 || services.filter(([name]) => name === matches[0][0]).length !== 1) return null;
  return matches[0];
}
function resumeAfterAuth() {
  if (!currentUser || recovery) return;
  // A deferred module can register its intended page after initial auth finishes.
  if (pendingPage && !validPage(pendingPage)) return;
  const target = validPage(pendingPage) ? pendingPage : pendingService ? 'booking' : 'home';
  const query = new URLSearchParams();
  if (target === 'booking' && pendingPage === 'booking' && pendingService) {
    query.set('service',pendingService); if (pendingProviderId) query.set('provider',pendingProviderId);
  }
  pendingPage = '';
  location.hash = target + (query.toString() ? '?' + query.toString() : '');
}
function requireLogin(returnPage = 'profile') {
  pendingPage = validPage(returnPage) ? returnPage : 'profile';
  location.hash = 'login'; route();
}
function chooseService(nameOrSlug, options = {}) {
  const found = bookableService(nameOrSlug);
  if (servicesLoaded && !found) { showToast('تعذّر تحديد خدمة واحدة متاحة للحجز. اختر خدمة أخرى أو تواصل مع الفريق.'); return; }
  pendingService = found ? found[0] : String(nameOrSlug || '');
  pendingProviderId = validUuid(options.providerProfileId) ? options.providerProfileId : '';
  pendingPage = 'booking';
  if (currentUser) resumeAfterAuth(); else requireLogin('booking');
}
function route() {
  if (!authReady) return;
  const version = ++routeVersion;
  const [rawPage,rawSearch = ''] = (location.hash || '').replace(/^#/,'').split('?');
  const search = new URLSearchParams(rawSearch);
  if (rawPage === 'booking' && search.has('service') && !bookingAttempt) {
    pendingService = search.get('service') || ''; pendingProviderId = validUuid(search.get('provider')) ? search.get('provider') : '';
  }
  let page = recovery ? 'password' : rawPage || 'home';
  const servicesAnchor = page === 'services';
  if (servicesAnchor) page = 'home';
  if (!validPage(page)) page = 'home';
  if ((privatePages.has(page) || extraRoutes.get(page)?.requiresAuth) && !currentUser) {
    pendingPage = page; page = 'login'; history.replaceState(null,'','#login');
  }
  document.querySelectorAll('.screen').forEach(el => { el.hidden = el.id !== page; });
  document.querySelectorAll('nav a').forEach(el => {
    if (el.hash === '#' + page) el.setAttribute('aria-current','page'); else el.removeAttribute('aria-current');
  });
  if (page === 'bookings') void loadBookings();
  if (page === 'profile') void loadProfile();
  if (page === 'booking') { $('bookingDate').min = today(); applyPendingService(); bookingAttemptUI(); }
  const extra = extraRoutes.get(page);
  if (extra?.onEnter) { try { Promise.resolve(extra.onEnter(window.NurseApp)).catch(() => showToast('تعذّر تحميل الصفحة. حاول مجددًا.')); } catch { showToast('تعذّر تحميل الصفحة. حاول مجددًا.'); } }
  if (servicesAnchor) $('services').scrollIntoView({block:'start'});
  else {
    window.scrollTo(0,0); $('main').focus({preventScroll:true});
    // Native fragment scrolling can run after hashchange; restore the header afterward.
    if (window.requestAnimationFrame) window.requestAnimationFrame(() => window.requestAnimationFrame(() => { if (version === routeVersion) window.scrollTo(0,0); }));
  }
}
function applyPendingService() {
  if (bookingAttempt) return;
  if (!servicesLoaded) {
    $('bookingService').value = '';
    if (pendingService && $('bookingState')) $('bookingState').textContent = 'جارٍ التحقق من الخدمة المرتبطة بهذا الرابط…';
    return;
  }
  const found = bookableService(pendingService);
  if (found) { pendingService = found[0]; $('bookingService').value = found[0]; if ($('bookingState')) $('bookingState').textContent = ''; }
  else if (pendingService) {
    $('bookingService').value = ''; pendingProviderId = '';
    if ($('bookingState')) $('bookingState').textContent = 'الخدمة المرتبطة بهذا الرابط غير متاحة للحجز حاليًا. اختر خدمة متاحة من القائمة.';
  }
}
function renderServices() {
  $('serviceGrid').replaceChildren(); $('bookingService').replaceChildren();
  services.forEach(([name,description],index) => {
    const card = document.createElement('article'); card.className = 'card';
    const number = document.createElement('span'); number.className = 'service-number'; number.textContent = String(index+1).padStart(2,'0');
    const title = document.createElement('h3'); title.textContent = name;
    const p = document.createElement('p'); p.textContent = description;
    const available = !!bookableService(name);
    const button = document.createElement('button'); button.className = 'secondary'; button.textContent = available ? 'طلب الخدمة' : 'الحجز غير متاح حاليًا'; button.disabled = !available; button.onclick = () => chooseService(name);
    card.append(number,title,p,button); $('serviceGrid').append(card); if (available) $('bookingService').add(new Option(name,name));
  });
  applyPendingService(); bookingAttemptUI();
}
async function loadServices() {
  const version = ++serviceVersion; servicesLoaded = false; bookingAttemptUI(); $('serviceGrid').textContent = 'جارٍ تحميل الخدمات…';
  try {
    if (!client) throw new Error('Unavailable');
    const {data,error} = await client.from('services').select('name,description,slug').eq('is_active',true).order('sort_order',{ascending:true});
    if (version !== serviceVersion) return;
    if (error) throw error;
    services = (data || []).map(item => [item.name,item.description || 'طلب تنسيق الخدمة',item.slug]); servicesLoaded = true;
    renderServices(); if (!services.length) $('serviceGrid').textContent = 'لا توجد خدمات متاحة حاليًا.';
  } catch {
    if (version !== serviceVersion) return;
    services = []; $('bookingService').replaceChildren(); $('serviceGrid').textContent = 'تعذّر تحميل الخدمات. ';
    if ($('bookingState') && !bookingAttempt) $('bookingState').textContent = 'تعذّر تحميل الخدمات. ارجع إلى الخدمات واضغط إعادة المحاولة.';
    const retry = document.createElement('button'); retry.className = 'secondary'; retry.textContent = 'إعادة المحاولة';
    retry.onclick = () => { if (client) void loadServices(); else location.reload(); }; $('serviceGrid').append(retry);
  }
}
function bookingAttemptUI() {
  const form = $('bookingForm'), attempt = bookingAttempt;
  if (!form || busyTasks.has(form)) return;
  form.querySelectorAll('input,select,textarea').forEach(el => { el.disabled = !!attempt; });
  const button = form.querySelector('button[type="submit"],button:not([type])');
  if (button) { button.disabled = !attempt && !servicesLoaded; button.textContent = attempt ? 'التحقق وإعادة المحاولة' : 'إرسال طلب الحجز'; }
  if ($('bookingEditRequest')) { $('bookingEditRequest').hidden = !attempt; $('bookingEditRequest').disabled = false; }
  if ($('bookingReference') && attempt) $('bookingReference').textContent = 'مرجع المحاولة: ' + attempt.payload.id;
}
async function findBooking(attempt) {
  const {data,error} = await client.from('bookings').select('id,user_id,service,patient_name,phone,booking_date,notes,provider_profile_id,status').eq('user_id',attempt.payload.user_id).eq('id',attempt.payload.id).maybeSingle();
  if (error) throw error;
  if (data && (data.id !== attempt.payload.id || data.user_id !== attempt.payload.user_id ||
    ['service','patient_name','phone','booking_date'].some(key => data[key] !== attempt.payload[key]) ||
    (data.notes || '') !== attempt.payload.notes || (data.provider_profile_id || null) !== (attempt.payload.provider_profile_id || null))) throw new Error('Booking reference mismatch');
  return data;
}
function bookingSaved(attempt) {
  if (!isCurrent(attempt.payload.user_id,attempt.owner)) return;
  const reference = attempt.payload.id;
  bookingAttempt = null; $('bookingForm').reset(); pendingService = ''; pendingProviderId = ''; pendingPage = '';
  if ($('bookingReference')) $('bookingReference').textContent = 'مرجع الطلب: ' + reference;
  if ($('bookingState')) $('bookingState').textContent = 'تم حفظ طلبك وهو قيد المراجعة. يظهر تأكيد الموعد في حجوزاتك بعد المراجعة.';
  identityUI(); location.hash = 'bookings'; showToast('تم إرسال طلب الحجز وهو قيد المراجعة.'); bookingAttemptUI();
}
function onForm(id, task) {
  const form = $(id); if (!form) return;
  form.onsubmit = event => { event.preventDefault(); const values = new FormData(form); void busy(form, context => task(form,values,context)); };
}
onForm('loginForm',async (form,v,context) => {
  const version = authEventVersion;
  const {data,error} = await client.auth.signInWithPassword({email:String(v.get('email')).trim(),password:v.get('password')});
  if (!context.isActive() || version !== authEventVersion) return;
  if (error) throw error;
  if (!data?.session) throw new Error('No session');
  setUser(data.session.user); void loadProfile(); form.reset(); resumeAfterAuth(); showToast('تم تسجيل الدخول بنجاح.');
});
onForm('registerForm',async (form,v,context) => {
  const name = validName(v.get('name')), phone = validPhone(v.get('phone'));
  if (!name || !phone) { showToast('أدخل اسمًا صحيحًا ورقم هاتف من 8 إلى 15 رقمًا.'); return; }
  if (String(v.get('password') || '').length < 8) { showToast('كلمة المرور 8 أحرف على الأقل.'); return; }
  const requestedRole = ['patient','nurse','doctor','hospital'].includes(v.get('role')) ? v.get('role') : 'patient';
  const version = authEventVersion;
  const {data,error} = await client.auth.signUp({email:String(v.get('email')).trim(),password:v.get('password'),options:{emailRedirectTo:callbackUrl(),data:{full_name:name,phone,role:'patient',requested_role:requestedRole}}});
  if (!context.isActive() || version !== authEventVersion) return;
  if (error) throw error;
  form.reset();
  if (data?.session) { setUser(data.session.user); void loadProfile(); resumeAfterAuth(); showToast('تم إنشاء الحساب وتسجيل الدخول.'); }
  else { location.hash = 'login'; showToast('راجع بريدك لإكمال التسجيل. إذا كان لديك حساب بالفعل، سجّل الدخول.'); }
});
onForm('forgotForm',async (form,v,context) => {
  const version = authEventVersion;
  const {error} = await client.auth.resetPasswordForEmail(String(v.get('email')).trim(),{redirectTo:callbackUrl()});
  if (!context.isActive() || version !== authEventVersion) return;
  if (error) throw error;
  form.reset(); $('resetNotice').textContent = 'إذا كان البريد مرتبطًا بحساب، ستصلك رسالة لإعادة تعيين كلمة المرور. تحقق أيضًا من البريد غير المرغوب فيه.';
});
onForm('passwordForm',async (form,v,context) => {
  if (v.get('password') !== v.get('confirm')) { showToast('كلمتا المرور غير متطابقتين.'); return; }
  if (String(v.get('password') || '').length < 8) { showToast('كلمة المرور 8 أحرف على الأقل.'); return; }
  if (!currentUser) { location.hash = 'forgot'; return; }
  const id = currentUser.id, owner = userVersion;
  const {error} = await client.auth.updateUser({password:v.get('password')});
  if (!context.isActive() || !isCurrent(id,owner)) return;
  if (error) throw error;
  recovery = false; form.reset();
  if (pendingPage || pendingService) resumeAfterAuth(); else location.hash = 'profile';
  showToast('تم حفظ كلمة المرور الجديدة.');
});
onForm('profileForm',async (form,v,context) => {
  if (!currentUser) return;
  const name = validName(v.get('full_name')), phone = validPhone(v.get('phone'));
  if (!name || !phone) { showToast('أدخل اسمًا صحيحًا ورقم هاتف من 8 إلى 15 رقمًا.'); return; }
  const id = currentUser.id, owner = userVersion;
  const {data,error} = await client.from('profiles').update({full_name:name,phone}).eq('id',id).select('id,full_name,phone').single();
  if (!context.isActive() || !isCurrent(id,owner)) return;
  if (error || !data || data.id !== id) throw error || new Error('Profile update not confirmed');
  profileVersion++; profileCache = {full_name:data.full_name,phone:data.phone}; profileDirty = false;
  identityUI(); fillProfileForm(profileCache);
  if ($('profileSaveState')) $('profileSaveState').textContent = 'تم حفظ بياناتك.';
  showToast('تم حفظ بيانات الملف الشخصي.');
});
if ($('profileForm')) $('profileForm').oninput = () => { profileDirty = true; if ($('profileSaveState')) $('profileSaveState').textContent = ''; };
onForm('bookingForm',async (form,v,context) => {
  if (!currentUser) { requireLogin('booking'); return; }
  const owner = userVersion, id = currentUser.id;
  let attempt = bookingAttempt;
  if (!attempt) {
    const name = validName(v.get('name')), phone = validPhone(v.get('phone')), date = String(v.get('date') || ''), notes = String(v.get('notes') || '').trim();
    if (!name || !phone || !bookableService(v.get('service')) || notes.length > 1000) { showToast('يرجى التحقق من الاسم ورقم الهاتف والخدمة والملاحظات.'); return; }
    if (!validDate(date) || date < today()) { showToast('اختر يومًا صالحًا اليوم أو في المستقبل.'); return; }
    const payload = {id:uuid(),user_id:id,service:v.get('service'),patient_name:name,phone,booking_date:date,notes,status:'pending'};
    if (pendingProviderId) payload.provider_profile_id = pendingProviderId;
    attempt = {payload:Object.freeze(payload),owner};
    bookingAttempt = attempt;
  } else {
    if (!isCurrent(attempt.payload.user_id,attempt.owner)) return;
    try {
      const saved = await findBooking(attempt);
      if (!context.isActive() || !isCurrent(id,owner)) return;
      if (saved) { bookingSaved(attempt); return; }
    } catch {
      if (context.isActive() && isCurrent(id,owner)) showToast('تعذّر التحقق من المحاولة السابقة. احتفظنا بمرجعها وبياناتها؛ أعد المحاولة بعد عودة الاتصال.');
      return;
    }
    if (attempt.payload.booking_date < today()) { showToast('لم يظهر طلب بالمرجع السابق وقد مضى موعده. راجع حجوزاتك أو ابدأ طلبًا مختلفًا.'); return; }
  }
  try {
    const {error} = await client.from('bookings').insert(attempt.payload);
    if (!context.isActive() || !isCurrent(id,owner)) return;
    if (error) throw error;
    bookingSaved(attempt);
  } catch {
    if (!context.isActive() || !isCurrent(id,owner)) return;
    try {
      const saved = await findBooking(attempt);
      if (!context.isActive() || !isCurrent(id,owner)) return;
      if (saved) { bookingSaved(attempt); return; }
    } catch { /* The same immutable attempt remains available for recovery. */ }
    if (!context.isActive() || !isCurrent(id,owner)) return;
    if ($('bookingState')) $('bookingState').textContent = 'لم يُؤكد حفظ الطلب. أعد التحقق والمحاولة بالمرجع والبيانات نفسيهما لتجنّب تكراره.';
    showToast('لم يُؤكد حفظ الطلب. احتفظنا بمرجعه وبياناته؛ اضغط التحقق وإعادة المحاولة.');
  }
});
if ($('bookingEditRequest')) $('bookingEditRequest').onclick = () => {
  if (busyTasks.has($('bookingForm'))) return;
  bookingAttempt = null;
  if ($('bookingState')) $('bookingState').textContent = 'قد تكون المحاولة السابقة محفوظة. راجع حجوزاتك؛ الإرسال التالي سيبدأ طلبًا مختلفًا بمرجع جديد.';
  if ($('bookingReference')) $('bookingReference').textContent = '';
  bookingAttemptUI(); showToast('راجع حجوزاتك قبل إرسال طلب مختلف إذا انقطع الاتصال أثناء المحاولة السابقة.');
};
$('bookingService').onchange = () => { if (!bookingAttempt) { pendingService = $('bookingService').value; pendingProviderId = ''; if ($('bookingState')) $('bookingState').textContent = ''; } };
async function loadBookings() {
  const version = ++bookingVersion;
  if (!currentUser || !client) return;
  const id = currentUser.id, owner = userVersion, list = $('bookingsList'); list.textContent = 'جارٍ تحميل الحجوزات…';
  try {
    const {data,error} = await client.from('bookings').select('id,service,booking_date,status').eq('user_id',id).order('created_at',{ascending:false}).limit(100);
    if (version !== bookingVersion || !isCurrent(id,owner)) return;
    if (error) throw error;
    list.replaceChildren();
    if (!data?.length) {
      const empty = document.createElement('div'); empty.className = 'empty';
      const p = document.createElement('p'); p.textContent = 'لا توجد حجوزات بعد.';
      const a = document.createElement('a'); a.href = '#services'; a.className = 'button secondary'; a.textContent = 'اختر خدمة'; empty.append(p,a); list.append(empty); return;
    }
    const statuses = {pending:'قيد المراجعة',confirmed:'تم التأكيد',completed:'مكتمل',cancelled:'ملغي'};
    data.forEach(booking => {
      const card = document.createElement('article'); card.className = 'card booking-card';
      const details = document.createElement('div'), heading = document.createElement('h3'), date = document.createElement('time');
      heading.textContent = booking.service; date.dateTime = booking.booking_date; date.textContent = booking.booking_date; details.append(heading,date);
      if (booking.id) { const reference = document.createElement('small'); reference.textContent = 'مرجع الطلب: ' + booking.id; details.append(reference); }
      const status = document.createElement('span'); status.className = 'status';
      const canonical = Object.keys(statuses).find(key => key === booking.status || statuses[key] === booking.status);
      status.dataset.status = canonical || 'unknown'; status.textContent = statuses[canonical] || booking.status || 'غير محدد';
      card.append(details,status); list.append(card);
    });
    if (data.length === 100) { const p = document.createElement('p'); p.textContent = 'يتم عرض أحدث 100 طلب.'; list.append(p); }
  } catch { if (version === bookingVersion && isCurrent(id,owner)) list.textContent = 'تعذّر تحميل الحجوزات. اضغط تحديث للمحاولة مجددًا.'; }
}
$('refreshBookings').onclick = () => void busy($('refreshBookings'),loadBookings);
$('logoutButton').onclick = () => void busy($('logoutButton'),async context => {
  const id = currentUser?.id, owner = userVersion;
  const {error} = await client.auth.signOut();
  if (!context.isActive() || !isCurrent(id,owner)) return;
  if (error) throw error;
  recovery = false; setUser(null); pendingService = ''; pendingPage = ''; location.hash = 'home'; showToast('تم تسجيل الخروج.');
});
window.NurseApp = Object.freeze({
  get client() { return client; }, get currentUser() { return currentUser; }, get authReady() { return authReady; },
  get userVersion() { return userVersion; }, get profile() { return profileCache; },
  isCurrent, route, loadProfile, loadBookings, loadServices, showToast, errorMessage, busy, chooseService, requireLogin,
  registerRoute(name,options = {}) {
    if (!/^[a-z][a-z0-9-]*$/.test(name) || corePages.has(name)) throw new Error('Invalid route');
    extraRoutes.set(name,options);
    if (authReady && currentUser && pendingPage === name) { resumeAfterAuth(); route(); return; }
    if (authReady && (location.hash || '').replace(/^#/,'').split('?')[0] === name) route();
  },
  onReady(fn) { readyListeners.add(fn); if (authReady) fn(window.NurseApp); return () => readyListeners.delete(fn); },
  onUserChange(fn) { userListeners.add(fn); return () => userListeners.delete(fn); }
});
window.addEventListener('hashchange',route);
window.addEventListener('load',() => {
  if (authReady && currentUser && pendingPage && !validPage(pendingPage)) {
    pendingPage = ''; resumeAfterAuth();
  }
  route();
});
async function init() {
  const callback = new URLSearchParams((location.hash || '').replace(/^#/,''));
  const query = new URLSearchParams(location.search || '');
  const callbackError = callback.has('error') || callback.has('error_code') || query.has('error');
  const returnPage = query.get('return');
  if (/^[a-z][a-z0-9-]*$/.test(returnPage || '')) pendingPage = returnPage;
  if (pendingPage === 'booking') { pendingService = query.get('service') || ''; pendingProviderId = validUuid(query.get('provider')) ? query.get('provider') : ''; }
  try {
    if (!window.supabase || !window.NURSE_LIBYA_CONFIG) throw new Error('SDK not loaded');
    const config = window.NURSE_LIBYA_CONFIG;
    client = window.supabase.createClient(config.supabaseUrl,config.supabasePublishableKey);
    let sawEvent = false;
    client.auth.onAuthStateChange((event,session) => {
      if (event === 'INITIAL_SESSION' && sawEvent) return;
      sawEvent = true; const version = ++authEventVersion;
      const changed = setUser(session?.user || null);
      if (event === 'PASSWORD_RECOVERY') recovery = true;
      if (event === 'SIGNED_OUT') { recovery = false; pendingPage = ''; pendingService = ''; location.hash = 'home'; }
      authReady = true;
      setTimeout(() => {
        if (version !== authEventVersion) return;
        if (changed && currentUser) void loadProfile();
        const page = (location.hash || '').replace(/^#/,'').split('?')[0];
        const authEntry = ['login','register'].includes(page) && ['SIGNED_IN','INITIAL_SESSION'].includes(event);
        if (currentUser && !recovery && (authEntry || ((pendingPage || pendingService) && (!page || ['login','register'].includes(page) || callback.has('access_token'))))) resumeAfterAuth();
        if (changed || event === 'PASSWORD_RECOVERY' || event === 'INITIAL_SESSION') route();
      },0);
    });
    try {
      const {data,error} = await client.auth.getSession();
      if (!sawEvent) {
        if (error) throw error;
        setUser(data?.session?.user || null);
        if (data?.session && callback.get('type') === 'recovery') recovery = true;
        if (currentUser) void loadProfile();
      }
    } catch {
      if (!sawEvent) { setUser(null); $('connection').textContent = 'تعذّر استعادة الجلسة. يمكنك محاولة تسجيل الدخول مجددًا.'; $('connection').hidden = false; }
    }
  } catch {
    client = null; $('connection').textContent = 'تعذّر تحميل خدمة الحسابات. أعد تحميل الصفحة للمحاولة مجددًا.'; $('connection').hidden = false;
  }
  if (callbackError) { history.replaceState(null,'',location.pathname+'#login'); showToast('رابط التأكيد غير صالح أو انتهت صلاحيته. اطلب رابطًا جديدًا أو حاول تسجيل الدخول.'); }
  authReady = true; notify(readyListeners,window.NurseApp);
  if (currentUser && !recovery && (pendingPage || pendingService)) resumeAfterAuth();
  route(); void loadServices();
}
void init();
