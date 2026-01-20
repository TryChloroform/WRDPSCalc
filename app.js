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

        return {
            name: cfg.name,

            damagePerShot: dmg * safe(data.damage_modifier, 1),

            fireInterval: safe(data.fire_interval, 0),
            burstInterval: isBurst ? safe(data.burst_interval, 0) : 0,

            shotsPerBurst,
            shotsRemainingInBurst: shotsPerBurst,

            ammo: safe(data.clip_size, Infinity),
            maxAmmo: safe(data.clip_size, Infinity),

            reloadTime: safe(data.reload_time, 0),
            reloadsWhileFiring: data.reload_while_firing === true,

            nextShotTime: 0,

            totalShots: 0,
            reloadCycles: 0,
            totalReloadTime: 0
        };
    });

    let currentTime = 0;
    let currentHealth = enemyHealth;
    let iterations = 0;

    do {
        let nextEvent = Infinity;

        for (const w of weapons) {
            if (w.nextShotTime < nextEvent) nextEvent = w.nextShotTime;
        }

        if (nextEvent === Infinity) break;
        currentTime = nextEvent;

        for (const w of weapons) {
            if (currentTime < w.nextShotTime) continue;
            if (w.ammo <= 0) continue;

            // Fire exactly ONE shot
            currentHealth -= w.damagePerShot;
            w.totalShots++;
            w.ammo--;
            w.shotsRemainingInBurst--;

            // Reload
            if (w.ammo === 0) {
                w.reloadCycles++;
                w.totalReloadTime += w.reloadTime;

                w.ammo = w.maxAmmo;
                w.shotsRemainingInBurst = w.shotsPerBurst;
                w.nextShotTime = currentTime + w.reloadTime;
                continue;
            }

            // Burst timing
            if (w.shotsRemainingInBurst > 0) {
                // Next shot in burst
                w.nextShotTime = currentTime + w.fireInterval;
            } else {
                // Burst finished
                w.shotsRemainingInBurst = w.shotsPerBurst;
                w.nextShotTime =
                    currentTime +
                    w.fireInterval +
                    w.burstInterval;
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
        }))
    };
}

/* =========================
   INIT
========================= */
document.addEventListener("DOMContentLoaded", async () => {
    await loadWeaponsJSON();
});