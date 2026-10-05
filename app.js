'use strict';
const $ = id => document.getElementById(id);
let services = [];
let client, currentUser = null, pendingService = '', toastTimer;
let bookingVersion = 0, profileVersion = 0, authReady = false, recovery = false;
const callbackUrl = () => location.origin + location.pathname;
function showToast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 10000);
}
function errorMessage(error) {
  if (error?.code === 'invalid_credentials') return 'البريد الإلكتروني أو كلمة المرور غير صحيحة.';
  if (error?.code === 'email_not_confirmed') return 'يرجى تأكيد بريدك الإلكتروني قبل الدخول.';
  if (error?.code === 'weak_password') return 'اختر كلمة مرور أقوى تحتوي على أحرف وأرقام ورموز.';
  if (error?.code === 'same_password') return 'اختر كلمة مرور مختلفة عن الحالية.';
  if (error?.status === 429 || /rate.*limit/i.test(error?.message || '')) return 'محاولات كثيرة؛ يرجى الانتظار قبل المحاولة مجددًا.';
  return 'تعذّر إتمام العملية. تحقق من الاتصال وحاول مجددًا.';
}
async function busy(container, task) {
  const button = container.querySelector('button');
  if (button.disabled) return;
  button.disabled = true;
  const original = button.textContent;
  button.textContent = 'يرجى الانتظار…';
  container.setAttribute('aria-busy', 'true');
  try {
    if (!client || !authReady) throw new Error('Service unavailable');
    await task();
  } catch (error) { showToast(errorMessage(error)); }
  finally { button.disabled = false; button.textContent = original; container.removeAttribute('aria-busy'); }
}
function today() {
  const parts = new Intl.DateTimeFormat('en', {timeZone:'Africa/Tripoli', year:'numeric', month:'2-digit', day:'2-digit'}).formatToParts(new Date());
  return ['year','month','day'].map(type => parts.find(p => p.type === type).value).join('-');
}
function identityUI(profile) {
  const name = profile?.full_name || currentUser?.user_metadata?.full_name || currentUser?.email?.split('@')[0] || '';
  $('welcomeName').textContent = currentUser ? `أهلًا ${name}` : 'الرعاية أقرب إليك.';
  $('profileName').textContent = name;
  $('profileEmail').textContent = currentUser?.email || '';
  // Names and phone numbers are display data only; metadata never grants privileges.
  if (!$('bookingName').value) $('bookingName').value = name;
  if (!$('bookingPhone').value) $('bookingPhone').value = profile?.phone || currentUser?.user_metadata?.phone || '';
  $('accountLink').textContent = currentUser ? 'حسابي' : 'تسجيل الدخول';
}
function setUser(user) {
  const changed = currentUser?.id !== user?.id;
  currentUser = user || null;
  if (changed) {
    bookingVersion++; profileVersion++;
    $('bookingsList').replaceChildren();
    $('bookingForm').reset();
    $('passwordForm').reset();
    $('profileState').textContent = '';
  }
  identityUI();
  return changed;
}
async function loadProfile() {
  if (!currentUser) return;
  const version = ++profileVersion, id = currentUser.id;
  try {
    const {data,error} = await client.from('profiles').select('full_name,phone').eq('id', id).single();
    if (version !== profileVersion || currentUser?.id !== id) return;
    if (error) throw error;
    identityUI(data);
    $('profileState').textContent = '';
  } catch {
    if (version === profileVersion) $('profileState').textContent = 'تعذّر تحميل بيانات الملف الشخصي. بيانات الدخول ما زالت متاحة؛ حاول لاحقًا.';
  }
}
function route() {
  if (!authReady) return;
  let page = recovery ? 'password' : location.hash.slice(1) || 'home';
  const servicesAnchor = page === 'services';
  if (servicesAnchor) page = 'home';
  if (!['home','login','register','booking','bookings','profile','forgot','password'].includes(page)) page = 'home';
  if (['booking','bookings','profile','password'].includes(page) && !currentUser) {
    page = 'login'; history.replaceState(null,'','#login');
  }
  document.querySelectorAll('.screen').forEach(el => { el.hidden = el.id !== page; });
  document.querySelectorAll('nav a').forEach(el => {
    if (el.hash === `#${page}`) el.setAttribute('aria-current','page');
    else el.removeAttribute('aria-current');
  });
  if (page === 'bookings') void loadBookings();
  if (page === 'profile') void loadProfile();
  if (page === 'booking') { $('bookingDate').min = today(); if (pendingService) $('bookingService').value = pendingService; }
  if (servicesAnchor) $('services').scrollIntoView({block:'start'});
  else { window.scrollTo(0,0); $('main').focus({preventScroll:true}); }
}
function renderServices() {
$('serviceGrid').replaceChildren(); $('bookingService').replaceChildren();
services.forEach(([name, description], index) => {
  const card = document.createElement('article'); card.className = 'card';
  const number = document.createElement('span'); number.className = 'service-number'; number.textContent = `0${index+1}`;
  const title = document.createElement('h3'); title.textContent = name;
  const p = document.createElement('p'); p.textContent = description;
  const button = document.createElement('button'); button.className = 'secondary'; button.textContent = 'طلب الخدمة';
  button.onclick = () => { pendingService = name; location.hash = currentUser ? 'booking' : 'login'; };
  card.append(number,title,p,button); $('serviceGrid').append(card);
  $('bookingService').add(new Option(name,name));
});
}
async function loadServices() {
  $('serviceGrid').textContent = 'جارٍ تحميل الخدمات…';
  try {
    if (!client) throw new Error('Unavailable');
    const {data,error} = await client.from('services').select('name,description').eq('is_active',true).order('sort_order',{ascending:true});
    if (error) throw error;
    services = (data || []).map(item => [item.name,item.description || 'طلب تنسيق الخدمة']);
    renderServices();
    if (!services.length) $('serviceGrid').textContent = 'لا توجد خدمات متاحة حاليًا.';
  } catch {
    services = []; $('bookingService').replaceChildren(); $('serviceGrid').textContent = 'تعذّر تحميل الخدمات. ';
    const retry = document.createElement('button'); retry.className = 'secondary'; retry.textContent = 'إعادة المحاولة';
    retry.onclick = () => { if (client) void loadServices(); else location.reload(); }; $('serviceGrid').append(retry);
  }
}
function onForm(id, task) {
  $(id).onsubmit = event => { event.preventDefault(); const form = event.currentTarget; void busy(form, () => task(form, new FormData(form))); };
}
onForm('loginForm', async (form,v) => {
  const {data,error} = await client.auth.signInWithPassword({email:v.get('email').trim(), password:v.get('password')});
  if (error) throw error;
  if (!data.session) throw new Error('No session');
  setUser(data.session.user); void loadProfile(); form.reset();
  location.hash = pendingService ? 'booking' : 'home'; showToast('تم تسجيل الدخول بنجاح.');
});
onForm('registerForm', async (form,v) => {
  const name = v.get('name').trim(), phone = v.get('phone').trim();
  if (!name || !phone) { showToast('يرجى إدخال الاسم ورقم الهاتف.'); return; }
  const {data,error} = await client.auth.signUp({email:v.get('email').trim(),password:v.get('password'),options:{emailRedirectTo:callbackUrl(),data:{full_name:name,phone,role:'patient',requested_role:v.get('role')}}});
  if (error) throw error;
  form.reset();
  if (data.session) { setUser(data.session.user); void loadProfile(); location.hash = pendingService ? 'booking' : 'home'; showToast('تم إنشاء الحساب وتسجيل الدخول.'); }
  else { location.hash = 'login'; showToast('راجع بريدك لإكمال التسجيل. إذا كان لديك حساب بالفعل، سجّل الدخول.'); }
});
onForm('forgotForm', async (form,v) => {
  const {error} = await client.auth.resetPasswordForEmail(v.get('email').trim(), {redirectTo:callbackUrl()});
  if (error) throw error;
  form.reset(); $('resetNotice').textContent = 'إذا كان البريد مرتبطًا بحساب، ستصلك رسالة لإعادة تعيين كلمة المرور. تحقق أيضًا من البريد غير المرغوب فيه.';
});
onForm('passwordForm', async (form,v) => {
  if (v.get('password') !== v.get('confirm')) { showToast('كلمتا المرور غير متطابقتين.'); return; }
  if (!currentUser) { location.hash = 'forgot'; return; }
  const {error} = await client.auth.updateUser({password:v.get('password')});
  if (error) throw error;
  recovery = false; form.reset(); location.hash = 'profile'; showToast('تم حفظ كلمة المرور الجديدة.');
});
onForm('bookingForm', async (form,v) => {
  if (!currentUser) {location.hash = 'login'; return;}
  const name = v.get('name').trim(), phone = v.get('phone').trim();
  if (!name || !phone || !services.some(([name]) => name === v.get('service'))) {showToast('يرجى التحقق من بيانات الحجز.');return;}
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.get('date')) || v.get('date') < today()) {showToast('اختر اليوم أو تاريخًا قادمًا.');return;}
  const userId = currentUser.id;
  const {error} = await client.from('bookings').insert({user_id:userId,service:v.get('service'),patient_name:name,phone,booking_date:v.get('date'),notes:v.get('notes').trim(),status:'pending'});
  if (currentUser?.id !== userId) return;
  if (error) {showToast('لم يتم تأكيد حفظ الطلب. تحقق من حجوزاتك قبل المحاولة مجددًا لتجنّب التكرار.');return;}
  form.reset(); pendingService = ''; identityUI(); location.hash = 'bookings'; showToast('تم إرسال طلب الحجز وهو قيد المراجعة.');
});
async function loadBookings() {
  const version = ++bookingVersion;
  if (!currentUser || !client) return;
  const list = $('bookingsList'); list.textContent = 'جارٍ تحميل الحجوزات…';
  try {
    const {data,error} = await client.from('bookings').select('id,service,booking_date,status').eq('user_id',currentUser.id).order('created_at',{ascending:false}).limit(100);
    if (version !== bookingVersion) return;
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
      heading.textContent = booking.service; date.dateTime = booking.booking_date; date.textContent = booking.booking_date;
      details.append(heading,date);
      const status = document.createElement('span'); status.className = 'status';
      const canonical = Object.keys(statuses).find(key => key === booking.status || statuses[key] === booking.status);
      status.dataset.status = canonical || 'unknown'; status.textContent = statuses[canonical] || booking.status || 'غير محدد';
      card.append(details,status); list.append(card);
    });
    if (data.length === 100) {const p = document.createElement('p');p.textContent = 'يتم عرض أحدث 100 طلب.';list.append(p);}
  } catch { if (version === bookingVersion) list.textContent = 'تعذّر تحميل الحجوزات. اضغط تحديث للمحاولة مجددًا.'; }
}
$('refreshBookings').onclick = () => void busy($('bookings'), loadBookings);
$('logoutButton').onclick = () => void busy($('profile'), async () => {
  const {error} = await client.auth.signOut(); if(error) throw error;
  recovery = false; setUser(null); pendingService = ''; location.hash = 'home'; showToast('تم تسجيل الخروج.');
});
window.addEventListener('hashchange', route);
async function init() {
  const callback = new URLSearchParams(location.hash.slice(1));
  const callbackError = callback.has('error') || callback.has('error_code');
  try {
    if (!window.supabase || !window.NURSE_LIBYA_CONFIG) throw new Error('SDK not loaded');
    const config = window.NURSE_LIBYA_CONFIG;
    client = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey);
    // Keep the listener synchronous: async Supabase calls in it can deadlock.
    client.auth.onAuthStateChange((event,session) => {
      const changed = setUser(session?.user || null);
      if (event === 'PASSWORD_RECOVERY') recovery = true;
      if (event === 'SIGNED_OUT') recovery = false;
      setTimeout(() => {
        if (changed && currentUser) void loadProfile();
        if (authReady && (changed || event === 'PASSWORD_RECOVERY')) route();
      },0);
    });
    const {data,error} = await client.auth.getSession();
    if (error) throw error;
    setUser(data.session?.user || null);
    if (data.session && callback.get('type') === 'recovery') recovery = true;
    if (currentUser) void loadProfile();
  } catch {
    client = null;
    $('connection').textContent = 'تعذّر تحميل خدمة الحسابات. أعد تحميل الصفحة للمحاولة مجددًا.';
    $('connection').hidden = false;
  }
  if (callbackError) { history.replaceState(null,'',location.pathname+'#login'); showToast('رابط التأكيد غير صالح أو انتهت صلاحيته. اطلب رابطًا جديدًا أو حاول تسجيل الدخول.'); }
  authReady = true; route(); void loadServices();
}
void init();
