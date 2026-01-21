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

// Pilot Skills Database
// Format: tiers: [T1, T2, T3, T4]
const PILOT_SKILLS_DATA = {
    "Mechanic": { 
        type: "passive_heal", 
        tiers: [0.0025, 0.0040, 0.0050, 0.0070], 
        description: "Restores percentage of durability per second"
    },
    "Titan Mechanic": { 
        type: "passive_heal", 
        tiers: [0.0014, 0.0021, 0.0042, 0.0070],
        description: "Restores percentage of durability per second (Titan)"
    }
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
function calculateTTK(enemyHealth, enemyDefence, weaponConfigs, healingConfig = null, pilotConfig = []) {
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
        const fireInterval = safe(data.fire_interval, 0);

        // Accel Properties
        const accelFireInterval = safe(data.accel_fire_interval, fireInterval);
        const accelActivationTime = safe(data.accel_activation_time, 0);

        // Defence Calc
        const bypass = getBypassFraction(data, levelNumber);
        const effectiveDP = Math.max(0, enemyDefence * (1 - bypass));
        const multiplier = 100 / (100 + effectiveDP);

        // Sonic Grey Damage logic
        const greyFraction = data.ammo_type === "Sonic" ? 1.0 : 0.4;

        return {
            name: cfg.name,
            rawDamagePerShot: baseDamage,
            damagePerShot: baseDamage * multiplier,
            fireInterval: fireInterval,
            accelFireInterval: accelFireInterval,
            accelActivationTime: accelActivationTime,
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
            
            // Accel State
            continuousFireTimer: 0,
            
            // Stats
            totalShots: 0,
            reloadCycles: 0,
            totalReloadTime: 0
        };
    });

    // --- 2. Initialize Sim State ---
    let currentTime = 0;
    let currentHealth = enemyHealth;
    let currentMaxHealth = enemyHealth; 
    
    let totalGreyDamage = 0;
    let totalMitigatedDamage = 0;
    
    // Active Module State
    let healEvents = [];
    let healCooldownReadyAt = 0; 
    let activeHealEndTime = -1;  
    
    // Pilot Skill State
    let passiveHealRate = 0; 
    
    if (pilotConfig && pilotConfig.length > 0) {
        pilotConfig.forEach(p => {
            const skillData = PILOT_SKILLS_DATA[p.name];
            if (!skillData) return;
            const tierIdx = Math.max(0, Math.min(3, p.tier - 1));
            
            if (skillData.type === 'passive_heal') {
                passiveHealRate += skillData.tiers[tierIdx];
            }
        });
    }

    let thresholds = [];
    if (healingConfig && healingConfig.thresholds) {
        thresholds = healingConfig.thresholds.sort((a, b) => b - a); 
    }

    const healthTimeline = [{ time: 0, health: enemyHealth, maxHealth: enemyHealth }];
    const ammoTimelines = {};
    weapons.forEach(w => ammoTimelines[w.name] = [{ time: 0, ammo: w.ammo }]);

    let iterations = 0;
    const MAX_ITERATIONS = 1_000_000;

    // --- 3. Simulation Loop ---
    do {
        // A. Find time of next event
        let nextEventTime = Infinity;

        for (const w of weapons) {
            if (w.ammo >= w.ammoPerShot) {
                if (w.nextShotTime < nextEventTime) nextEventTime = w.nextShotTime;
            } else {
                if (w.nextShotTime < nextEventTime) nextEventTime = w.nextShotTime;
            }

            if (w.reloadsWhileFiring && w.ammo < w.maxAmmo) {
                if (w.nextReloadTime < nextEventTime) nextEventTime = w.nextReloadTime;
            }
        }

        if (nextEventTime === Infinity) break;
        
        // B. Calculate Time Delta
        const dt = nextEventTime - currentTime;
        
        // --- C. Handle Healing ---
        
        // C1. Check Active Module Triggers
        if (healingConfig && healingConfig.rate > 0) {
            const hpPercent = (currentHealth / currentMaxHealth) * 100;
            const isReady = currentTime >= healCooldownReadyAt;
            
            if (isReady && thresholds.some(t => hpPercent <= t)) {
                activeHealEndTime = currentTime + healingConfig.duration;
                healCooldownReadyAt = currentTime + healingConfig.cooldown;
                healEvents.push({ time: currentTime });
            }
        }

        // C2. Apply Healing
        const healWindowStart = currentTime;
        const healWindowEnd = nextEventTime;
        
        // 1. Passive Healing
        if (passiveHealRate > 0) {
            const passiveAmount = currentMaxHealth * passiveHealRate * dt;
            currentHealth = Math.min(currentHealth + passiveAmount, currentMaxHealth);
        }

        // 2. Active Healing
        if (healingConfig && healingConfig.rate > 0) {
            const effectiveEnd = Math.min(nextEventTime, activeHealEndTime);
            
            if (currentTime < activeHealEndTime) {
                const duration = effectiveEnd - currentTime;
                if (duration > 0) {
                    const activeAmount = currentMaxHealth * healingConfig.rate * duration;
                    currentHealth = Math.min(currentHealth + activeAmount, currentMaxHealth);
                }
            }
        }

        currentTime = nextEventTime;


        // --- D. Process Weapon Events ---
        
        // 1. Process Reloads (RWF)
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
                // RESET ACCELERATION ON RELOAD/STOP
                w.continuousFireTimer = 0;

                if (!w.reloadsWhileFiring) {
                    // Start Standard Reload
                    w.reloadCycles++;
                    w.totalReloadTime += w.reloadTime;
                    w.ammo = w.maxAmmo;
                    w.shotsRemainingInBurst = w.shotsPerBurst;
                    
                    w.nextShotTime = currentTime + w.reloadTime;
                    ammoTimelines[w.name].push({ time: currentTime + w.reloadTime, ammo: w.ammo });
                } else {
                    // Wait for reload tick
                    w.nextShotTime = w.nextReloadTime;
                }
                continue;
            }

            // FIRE!
            const shotDamage = w.damagePerShot;
            const greyDamage = shotDamage * w.greyFraction; 
            
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

            // --- ACCELERATION LOGIC START ---
            // Determine current fire interval based on acceleration state
            let currentFireInterval = w.fireInterval;
            
            // Check if acceleration is active
            if (w.accelActivationTime > 0 && w.continuousFireTimer >= w.accelActivationTime) {
                currentFireInterval = w.accelFireInterval;
            }
            // --- ACCELERATION LOGIC END ---

            // Schedule Next Shot
            let timeToNextShot = 0;

            if (w.shotsRemainingInBurst > 0) {
                timeToNextShot = currentFireInterval;
            } else {
                w.shotsRemainingInBurst = w.shotsPerBurst;
                timeToNextShot = currentFireInterval + w.burstInterval;
            }
            
            // Accumulate continuous fire duration for acceleration check
            w.continuousFireTimer += timeToNextShot;
            
            w.nextShotTime = currentTime + timeToNextShot;
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