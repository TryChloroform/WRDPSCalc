/* =========================
   CONSTANTS & CONFIG
========================= */
let weaponsData = {};

const HEALING_MODULES = {
    none: { rate: 0, duration: 0, cooldown: 0, name: "None" },
    repair: { rate: 0.05, duration: 5, cooldown: 20, name: "Repair Unit" },
    advanced: { rate: 0.10, duration: 4, cooldown: 20, name: "Adv. Repair Unit" }
};

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

const EFFECT_CONFIG = {
    freeze: { duration: 5, immunity: 10, damageMult: 1.2 },
    lockdown: { duration: 5, immunity: 10 },
    blast: { delay: 0.5, damage: 25000 },
    corrosion: { duration: 5 }
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

        // Effect Properties
        let effectType = data.effect_type ? data.effect_type.toLowerCase() : "none";
        // Map common JSON values to our keys
        if (effectType.includes("freeze")) effectType = "freeze";
        else if (effectType.includes("lock-down") || effectType.includes("lockdown")) effectType = "lockdown";
        else if (effectType.includes("blast") || effectType.includes("charge")) effectType = "blast";
        else if (effectType.includes("corrosion") || effectType.includes("dot")) effectType = "corrosion";
        else effectType = "none";

        let effectPerShot = 0;
        if (effectType !== "none") {
            const totalEffect = safe(data[`effect_${levelNumber}`] || data[`effect_${cfg.level}`], 0);
            const clip = safe(data.clip_size, 1);
            effectPerShot = totalEffect / clip;
        }

        // Defence Calc
        const bypass = getBypassFraction(data, levelNumber);
        const effectiveDP = Math.max(0, enemyDefence * (1 - bypass));
        const multiplier = 100 / (100 + effectiveDP);

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

            // Effect Data
            effectType,
            effectPerShot,

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

    // Corrosion State
    let activeCorrosionStacks = []; // Array of { dps: number, endTime: number }

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

    // --- EFFECT STATES ---
    const effects = {
        freeze: { current: 0, activeEndTime: -1, immunityEndTime: -1 },
        lockdown: { current: 0, activeEndTime: -1, immunityEndTime: -1 },
        blast: { current: 0, detonationTime: Infinity }
    };
    const effectTimeline = [{ time: 0, freeze: 0, lockdown: 0, blast: 0, corrosion: 0 }];

    const healthTimeline = [{ time: 0, health: enemyHealth, maxHealth: enemyHealth }];
    const ammoTimelines = {};
    weapons.forEach(w => ammoTimelines[w.name] = [{ time: 0, ammo: w.ammo }]);

    // Helper to record state
    const recordSnapshot = (time, overrides = {}) => {
        healthTimeline.push({
            time: time,
            health: currentHealth,
            maxHealth: currentMaxHealth
        });

        // Determine values based on time/state, but allow overrides for edge transitions
        const valFreeze = overrides.freeze !== undefined ? overrides.freeze :
            ((time < effects.freeze.activeEndTime) ? 100 : effects.freeze.current);

        const valLockdown = overrides.lockdown !== undefined ? overrides.lockdown :
            ((time < effects.lockdown.activeEndTime) ? 100 : effects.lockdown.current);

        const valBlast = overrides.blast !== undefined ? overrides.blast :
            ((effects.blast.detonationTime !== Infinity && time < effects.blast.detonationTime) ? 100 : effects.blast.current);

        // Pending Corrosion Damage
        const pendingCorrosion = activeCorrosionStacks.reduce((sum, s) => sum + (s.dps * Math.max(0, s.endTime - time)), 0);

        effectTimeline.push({
            time: time,
            freeze: valFreeze,
            lockdown: valLockdown,
            blast: valBlast,
            corrosion: pendingCorrosion
        });
    };

    let iterations = 0;
    const MAX_ITERATIONS = 1_000_000;

    // --- 3. Simulation Loop ---
    do {
        // A. Find time of next event
        let nextEventTime = Infinity;

        // 1. Weapon Events
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

        // 2. Blast Detonation Event
        if (effects.blast.detonationTime !== Infinity && effects.blast.detonationTime < nextEventTime) {
            nextEventTime = effects.blast.detonationTime;
        }

        // 3. Effect Expiration Events
        if (effects.freeze.activeEndTime > currentTime && effects.freeze.activeEndTime < nextEventTime) nextEventTime = effects.freeze.activeEndTime;
        if (effects.freeze.immunityEndTime > currentTime && effects.freeze.immunityEndTime < nextEventTime) nextEventTime = effects.freeze.immunityEndTime;

        if (effects.lockdown.activeEndTime > currentTime && effects.lockdown.activeEndTime < nextEventTime) nextEventTime = effects.lockdown.activeEndTime;
        if (effects.lockdown.immunityEndTime > currentTime && effects.lockdown.immunityEndTime < nextEventTime) nextEventTime = effects.lockdown.immunityEndTime;

        // 4. Corrosion Expiration Events
        for (const stack of activeCorrosionStacks) {
            if (stack.endTime > currentTime && stack.endTime < nextEventTime) nextEventTime = stack.endTime;
        }

        if (nextEventTime === Infinity) break;

        // B. Calculate Time Delta
        const dt = nextEventTime - currentTime;

        // --- C. Handle Healing & DOT ---
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
        if (passiveHealRate > 0) {
            const passiveAmount = currentMaxHealth * passiveHealRate * dt;
            currentHealth = Math.min(currentHealth + passiveAmount, currentMaxHealth);
        }
        if (healingConfig && healingConfig.rate > 0) {
            if (currentTime < activeHealEndTime) {
                const effectiveEnd = Math.min(nextEventTime, activeHealEndTime);
                const duration = effectiveEnd - currentTime;
                if (duration > 0) {
                    const activeAmount = currentMaxHealth * healingConfig.rate * duration;
                    currentHealth = Math.min(currentHealth + activeAmount, currentMaxHealth);
                }
            }
        }

        // C3. Apply Corrosion (Bypasses Defense, No Grey Damage)
        let corrosionDmgThisTick = 0;
        activeCorrosionStacks = activeCorrosionStacks.filter(s => {
            const activeTime = Math.min(dt, Math.max(0, s.endTime - currentTime));
            corrosionDmgThisTick += s.dps * activeTime;
            return currentTime + dt < s.endTime + 0.001;
        });
        currentHealth -= corrosionDmgThisTick;

        // Move Clock
        currentTime = nextEventTime;

        // --- D. Handle Precise Events (Blast / Expiration) ---

        // D1. Blast Detonation
        if (effects.blast.detonationTime !== Infinity && currentTime >= effects.blast.detonationTime) {
            let blastDmg = EFFECT_CONFIG.blast.damage;
            if (currentTime < effects.freeze.activeEndTime) blastDmg *= EFFECT_CONFIG.freeze.damageMult;

            const blastGrey = blastDmg * 0.4;
            currentMaxHealth -= blastGrey;
            currentHealth -= blastDmg;

            currentMaxHealth = Math.max(0, currentMaxHealth);
            currentHealth = Math.min(currentHealth, currentMaxHealth);
            totalGreyDamage += blastGrey;
            effects.blast.current = 0;
            effects.blast.detonationTime = Infinity;
            recordSnapshot(currentTime);
        }

        // D2. Expiration Events
        if (Math.abs(currentTime - effects.freeze.activeEndTime) < 0.001) {
            recordSnapshot(currentTime, { freeze: 100 });
            recordSnapshot(currentTime, { freeze: 0 });
        }
        if (Math.abs(currentTime - effects.lockdown.activeEndTime) < 0.001) {
            recordSnapshot(currentTime, { lockdown: 100 });
            recordSnapshot(currentTime, { lockdown: 0 });
        }

        // --- E. Process Weapon Events ---

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

            // Reload Logic
            if (w.ammo < w.ammoPerShot) {
                w.continuousFireTimer = 0;
                if (!w.reloadsWhileFiring) {
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

            // --- DAMAGE CALCULATION ---
            let finalDamage = w.damagePerShot;
            if (currentTime < effects.freeze.activeEndTime) finalDamage *= EFFECT_CONFIG.freeze.damageMult;

            const greyDamage = finalDamage * w.greyFraction;
            currentMaxHealth -= greyDamage;
            currentHealth -= finalDamage;
            currentMaxHealth = Math.max(0, currentMaxHealth);
            currentHealth = Math.min(currentHealth, currentMaxHealth);

            totalGreyDamage += greyDamage;
            totalMitigatedDamage += (w.rawDamagePerShot - w.damagePerShot);
            w.totalShots++;
            w.ammo -= w.ammoPerShot;
            w.shotsRemainingInBurst--;

            // --- EFFECT ACCUMULATION ---
            if (w.effectType !== "none" && w.effectPerShot > 0) {
                if (w.effectType === "corrosion") {
                    // Total effect is applied over 5s. Each particle creates a stack.
                    activeCorrosionStacks.push({
                        dps: w.effectPerShot / EFFECT_CONFIG.corrosion.duration,
                        endTime: currentTime + EFFECT_CONFIG.corrosion.duration
                    });
                }
                else if (w.effectType === "freeze") {
                    if (currentTime >= effects.freeze.activeEndTime && currentTime >= effects.freeze.immunityEndTime) {
                        effects.freeze.current += w.effectPerShot;
                        if (effects.freeze.current >= 100) {
                            effects.freeze.current = 100;
                            recordSnapshot(currentTime);
                            effects.freeze.activeEndTime = currentTime + EFFECT_CONFIG.freeze.duration;
                            effects.freeze.immunityEndTime = effects.freeze.activeEndTime + EFFECT_CONFIG.freeze.immunity;
                            effects.freeze.current = 0;
                        }
                    }
                }
                else if (w.effectType === "lockdown") {
                    if (currentTime >= effects.lockdown.activeEndTime && currentTime >= effects.lockdown.immunityEndTime) {
                        effects.lockdown.current += w.effectPerShot;
                        if (effects.lockdown.current >= 100) {
                            effects.lockdown.current = 100;
                            recordSnapshot(currentTime);
                            effects.lockdown.activeEndTime = currentTime + EFFECT_CONFIG.lockdown.duration;
                            effects.lockdown.immunityEndTime = effects.lockdown.activeEndTime + EFFECT_CONFIG.lockdown.immunity;
                            effects.lockdown.current = 0;
                        }
                    }
                }
                else if (w.effectType === "blast") {
                    if (effects.blast.detonationTime === Infinity) {
                        effects.blast.current += w.effectPerShot;
                        if (effects.blast.current >= 100) {
                            effects.blast.current = 100;
                            effects.blast.detonationTime = currentTime + EFFECT_CONFIG.blast.delay;
                        }
                    }
                }
            }

            // Record Snapshot for this shot
            recordSnapshot(currentTime);
            ammoTimelines[w.name].push({ time: currentTime, ammo: w.ammo });

            // Accel Logic
            let currentFireInterval = w.fireInterval;
            if (w.accelActivationTime > 0 && w.continuousFireTimer >= w.accelActivationTime) {
                currentFireInterval = w.accelFireInterval;
            }

            let timeToNextShot = 0;
            if (w.shotsRemainingInBurst > 0) {
                timeToNextShot = currentFireInterval;
            } else {
                w.shotsRemainingInBurst = w.shotsPerBurst;
                timeToNextShot = currentFireInterval + w.burstInterval;
            }

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
            healTimeline: healEvents,
            effects: effectTimeline
        }
    };
}