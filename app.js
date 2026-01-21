/* =========================
   CONSTANTS & CONFIG
========================= */
let weaponsData = {};

const HEALING_MODULES = {
    // Repair: 5%/sec for 5s (25% total), 20s CD
    none: { rate: 0, duration: 0, cooldown: 0, name: "None" },
    repair: { rate: 0.05, duration: 5, cooldown: 20, name: "Repair Unit" },
    advanced: { rate: 0.10, duration: 4, cooldown: 20, name: "Adv. Repair Unit" }
};

/* =========================
   JSON LOADING
========================= */
async function loadWeaponsJSON() {
    const response = await fetch("weapons.json");
    weaponsData = await response.json();
    console.log("Weapons loaded", Object.keys(weaponsData).length);
}

/* =========================
   HELPER: Bypass Logic
========================= */
function getBypassFraction(weaponData, level) {
    if (weaponData.defense_bypass === true) return 1;

    if (weaponData.slot === "Alpha") {
        return 0.75 + (Math.min(level, 25) - 1) * (0.25 / 24);
    }

    if (weaponData.slot === "Beta") {
        return 0.5 + (Math.min(level, 25) - 1) * (0.25 / 24);
    }

    return 0;
}


/* =========================
   TTK CALCULATION
========================= */
function calculateTTK(enemyHealth, enemyDefence, weaponConfigs, healingConfig = null) {
    const safe = (v, d = 0) => Number.isFinite(v) ? v : d;

    // --- 1. Prepare Weapons ---
    const weapons = weaponConfigs.map(cfg => {
        const data = weaponsData[cfg.name];
        if (!data) throw new Error(`Weapon not found: ${cfg.name}`);

        let dmg;
        if (typeof cfg.level === "number") {
            dmg = data[`damage_${cfg.level}`];
        } else if (typeof cfg.level === "string") {
            dmg = data[cfg.level];
        }

        if (!Number.isFinite(dmg)) throw new Error(`Damage missing for ${cfg.name}`);

        const levelNumber = typeof cfg.level === "string"
                ? parseInt(cfg.level.replace("damage_", ""))
                : cfg.level;

        const shotsPerBurst = safe(data.particles_per_burst, 1);
        const isBurst = shotsPerBurst > 1;
        const reloadsWhileFiring = data.reload_while_firing === true;
        const baseDamage = dmg * safe(data.damage_modifier, 1);

        // Defence Calc
        const bypass = getBypassFraction(data, levelNumber);
        const effectiveDP = Math.max(0, enemyDefence * (1 - bypass));
        const multiplier = 100 / (100 + effectiveDP);

        // Sonic Grey Damage logic: Sonic = 100% unhealable, Others = 40% unhealable
        // Grey Fraction represents how much of the damage CANNOT be healed.
        // Conventional logic: 
        // Normal weapons: Deal X damage. ~60% is healable, 40% is grey (permanent).
        // Sonics: 100% grey.
        const greyFraction = data.ammo_type === "Sonic" ? 1.0 : 0.4;

        return {
            name: cfg.name,
            rawDamagePerShot: baseDamage,
            damagePerShot: baseDamage * multiplier,
            fireInterval: safe(data.fire_interval, 0),
            burstInterval: isBurst ? safe(data.burst_interval, 0) : 0,
            shotsPerBurst,
            shotsRemainingInBurst: shotsPerBurst,
            ammo: safe(data.clip_size, Infinity),
            maxAmmo: safe(data.clip_size, Infinity),
            ammoPerShot: safe(data.ammo_per_shot, 1),
            reloadTime: safe(data.reload_time, 0),
            reloadsWhileFiring,
            reloadInterval: reloadsWhileFiring ? safe(data.reload_interval, 0) : 0,
            reloadAmount: reloadsWhileFiring ? safe(data.reload_amount, 0) : 0,
            greyFraction,
            nextShotTime: 0,
            nextReloadTime: reloadsWhileFiring ? 0 : Infinity,
            
            // Stats
            totalShots: 0,
            reloadCycles: 0,
            totalReloadTime: 0
        };
    });

    // --- 2. Initialize Sim State ---
    let currentTime = 0;
    let currentHealth = enemyHealth;
    let currentMaxHealth = enemyHealth; // Reduces when grey damage is taken
    
    let totalGreyDamage = 0;
    let totalMitigatedDamage = 0;
    
    // Healing State
    let healEvents = [];
    let healCooldownReadyAt = 0; // Available immediately
    let activeHealEndTime = -1;  // Not active
    
    // Parse Thresholds
    let thresholds = [];
    if (healingConfig && healingConfig.thresholds) {
        thresholds = healingConfig.thresholds.sort((a, b) => b - a); // Descending
    }

    // Timeline Recorders
    const healthTimeline = [{ time: 0, health: enemyHealth, maxHealth: enemyHealth }];
    const ammoTimelines = {};
    weapons.forEach(w => ammoTimelines[w.name] = [{ time: 0, ammo: w.ammo }]);

    let iterations = 0;
    const MAX_ITERATIONS = 1_000_000;

    // --- 3. Simulation Loop ---
    do {
        // A. Find time of next event (shot or reload)
        let nextEventTime = Infinity;

        for (const w of weapons) {
            // Check shot availability
            if (w.ammo >= w.ammoPerShot) {
                if (w.nextShotTime < nextEventTime) nextEventTime = w.nextShotTime;
            } else {
                // If out of ammo and NOT reloading while firing, we wait for reload
                // But the 'reload' logic handles the delay. 
                // We just need to ensure nextShotTime is accurate (set during reload start).
                if (w.nextShotTime < nextEventTime) nextEventTime = w.nextShotTime;
            }

            // Check reload-while-firing ticks
            if (w.reloadsWhileFiring && w.ammo < w.maxAmmo) {
                if (w.nextReloadTime < nextEventTime) nextEventTime = w.nextReloadTime;
            }
        }

        // If no events left (or bug), break
        if (nextEventTime === Infinity) break;
        
        // B. Calculate Time Delta
        const dt = nextEventTime - currentTime;
        
        // --- C. Handle Healing (Over the duration of dt) ---
        // 1. Check Triggers at START of this window (currentTime)
        if (healingConfig && healingConfig.rate > 0) {
            const hpPercent = (currentHealth / currentMaxHealth) * 100;
            const isReady = currentTime >= healCooldownReadyAt;
            
            // Trigger if ready AND below highest available threshold
            if (isReady && thresholds.some(t => hpPercent <= t)) {
                activeHealEndTime = currentTime + healingConfig.duration;
                healCooldownReadyAt = currentTime + healingConfig.cooldown;
                healEvents.push({ time: currentTime });
            }
        }

        // 2. Apply Healing during dt
        // Overlap logic: The window is [currentTime, nextEventTime].
        // Active heal window is [healStartTime, activeHealEndTime].
        // We just care if we are < activeHealEndTime.
        
        const healWindowStart = currentTime;
        const healWindowEnd = Math.min(nextEventTime, activeHealEndTime);
        
        if (healWindowEnd > healWindowStart) {
            const healDuration = healWindowEnd - healWindowStart;
            // Rate is % of Current MAX Health per second
            const healAmount = currentMaxHealth * healingConfig.rate * healDuration;
            
            currentHealth = Math.min(currentHealth + healAmount, currentMaxHealth);
        }

        // Move time forward
        currentTime = nextEventTime;


        // --- D. Process Weapon Events ---
        
        // 1. Process Reloads (Reload-while-firing types)
        for (const w of weapons) {
            if (!w.reloadsWhileFiring) continue;
            if (currentTime >= w.nextReloadTime && w.ammo < w.maxAmmo) {
                w.ammo = Math.min(w.ammo + w.reloadAmount, w.maxAmmo);
                w.nextReloadTime = currentTime + w.reloadInterval;
                ammoTimelines[w.name].push({ time: currentTime, ammo: w.ammo });
            }
        }

        // 2. Process Shots
        for (const w of weapons) {
            if (currentTime < w.nextShotTime) continue;
            
            // If out of ammo, handle reload initiation
            if (w.ammo < w.ammoPerShot) {
                if (!w.reloadsWhileFiring) {
                    // Start Standard Reload
                    // We arrived here at nextShotTime (which was set to 0 or previous shot time).
                    // We must wait 'reloadTime' before firing again.
                    w.reloadCycles++;
                    w.totalReloadTime += w.reloadTime;
                    w.ammo = w.maxAmmo;
                    w.shotsRemainingInBurst = w.shotsPerBurst;
                    
                    // The next shot can happen after reload
                    w.nextShotTime = currentTime + w.reloadTime;
                    
                    ammoTimelines[w.name].push({ time: currentTime + w.reloadTime, ammo: w.ammo });
                } else {
                    // Reload while firing - just wait for next tick
                    w.nextShotTime = w.nextReloadTime;
                }
                continue;
            }

            // FIRE!
            const shotDamage = w.damagePerShot;
            const greyDamage = shotDamage * w.greyFraction; // Permanent damage
            
            currentMaxHealth -= greyDamage;
            currentHealth -= shotDamage;

            // Clamping
            currentMaxHealth = Math.max(0, currentMaxHealth);
            currentHealth = Math.min(currentHealth, currentMaxHealth);

            // Stats
            totalGreyDamage += greyDamage;
            totalMitigatedDamage += (w.rawDamagePerShot - w.damagePerShot);
            w.totalShots++;
            w.ammo -= w.ammoPerShot;
            w.shotsRemainingInBurst--;

            // Record State
            healthTimeline.push({
                time: currentTime,
                health: currentHealth,
                maxHealth: currentMaxHealth
            });
            ammoTimelines[w.name].push({ time: currentTime, ammo: w.ammo });

            // Schedule Next Shot
            if (w.shotsRemainingInBurst > 0) {
                w.nextShotTime = currentTime + w.fireInterval;
            } else {
                w.shotsRemainingInBurst = w.shotsPerBurst;
                w.nextShotTime = currentTime + w.fireInterval + w.burstInterval;
            }
        }

    } while (currentHealth > 0 && iterations++ < MAX_ITERATIONS);


    // --- 4. Final Aggregation ---
    const totalShots = weapons.reduce((a, w) => a + w.totalShots, 0);
    const totalDamage = weapons.reduce((a, w) => a + w.totalShots * w.damagePerShot, 0);

    return {
        ttk: Math.round(currentTime * 100) / 100,
        total_shots: totalShots,
        total_damage: Math.round(totalDamage),
        damage_mitigated: Math.round(totalMitigatedDamage),
        dps: currentTime > 0 ? Math.round(totalDamage / currentTime) : 0,
        breakdown: weapons.map(w => ({
            name: w.name,
            shots: w.totalShots,
            damage: Math.round(w.totalShots * w.damagePerShot),
            reloads: w.reloadCycles,
            reload_time: Math.round(w.totalReloadTime * 100) / 100
        })),
        timeline: {
            enemyHealth: healthTimeline,
            weapons: ammoTimelines,
            healTimeline: healEvents
        }
    };
}