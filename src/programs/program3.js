// ============================================================
//  program3.js — Order Fulfillment Scenario (Warehouse Picking)
//  v1.1 — إصلاح التوقف بعد أول صندوق:
//    ✅ إزاحة نقاط الإسقاط داخل الرصيف (منع التكدّس والعوائق)
//    ✅ مهلة زمنية لكل صنف (منع التعليق للأبد)
//    ✅ فترة استقرار بين الأصناف + إيقاف آمن عند الفشل
// ============================================================

(function () {

    // ── أرصفة الشحن حسب الأولوية ──────────────────
    const DISPATCH_DOCKS = {
        express: { x: 6, z: 6 },  // طلبات عاجلة
        standard: { x: 6, z: -6 },  // طلبات عادية
    };

    // ── إعدادات قابلة للضبط ───────────────────────
    const CONFIG = {
        timeoutPerItem: 120000,   // أقصى زمن لكل صنف (ms)
        settleDelay: 1200,     // فترة استقرار بين الأصناف (ms)
        slotSpacing: 0.7,      // المسافة بين الصناديق في الرصيف (m)
        slotsPerRow: 3,        // عدد الصناديق في الصف الواحد
    };

    /**
     * يحسب نقطة إسقاط فريدة داخل الرصيف لكل صنف
     * حتى لا تتكدّس الصناديق في نفس النقطة وتصبح عوائق
     * @param {Object} dock - نقطة الرصيف الأساسية {x, z}
     * @param {number} index - ترتيب الصنف داخل الطلب (0-based)
     */
    function slotInDock(dock, index) {
        const row = Math.floor(index / CONFIG.slotsPerRow);
        const col = index % CONFIG.slotsPerRow;
        return {
            x: dock.x + col * CONFIG.slotSpacing,
            z: dock.z + row * CONFIG.slotSpacing,
        };
    }

    /**
     * تنفيذ مهمة pick & place واحدة مع مهلة زمنية
     * @returns {Promise<{ok:boolean, reason?:string}>}
     */
    function runPickWithTimeout(sku, target) {
        return new Promise(async (resolve) => {
            let mission;
            try {
                mission = await window.pickAndPlace(sku, target);
            } catch (e) {
                resolve({ ok: false, reason: 'launch-error' });
                return;
            }

            const t0 = performance.now();
            const poll = setInterval(() => {
                let state;
                try { state = mission.status(); } catch { state = 'unknown'; }

                if (state === 'done') {
                    clearInterval(poll);
                    resolve({ ok: true });
                    return;
                }

                if (performance.now() - t0 > CONFIG.timeoutPerItem) {
                    clearInterval(poll);
                    try { mission.stop?.(); } catch { }
                    resolve({ ok: false, reason: 'timeout' });
                }
            }, 500);
        });
    }

    /**
     * تجهيز طلب واحد
     * @param {Object} order
     * @param {string} order.id        - رقم الطلب
     * @param {Array<number>} order.items - أرقام الصناديق المطلوبة (SKUs)
     * @param {string} order.priority  - 'express' | 'standard'
     */
    async function fulfillOrder(order) {
        const dock = DISPATCH_DOCKS[order.priority] || DISPATCH_DOCKS.standard;

        console.log(`[Fulfillment] 📋 Order ${order.id} | priority=${order.priority} | items=[${order.items.join(', ')}]`);

        // التحقق من توفر الأصناف في المخزون قبل البدء
        const inventory = new Set((window.__boxes || []).map(b => b.id));
        const available = order.items.filter(id => inventory.has(id));
        const missing = order.items.filter(id => !inventory.has(id));

        if (missing.length) {
            console.warn(`[Fulfillment] ⚠️ Out of stock for Order ${order.id}: [${missing.join(', ')}]`);
        }
        if (!available.length) {
            console.error(`[Fulfillment] 💥 Order ${order.id} cannot be fulfilled — no items in stock`);
            return { id: order.id, picked: 0, failed: 0, missing, status: 'cancelled' };
        }

        let picked = 0;
        let failed = 0;

        // جمع كل صنف مطلوب على حدة (Pick → Stage) في خانة مستقلة
        for (let i = 0; i < available.length; i++) {
            const sku = available[i];
            const target = slotInDock(dock, i);   // ✅ خانة فريدة لكل صنف

            console.log(`[Fulfillment] 🔍 Picking SKU #${sku} → dock ${order.priority} slot (${target.x.toFixed(1)}, ${target.z.toFixed(1)})`);

            const result = await runPickWithTimeout(sku, target);

            if (result.ok) {
                picked++;
                console.log(`[Fulfillment] 📦 SKU #${sku} staged (${picked}/${available.length})`);
            } else {
                failed++;
                console.error(`[Fulfillment] ❌ SKU #${sku} failed (${result.reason})`);
                // إيقاف آمن قبل الانتقال للصنف التالي
                try { window.stopMission?.(); } catch { }
            }

            // ✅ فترة استقرار قبل بدء الصنف التالي (يمنع تعارض الـ listeners)
            await new Promise(r => setTimeout(r, CONFIG.settleDelay));
        }

        let status = 'complete';
        if (failed > 0 || missing.length) status = picked > 0 ? 'partial' : 'cancelled';

        console.log(`[Fulfillment] ✅ Order ${order.id} ${status.toUpperCase()} — ${picked} staged, ${failed} failed at ${order.priority} dock`);

        return { id: order.id, picked, failed, missing, status };
    }

    /**
     * معالجة قائمة طلبات — العاجلة أولاً (Priority Scheduling)
     * @param {Array<Object>} orders - قائمة الطلبات
     */
    window.runFulfillment = async function (orders) {
        // انتظار جهوزية الـ API
        while (!window.pickAndPlace) {
            await new Promise(r => setTimeout(r, 500));
        }

        // طلب افتراضي للتجربة إن لم تُمرَّر طلبات
        if (!orders || !orders.length) {
            orders = [
                { id: 'ORD-1001', items: [1, 3, 5], priority: 'express' },
                { id: 'ORD-1002', items: [2, 4], priority: 'standard' },
            ];
            console.log('[Fulfillment] ℹ️ No orders passed — using demo orders');
        }

        // جدولة حسب الأولوية: العاجل قبل العادي
        const PRIORITY_RANK = { express: 0, standard: 1 };
        const queue = orders.slice().sort(
            (a, b) => (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9)
        );

        console.log(`[Fulfillment] 🚀 Processing ${queue.length} order(s) by priority`);

        const t0 = performance.now();
        const report = [];

        for (const order of queue) {
            const result = await fulfillOrder(order);
            report.push(result);
            // فترة استقرار بين الطلبات
            await new Promise(r => setTimeout(r, CONFIG.settleDelay));
        }

        // تأكيد الإيقاف النهائي
        try { window.stopMission?.(); } catch { }

        // تقرير الشحن النهائي (Dispatch Summary)
        const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
        const complete = report.filter(r => r.status === 'complete').length;
        const partial = report.filter(r => r.status === 'partial').length;
        const cancelled = report.filter(r => r.status === 'cancelled').length;
        const totalPicked = report.reduce((s, r) => s + r.picked, 0);
        const totalFailed = report.reduce((s, r) => s + r.failed, 0);

        console.log('═══════════════════════════════════════');
        console.log(`[Fulfillment] 🎉 Shift complete in ${elapsed}s`);
        console.log(`  📦 Items picked:   ${totalPicked}`);
        console.log(`  ❌ Items failed:   ${totalFailed}`);
        console.log(`  ✅ Complete:       ${complete}`);
        console.log(`  🟡 Partial:        ${partial}`);
        console.log(`  ❌ Cancelled:      ${cancelled}`);
        console.table(report);
        console.log('═══════════════════════════════════════');

        return report;
    };

    console.log('[Fulfillment] ✅ program3.js loaded (v1.1). Run: runFulfillment() or runFulfillment([{id:"ORD-1", items:[1,2], priority:"express"}])');

})();
