let weaponsData = {};

/* =========================
   JSON LOADING
========================= */
async function loadWeaponsJSON() {
    const response = await fetch("weapons.json");
    weaponsData = await response.json();
    
    console.log("Weapons loaded", Object.keys(weaponsData).length);
}

/* =========================
   API STYLE ACCESSORS
========================= */
function getWeaponsData() {
    return weaponsData;
}

/* =========================
   TTK CALCULATION
========================= */
function calculateTTK(enemyHealth, weaponConfigs) {
    const safe = (v, d = 0) => Number.isFinite(v) ? v : d;

    // Reset timeline tracking
    enemyHealthTimeline = [{ time: 0, health: enemyHealth }];
    weaponAmmoTimelines = {};

    const weapons = weaponConfigs.map(cfg => {
        const data = weaponsData[cfg.name];
        if (!data) throw new Error(`Weapon not found: ${cfg.name}`);

        let dmg;

        if (typeof cfg.level === "number") {
            dmg = data[`damage_${cfg.level}`];
        } else if (typeof cfg.level === "string") {
            dmg = data[cfg.level];
        }

        if (!Number.isFinite(dmg)) {
            throw new Error(
                `Damage missing for ${cfg.name} at level ${cfg.level}`
            );
        }

        const shotsPerBurst = safe(data.particles_per_burst, 1);
        const isBurst = shotsPerBurst > 1;
        const reloadsWhileFiring = data.reload_while_firing === true;

        return {
            name: cfg.name,

            damagePerShot: dmg * safe(data.damage_modifier, 1),

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

            nextShotTime: 0,
            nextReloadTime: reloadsWhileFiring ? 0 : Infinity,

            totalShots: 0,
            reloadCycles: 0,
            totalReloadTime: 0
        };
    });

    // Initialize weapon ammo timelines
    weapons.forEach(w => {
        weaponAmmoTimelines[w.name] = [{ time: 0, ammo: w.ammo }];
    });

    let currentTime = 0;
    let currentHealth = enemyHealth;
    let iterations = 0;

    do {
        let nextEvent = Infinity;

        for (const w of weapons) {
            if (w.nextShotTime < nextEvent) nextEvent = w.nextShotTime;
            if (w.reloadsWhileFiring && w.nextReloadTime < nextEvent) {
                nextEvent = w.nextReloadTime;
            }
        }

        if (nextEvent === Infinity) break;
        currentTime = nextEvent;

        // Process reload events first
        for (const w of weapons) {
            if (!w.reloadsWhileFiring) continue;
            if (currentTime < w.nextReloadTime) continue;
            if (w.ammo >= w.maxAmmo) continue;

            // Add reload_amount to ammo
            w.ammo = Math.min(w.ammo + w.reloadAmount, w.maxAmmo);
            w.nextReloadTime = currentTime + w.reloadInterval;
            
            // Record ammo change
            weaponAmmoTimelines[w.name].push({ time: currentTime, ammo: w.ammo });
        }

        // Process shot events
        for (const w of weapons) {
            if (currentTime < w.nextShotTime) continue;
            if (w.ammo < w.ammoPerShot) continue;

            // Fire exactly ONE shot
            currentHealth -= w.damagePerShot;
            w.totalShots++;
            w.ammo -= w.ammoPerShot;
            w.shotsRemainingInBurst--;

            // Record state changes
            enemyHealthTimeline.push({ time: currentTime, health: currentHealth });
            weaponAmmoTimelines[w.name].push({ time: currentTime, ammo: w.ammo });

            // Handle reload mechanics
            if (w.ammo < w.ammoPerShot) {
                if (!w.reloadsWhileFiring) {
                    // Traditional reload: wait for full reload_time
                    w.reloadCycles++;
                    w.totalReloadTime += w.reloadTime;
                    w.ammo = w.maxAmmo;
                    w.shotsRemainingInBurst = w.shotsPerBurst;
                    w.nextShotTime = currentTime + w.reloadTime;
                    
                    // Record ammo refill
                    weaponAmmoTimelines[w.name].push({ time: currentTime + w.reloadTime, ammo: w.ammo });
                    continue;
                } else {
                    // Reload while firing: wait for next reload batch
                    w.nextShotTime = w.nextReloadTime;
                    continue;
                }
            }

            // Burst timing
            if (w.shotsRemainingInBurst > 0) {
                // Next shot in burst
                w.nextShotTime = currentTime + w.fireInterval;
            } else {
                // Burst finished
                w.shotsRemainingInBurst = w.shotsPerBurst;
                w.nextShotTime = currentTime + w.fireInterval + w.burstInterval;
            }
        } 
    } while (currentHealth > 0 && iterations++ < 1_000_000);

    const totalShots = weapons.reduce((a, w) => a + w.totalShots, 0);
    const totalDamage = weapons.reduce(
        (a, w) => a + w.totalShots * w.damagePerShot,
        0
    );

    return {
        ttk: Math.round(currentTime * 100) / 100,
        total_shots: totalShots,
        total_damage: Math.round(totalDamage),
        dps: currentTime > 0 ? Math.round(totalDamage / currentTime) : 0,
        breakdown: weapons.map(w => ({
            name: w.name,
            shots: w.totalShots,
            damage: Math.round(w.totalShots * w.damagePerShot),
            reloads: w.reloadCycles,
            reload_time: Math.round(w.totalReloadTime * 100) / 100
        })),
        timeline: {
            enemyHealth: enemyHealthTimeline,
            weapons: weaponAmmoTimelines
        }
    };
}

/* =========================
   TIMELINE TRACKING
========================= */
let enemyHealthTimeline = [];
let weaponAmmoTimelines = {};

function recordTimelineSnapshot(time, health, weapons) {
    enemyHealthTimeline.push({ time, health });
    
    weapons.forEach(w => {
        if (!weaponAmmoTimelines[w.name]) {
            weaponAmmoTimelines[w.name] = [];
        }
        weaponAmmoTimelines[w.name].push({ time, ammo: w.ammo });
    });
}

/* =========================
   INIT
========================= */
document.addEventListener("DOMContentLoaded", async () => {
    await loadWeaponsJSON();
});