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
    const weapons = [];

    weaponConfigs.forEach(cfg => {
        const weaponData = weaponsData[cfg.name];
        if (!weaponData) throw new Error("Weapon not found");

        const dmg = weaponData[cfg.level];
        if (dmg === undefined) throw new Error("Level not found");

        const reloadsWhileFiring = weaponData.reload_while_firing === true;
        
        // Determine if this is a burst weapon
        const isBurstWeapon = weaponData.particles_per_burst !== undefined && weaponData.particles_per_burst > 1;
        
        // Calculate effective particles per shot
        const particlesPerShot = weaponData.particles_per_shot || 1;
        const particlesPerBurst = weaponData.particles_per_burst || 1;
        const numberOfParticles = weaponData.number_of_particles || 1;
        
        // Total damage per shot = base damage * particles * modifier
        const damageModifier = weaponData.damage_modifier || 1;
        const effectiveDamage = dmg * particlesPerShot * numberOfParticles * damageModifier;
        
        // Shot timing
        let shotInterval, shotSubinterval;
        if (isBurstWeapon) {
            // For burst weapons: fire_interval is between shots in burst, burst_interval is between bursts
            shotInterval = weaponData.burst_interval || 0;
            shotSubinterval = weaponData.fire_interval || 0;
        } else {
            shotInterval = weaponData.fire_interval || 0;
            shotSubinterval = 0;
        }

        weapons.push({
            name: cfg.name,
            damage: effectiveDamage,
            shotInterval: shotInterval,
            shotSubinterval: shotSubinterval,
            reload: weaponData.reload_time || 0,
            ammo: weaponData.clip_size || 1,
            particles: isBurstWeapon ? particlesPerBurst : 1,
            currentAmmo: weaponData.clip_size || 1,
            maxAmmo: weaponData.clip_size || 1,
            reloadsWhileFiring,
            nextShotTime: 0,
            totalBursts: 0,
            reloadCycles: 0,
            totalReloadTime: 0
        });
    });

    let currentHealth = enemyHealth;
    let currentTime = 0;
    let iterations = 0;
    const maxIterations = 1000000;

    while (currentHealth > 0 && iterations < maxIterations) {
        iterations++;

        let nextEvent = Infinity;
        weapons.forEach(w => {
            if (w.nextShotTime < nextEvent) nextEvent = w.nextShotTime;
        });

        if (nextEvent === Infinity) break;
        currentTime = nextEvent;

        weapons.forEach(w => {
            if (currentTime >= w.nextShotTime && w.currentAmmo > 0) {
                currentHealth -= w.damage;
                w.totalBursts++;
                w.currentAmmo--;

                if (w.currentAmmo <= 0) {
                    w.reloadCycles++;
                    w.totalReloadTime += w.reload;

                    if (w.reloadsWhileFiring) {
                        const timePerRound = w.reload / w.maxAmmo;
                        w.currentAmmo = w.maxAmmo;
                        w.nextShotTime = currentTime + timePerRound;
                    } else {
                        w.currentAmmo = w.maxAmmo;
                        w.nextShotTime = currentTime + w.reload;
                    }
                } else {
                    w.nextShotTime =
                        currentTime +
                        w.shotInterval +
                        (w.particles - 1) * w.shotSubinterval;
                }
            }
        });
    }

    const totalBursts = weapons.reduce((a, w) => a + w.totalBursts, 0);
    const totalDamage = weapons.reduce((a, w) => a + w.totalBursts * w.damage, 0);
    const dps = currentTime > 0 ? Math.round(totalDamage / currentTime) : 0;

    if (totalDamage < enemyHealth) {
        throw new Error("Damage insufficient");
    }

    const breakdown = weapons.map(w => ({
        name: w.name,
        bursts: w.totalBursts,
        damage: Math.round(w.totalBursts * w.damage),
        reloads: w.reloadCycles,
        reload_time: Math.round(w.totalReloadTime * 100) / 100
    }));

    return {
        ttk: Math.round(currentTime * 100) / 100,
        total_shots: totalBursts,
        total_damage: Math.round(totalDamage),
        dps,
        breakdown
    };
}

/* =========================
   INIT
========================= */
document.addEventListener("DOMContentLoaded", async () => {
    await loadWeaponsJSON();
});