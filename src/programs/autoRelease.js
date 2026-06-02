/**
 * autoRelease.js
 *
 * يضع دالة window.autoRelease() في الـ console
 * تقوم بزيادة slider الـ sOpen تدريجياً (تفتح الأصابع)
 * حتى يتم الـ release (يختفي الـ grab)
 *
 * الاستخدام في console:
 *   autoRelease()                                        // إعدادات افتراضية
 *   autoRelease({ step: 1, interval: 60, maxVal: 55 })  // مخصص
 */

(function () {

  /**
   * الإعدادات الافتراضية
   * step      : كم وحدة نزيد slider كل مرة
   * interval  : الفترة الزمنية بين كل خطوة (ms)
   * maxVal    : أقصى قيمة للـ slider قبل الاستسلام
   * timeout   : أقصى وقت للمحاولة (ms) قبل الإلغاء
   */
  const DEFAULTS = {
    step:     1,
    interval: 80,
    maxVal:   55,
    timeout:  15000,
  };

  /**
   * يتحقق هل الـ grab لا يزال نشطاً
   */
  function isGrabbed() {
    const statusEl = document.getElementById('tStatus');
    if (!statusEl) return false;

    const text = statusEl.textContent?.toUpperCase() ?? '';
    const color = statusEl.style.color ?? '';
    const bg    = statusEl.style.background ?? statusEl.style.backgroundColor ?? '';

    return (
      text.includes('GRAB') ||
      color.includes('0, 170') ||
      bg.includes('0, 170')   ||
      bg.includes('#00aa')    ||
      color.includes('#00aa') ||
      _checkForceIndicator()
    );
  }

  /**
   * fallback: يتحقق من مؤشر القوة
   */
  function _checkForceIndicator() {
    const indB = document.getElementById('indB');
    if (!indB) return false;
    const match = indB.textContent.match(/(\d+)%/);
    if (!match) return false;
    return parseInt(match[1]) >= 60;
  }

  /**
   * الدالة الرئيسية
   * @param {object} opts - إعدادات اختيارية { step, interval, maxVal, timeout }
   */
  function autoRelease(opts = {}) {
    const cfg = { ...DEFAULTS, ...opts };

    const slider = document.getElementById('sOpen');
    if (!slider) {
      console.warn('[autoRelease] ❌ لم يُوجد slider #sOpen');
      return;
    }

    // إذا لم يكن هناك grab أصلاً
    if (!isGrabbed()) {
      console.log('[autoRelease] ℹ️ لا يوجد grab نشط، لا حاجة للفتح.');
      return;
    }

    const startVal = parseInt(slider.value);
    console.log(`[autoRelease] 🚀 بدء الفتح التلقائي | من: ${startVal} → حتى: ${cfg.maxVal} | step: ${cfg.step} | interval: ${cfg.interval}ms`);

    let intervalId = null;
    let timeoutId  = null;
    let currentVal = startVal;

    // دالة التنظيف
    function stop(reason) {
      clearInterval(intervalId);
      clearTimeout(timeoutId);
      console.log(`[autoRelease] 🛑 توقف: ${reason} | قيمة slider النهائية: ${currentVal}`);
    }

    // timeout للأمان
    timeoutId = setTimeout(() => {
      stop(`⏰ انتهى الوقت (${cfg.timeout}ms) دون release`);
    }, cfg.timeout);

    // الحلقة الرئيسية
    intervalId = setInterval(() => {

      // تحقق من نجاح الـ release (grab اختفى)
      if (!isGrabbed()) {
        stop('✅ RELEASE ناجح!');
        return;
      }

      // تحقق من الوصول للحد الأقصى
      if (currentVal >= cfg.maxVal) {
        stop(`⚠️ وصل للحد الأقصى (${cfg.maxVal}) دون release`);
        return;
      }

      // زيادة القيمة
      currentVal = Math.min(cfg.maxVal, currentVal + cfg.step);
      slider.value = currentVal;

      // إطلاق الأحداث كما يفعل المستخدم يدوياً
      slider.dispatchEvent(new Event('input',  { bubbles: true }));
      slider.dispatchEvent(new Event('change', { bubbles: true }));

    }, cfg.interval);

    // إرجاع دالة إلغاء يدوي
    return function cancel() {
      stop('🚫 إلغاء يدوي من المستخدم');
    };
  }

  // ✅ تصدير إلى window للاستخدام في console
  window.autoRelease = autoRelease;

  console.log('[autoRelease] ✅ جاهز — اكتب autoRelease() في console للتشغيل');

})();
