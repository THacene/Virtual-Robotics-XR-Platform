/**
 * autoGrab.js
 * 
 * يضع دالة window.autoGrab() في الـ console
 * تقوم بتقليل slider الـ sOpen تدريجياً (تغلق الأصابع)
 * حتى يظهر الـ grab (اللون الأخضر في tStatus)
 * 
 * الاستخدام في console:
 *   autoGrab()               // إعدادات افتراضية
 *   autoGrab({ step: 1, interval: 60, minVal: 14 })  // مخصص
 */

(function () {

  /**
   * الإعدادات الافتراضية
   * step      : كم وحدة نقلل slider كل مرة (كلما قل = أبطأ وأدق)
   * interval  : الفترة الزمنية بين كل خطوة (ms)
   * minVal    : أدنى قيمة للـ slider قبل الاستسلام
   * timeout   : أقصى وقت للمحاولة (ms) قبل الإلغاء
   */
  const DEFAULTS = {
    step:     1,
    interval: 80,
    minVal:   14,
    timeout:  15000,
  };

  /**
   * يتحقق هل الـ grab نجح
   * المنطق: tStatus يحتوي على "GRAB" أو يكون لونه أخضر
   */
  function isGrabbed() {
    const statusEl = document.getElementById('tStatus');
    if (!statusEl) return false;

    const text  = statusEl.textContent?.toUpperCase() ?? '';
    const color = statusEl.style.color ?? '';
    const bg    = statusEl.style.background ?? statusEl.style.backgroundColor ?? '';

    // نتحقق من النص أو اللون الأخضر
    return (
      text.includes('GRAB') ||
      color.includes('0, 170') ||   // rgb أخضر
      bg.includes('0, 170')   ||
      bg.includes('#00aa')    ||
      color.includes('#00aa') ||
      // fallback: indB يحتوي على نسبة قوة عالية
      _checkForceIndicator()
    );
  }

  /**
   * fallback: يتحقق من مؤشر القوة في الـ UI القديم
   */
  function _checkForceIndicator() {
    const indB = document.getElementById('indB');
    if (!indB) return false;
    const match = indB.textContent.match(/(\d+)%/);
    if (!match) return false;
    return parseInt(match[1]) >= 60; // 60% قوة = grab ناجح
  }

  /**
   * الدالة الرئيسية
   * @param {object} opts - إعدادات اختيارية { step, interval, minVal, timeout, force }
   */
  function autoGrab(opts = {}) {
    const cfg = { ...DEFAULTS, ...opts };
    const force = !!cfg.force;

    const slider = document.getElementById('sOpen');
    if (!slider) {
      console.warn('[autoGrab] ❌ لم يُوجد slider #sOpen');
      return;
    }

    // إذا كان مسبقاً في وضع grab، أخبر المستخدم
    if (isGrabbed() && !force) {
      console.log('[autoGrab] ✅ الروبوت ممسك بالفعل، لا حاجة للتدخل.');
      return;
    }

    const startVal = parseInt(slider.value);
    console.log(`[autoGrab] 🚀 بدء الغلق التلقائي | من: ${startVal} → حتى: ${cfg.minVal} | step: ${cfg.step} | interval: ${cfg.interval}ms`);

    let intervalId  = null;
    let timeoutId   = null;
    let currentVal  = startVal;

    // دالة التنظيف
    function stop(reason) {
      clearInterval(intervalId);
      clearTimeout(timeoutId);
      console.log(`[autoGrab] 🛑 توقف: ${reason} | قيمة slider النهائية: ${currentVal}`);
    }

    // تشغيل timeout للأمان
    timeoutId = setTimeout(() => {
      stop(`⏰ انتهى الوقت (${cfg.timeout}ms) دون نجاح grab`);
    }, cfg.timeout);

    // الحلقة الرئيسية
    intervalId = setInterval(() => {

      // تحقق من النجاح أولاً
      if (isGrabbed() && !force) {
        stop(`✅ GRAB ناجح! القيمة: ${currentVal}`);
        return;
      }

      // تحقق من الوصول للحد الأدنى
      if (currentVal <= cfg.minVal) {
        stop(`⚠️ وصل للحد الأدنى (${cfg.minVal}) دون grab`);
        return;
      }

      // تقليل القيمة
      currentVal = Math.max(cfg.minVal, currentVal - cfg.step);
      slider.value = currentVal;

      // إطلاق الأحداث تماماً كما يفعل المستخدم يدوياً
      slider.dispatchEvent(new Event('input',  { bubbles: true }));
      slider.dispatchEvent(new Event('change', { bubbles: true }));

    }, cfg.interval);

    // إرجاع دالة إلغاء يدوي
    return function cancel() {
      stop('🚫 إلغاء يدوي من المستخدم');
    };
  }

  // ✅ تصدير إلى window للاستخدام في console
  window.autoGrab = autoGrab;

  console.log('[autoGrab] ✅ جاهز — اكتب autoGrab() في console للتشغيل');

})();
