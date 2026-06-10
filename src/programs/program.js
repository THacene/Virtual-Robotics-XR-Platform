// ============================================================
//  program.js — Box Sorting Scenario
// ============================================================

(function () {

  /**
   * Runs the Box Sorting Scenario
   * @param {number} startBoxId - ID of the first box to pick
   * @param {number} endBoxId - ID of the last box to pick
   * @param {number} zoneX - X coordinate of the drop zone
   * @param {number} zoneZ - Z coordinate of the drop zone
   */
  window.runScenario = async function(startBoxId = 1, endBoxId = 5, zoneX = -5, zoneZ = 5) {
    console.log(`[Scenario] 🚀 Started: Moving boxes ${startBoxId} to ${endBoxId} to zone (${zoneX}, ${zoneZ})`);
    
    // Wait for the pickAndPlace API to be available
    while (!window.pickAndPlace) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    let placedCount = 0;

    for (let i = startBoxId; i <= endBoxId; i++) {
      // 1. Calculate a neat drop position for this box
      let targetX = zoneX + (placedCount * 0.6);
      let targetZ = zoneZ;

      // Dynamic Drop Location: Check if the spot is blocked by other boxes (or previously placed boxes)
      if (window.__boxes) {
        let isBlocked = true;
        while (isBlocked) {
          isBlocked = false;
          for (const b of window.__boxes) {
            if (b.id === i) continue; // ignore the box we are currently moving
            // If another box is within 0.5m of our target, it's blocked!
            const d = Math.hypot(b.body.position.x - targetX, b.body.position.z - targetZ);
            if (d < 0.55) {
              isBlocked = true;
              targetX += 0.6; // Shift target to the right and try again
              break;
            }
          }
        }
      }

      const dropTarget = {
        x: targetX,
        z: targetZ
      };

      console.log(`[Scenario] 📦 Starting Box #${i}. Target: (${dropTarget.x.toFixed(2)}, ${dropTarget.z.toFixed(2)})`);
      
      // 2. Start the pick and place mission using the active robot
      const mission = await window.pickAndPlace(i, dropTarget);
      
      // 3. Polling loop to wait until the box is placed
      while (true) {
        const state = mission.status();
        
        if (state === 'done') {
          console.log(`[Scenario] ✅ Box #${i} completed successfully!`);
          placedCount++;
          break; // proceed to the next box
        }
        
        // Wait 500ms before checking the status again
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    console.log(`[Scenario] 🎉 Mission Accomplished! All ${placedCount} boxes moved successfully.`);
  };

  console.log('[Scenario] ✅ program.js loaded. Run: runScenario(1, 5, -5, 5)');

})();
