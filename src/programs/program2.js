// ============================================================
//  program2.js — Smart Multi-Stage Sorting Scenario
//  سيناريو الفرز الذكي: توزيع حسب الخاصية + تكديس + إعادة محاولة
// ============================================================

(function () {

    /**
     * Runs the Smart Sorting Scenario
     * @param {Object} opts
     * @param {string} opts.sortBy   - خاصية الفرز: 'color' | 'size' | 'id'
     * @param {number} opts.maxRetries - عدد محاولات إعادة النقل عند الفشل
     * @param {number} opts.timeoutPerBox - أقصى زمن لكل صندوق (ms)
     */
    window.runSmartSort = async function (opts = {}) {
        const {
            sortBy = 'id',
            maxRetries = 2,
            timeoutPerBox = 90000,
        } = opts;

        // خريطة الخصائص → المناطق
        const COLOR_ZONES = { red: 'A', blue: 'B', green: 'C', yellow: 'D' };
        const SIZE_ZONES = { small: 'A', medium: 'B', large: 'C' };

        // اختيار المنطقة المناسبة للصندوق حسب معيار الفرز
        const pickZone = (box) => {
            if (sortBy === 'color') return COLOR_ZONES[box.color] || 'A';
            if (sortBy === 'size') return SIZE_ZONES[box.size] || 'A';
            // الافتراضي: توزيع دائري حسب الـ id على المناطق الأربع
            return ['A', 'B', 'C', 'D'][(box.id - 1) % 4];
        };

        // انتظار جهوزية الـ API
        while (!window.pickAndPlaceZone) {
            await new Promise(r => setTimeout(r, 500));
        }

        const boxes = (window.__boxes || []).slice();
        if (!boxes.length) {
            console.warn('[SmartSort] ⚠️ No boxes found in window.__boxes');
            return;
        }

        console.log(`[SmartSort] 🚀 Started | sortBy=${sortBy} | boxes=${boxes.length}`);

        const stats = {
            total: boxes.length,
            placed: 0,
            failed: 0,
            retries: 0,
            startedAt: performance.now(),
            perZone: {},
        };

        // تنفيذ مهمة واحدة مع مهلة زمنية
        const runMissionWithTimeout = (boxId, zone) =>
            new Promise(async (resolve) => {
                const mission = await window.pickAndPlaceZone(boxId, zone);
                const t0 = performance.now();

                const poll = setInterval(() => {
                    const state = mission.status();

                    if (state === 'done') {
                        clearInterval(poll);
                        resolve({ ok: true });
                        return;
                    }

                    if (performance.now() - t0 > timeoutPerBox) {
                        clearInterval(poll);
                        mission.stop?.();
                        resolve({ ok: false, reason: 'timeout' });
                    }
                }, 500);
            });

        // المعالجة الرئيسية لكل صندوق مع إعادة المحاولة
        for (const box of boxes) {
            const zone = pickZone(box);
            let success = false;

            for (let attempt = 0; attempt <= maxRetries && !success; attempt++) {
                if (attempt > 0) {
                    stats.retries++;
                    console.log(`[SmartSort] 🔁 Retry ${attempt}/${maxRetries} for Box #${box.id}`);
                }

                console.log(`[SmartSort] 📦 Box #${box.id} → Zone ${zone} (attempt ${attempt + 1})`);
                const result = await runMissionWithTimeout(box.id, zone);

                if (result.ok) {
                    success = true;
                    stats.placed++;
                    stats.perZone[zone] = (stats.perZone[zone] || 0) + 1;
                    console.log(`[SmartSort] ✅ Box #${box.id} placed in Zone ${zone}`);
                } else {
                    console.warn(`[SmartSort] ❌ Box #${box.id} failed (${result.reason})`);
                    if (window.stopMission) window.stopMission();
                    await new Promise(r => setTimeout(r, 1000)); // فترة استقرار قبل المحاولة التالية
                }
            }

            if (!success) {
                stats.failed++;
                console.error(`[SmartSort] 💥 Box #${box.id} abandoned after ${maxRetries + 1} attempts`);
            }
        }

        // تقرير الأداء النهائي
        const elapsedSec = ((performance.now() - stats.startedAt) / 1000).toFixed(1);
        const rate = (stats.placed / (elapsedSec / 60)).toFixed(2);

        console.log('═══════════════════════════════════════');
        console.log(`[SmartSort] 🎉 Finished in ${elapsedSec}s`);
        console.log(`  ✅ Placed:  ${stats.placed}/${stats.total}`);
        console.log(`  ❌ Failed:  ${stats.failed}`);
        console.log(`  🔁 Retries: ${stats.retries}`);
        console.log(`  ⚡ Rate:    ${rate} boxes/min`);
        console.log(`  📊 Per Zone:`, stats.perZone);
        console.log('═══════════════════════════════════════');

        return stats;
    };

    console.log('[SmartSort] ✅ program2.js loaded. Run: runSmartSort({ sortBy: "color" })');

})();
