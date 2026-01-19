let weaponsData = {};

/* =========================
   CSV LOADING
========================= */
async function loadWeaponsCSV() {
    const response = await fetch("weapons.csv");
    const text = await response.text();

    const rows = text.split("\n").map(r => r.trim()).filter(r => r.length > 0);
    rows.shift();

    rows.forEach(row => {
        const cols = row.split(",");

        if (cols.length < 41) return;

        const name = cols[0].trim();

        const weapon = {
            ID: cols[1],
            Tier: cols[2],
            Range: cols[3],
            Slot: cols[4],
            Reload: parseFloat(cols[5]) || 0,
            ShotInterval: parseFloat(cols[6]) || 0,
            ShotSubinterval: parseFloat(cols[7]) || 0,
            AOE: cols[8],
            Ammo: parseInt(cols[9]) || 1,
            ParticlesPerShot: parseInt(cols[10]) || 1,
            Attribute2: cols[11],
            Attribute3: cols[12],
            Attribute4: cols[13],
            Attribute5: cols[14],
            Attribute6: cols[15],
            levels: {}
        };

        const levelNames = [
            "Lv1","Lv2","Lv3","Lv4","Lv5","Lv6","Lv7","Lv8","Lv9","Lv10","Lv11","Lv12",
            "MK2_Lv1","MK2_Lv2","MK2_Lv3","MK2_Lv4","MK2_Lv5","MK2_Lv6",
            "MK2_Lv7","MK2_Lv8","MK2_Lv9","MK2_Lv10","MK2_Lv11","MK2_Lv12",
            "MK3_Lv1"
        ];

        levelNames.forEach((lvl, i) => {
            const val = cols[16 + i];
            if (val && val.trim()) weapon.levels[lvl] = parseFloat(val);
        });

        weaponsData[name] = weapon;
    });

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

        const dmg = weaponData.levels[cfg.level];
        if (dmg === undefined) throw new Error("Level not found");

        const reloadsWhileFiring =
            weaponData.Attribute4 &&
            weaponData.Attribute4.trim().toLowerCase() === "reloads while firing";

        weapons.push({
            name: cfg.name,
            damage: dmg,
            shotInterval: weaponData.ShotInterval,
            shotSubinterval: weaponData.ShotSubinterval,
            reload: weaponData.Reload,
            ammo: weaponData.Ammo,
            particles: weaponData.ParticlesPerShot,
            currentAmmo: weaponData.Ammo,
            maxAmmo: weaponData.Ammo,
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
    await loadWeaponsCSV();
});