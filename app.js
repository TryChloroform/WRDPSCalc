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
    // Future proofing example:
    // "Adamant Guardian": { type: "conditional_def", tiers: [25, 30, 35, 40], condition: "enemy_count" }
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

        // Defence Calc
        const bypass = getBypassFraction(data, levelNumber);
        const effectiveDP = Math.max(0, enemyDefence * (1 - bypass));
        const multiplier = 100 / (100 + effectiveDP);

        // Sonic Grey Damage logic: Sonic = 100% unhealable, Others = 40% unhealable
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
    
    // Active Module State
    let healEvents = [];
    let healCooldownReadyAt = 0; 
    let activeHealEndTime = -1;  
    
    // Pilot Skill State
    let passiveHealRate = 0; // % per second
    
    // Parse Pilot Skills
    if (pilotConfig && pilotConfig.length > 0) {
        pilotConfig.forEach(p => {
            const skillData = PILOT_SKILLS_DATA[p.name];
            if (!skillData) return;

            // Tier indices: T1=0, T2=1, T3=2, T4=3
            const tierIdx = Math.max(0, Math.min(3, p.tier - 1));
            
            if (skillData.type === 'passive_heal') {
                passiveHealRate += skillData.tiers[tierIdx];
            }
            // Add future types here (e.g. conditional defence)
        });
    }

    // Parse Active Module Thresholds
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
        
        // C1. Check Active Module Triggers (Start of window)
        let activeModuleRate = 0;
        
        if (healingConfig && healingConfig.rate > 0) {
            const hpPercent = (currentHealth / currentMaxHealth) * 100;
            const isReady = currentTime >= healCooldownReadyAt;
            
            // Trigger if ready AND below threshold
            if (isReady && thresholds.some(t => hpPercent <= t)) {
                activeHealEndTime = currentTime + healingConfig.duration;
                healCooldownReadyAt = currentTime + healingConfig.cooldown;
                healEvents.push({ time: currentTime });
            }
        }

        // C2. Apply Healing
        // We have two sources: Passive (Pilot) and Active (Module)
        // Passive applies for the whole dt.
        // Active applies only if within window.

        const healWindowStart = currentTime;
        const healWindowEnd = nextEventTime;
        
        // 1. Passive Healing (Full duration)
        if (passiveHealRate > 0) {
            const passiveAmount = currentMaxHealth * passiveHealRate * dt;
            currentHealth = Math.min(currentHealth + passiveAmount, currentMaxHealth);
        }

        // 2. Active Healing (Conditional duration)
        if (healingConfig && healingConfig.rate > 0) {
            // Intersection of [currentTime, nextEventTime] AND [healStart, activeHealEndTime]
            // Since we just checked trigger, healStart is effectively activeHealEndTime - duration (roughly)
            // Simpler: Just check overlap with activeHealEndTime
            
            const effectiveEnd = Math.min(nextEventTime, activeHealEndTime);
            const effectiveStart = Math.max(currentTime, activeHealEndTime - healingConfig.duration); // Approximation safety
            
            // Logic: if currentTime < activeHealEndTime, we have some healing
            if (currentTime < activeHealEndTime) {
                const duration = effectiveEnd - currentTime; // How much of this step is healed
                if (duration > 0) {
                    const activeAmount = currentMaxHealth * healingConfig.rate * duration;
                    currentHealth = Math.min(currentHealth + activeAmount, currentMaxHealth);
                }
            }
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
                    w.reloadCycles++;
                    w.totalReloadTime += w.reloadTime;
                    w.ammo = w.maxAmmo;
                    w.shotsRemainingInBurst = w.shotsPerBurst;
                    
                    w.nextShotTime = currentTime + w.reloadTime;
                    ammoTimelines[w.name].push({ time: currentTime + w.reloadTime, ammo: w.ammo });
                } else {
                    w.nextShotTime = w.nextReloadTime;
                }
                continue;
            }

            // Fire
            const shotDamage = w.damagePerShot;
            const greyDamage = shotDamage * w.greyFraction; 
            
            currentMaxHealth -= greyDamage;
            currentHealth -= shotDamage;

            // Clamping
            currentMaxHealth = Math.max(0, currentMaxHealth);
            currentHealth = Math.max(0, Math.min(currentHealth, currentMaxHealth));

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