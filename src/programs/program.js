// ============================================================
//  program.js — Box Sorting Scenario
// ============================================================

(function () {

  /**
   * Runs the Box Sorting Scenario
   * @param {number} startBoxId - ID of the first box to pick
   * @param {number} endBoxId - ID of the last box to pick
   * @param {string} zoneName - Name of the drop zone (e.g., 'A', 'B', 'C', 'D')
   */
  window.runScenario = async function(startBoxId = 1, endBoxId = 5, zoneName = 'A') {
    const ZONES = {
      'A': { x: -5, z: 5 },
      'B': { x: 5, z: 5 },
      'C': { x: -5, z: -5 },
      'D': { x: 5, z: -5 }
    };
    
    // Default to Zone A if not found
    const targetZone = ZONES[zoneName] || ZONES['A'];
    const zoneX = targetZone.x;
    const zoneZ = targetZone.z;

    console.log(`[Scenario] 🚀 Started: Moving boxes ${startBoxId} to ${endBoxId} to Zone ${zoneName} (${zoneX}, ${zoneZ})`);
    
    // Wait for the pickAndPlaceZone API to be available
    while (!window.pickAndPlaceZone) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    let placedCount = 0;

    for (let i = startBoxId; i <= endBoxId; i++) {
      console.log(`[Scenario] 📦 Starting Box #${i}. Target Zone: ${zoneName}`);
      
      // 1. Start the pick and place mission using the new Zone API
      const mission = await window.pickAndPlaceZone(i, zoneName);
      
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

  console.log('[Scenario] ✅ program.js loaded. Run: runScenario(1, 5, "A")');

})();
