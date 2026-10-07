'use strict';
(() => {
  const app = window.NurseApp;
  if (!app) return;
  const titles = {home:'خدمات التمريض والرعاية',login:'تسجيل الدخول',register:'إنشاء حساب',booking:'طلب الرعاية',bookings:'حجوزاتي',profile:'حسابي',forgot:'استعادة الحساب',password:'تغيير كلمة المرور',providers:'مقدّمو الرعاية',organizations:'المؤسسات الصحية',jobs:'الوظائف',courses:'الدورات',workspace:'طلبات الاعتماد',admin:'مراجعة الإدارة',publish:'نشر الفرص','care-profile':'ملفي العام',messages:'الرسائل الخاصة',store:'متجر المستلزمات',orders:'طلبات الشراء','store-admin':'إدارة المتجر',contact:'تواصل معنا',privacy:'الخصوصية'};
  const updateTitle = () => {
    const page = document.querySelector('.screen:not([hidden])')?.id;
    document.title = `${titles[page] || 'الخدمات والرعاية'} | نيرس ليبيا`;
  };
  app.onReady(updateTitle);
  app.onUserChange(() => queueMicrotask(updateTitle));
  window.addEventListener('hashchange', () => queueMicrotask(updateTitle));
})();
