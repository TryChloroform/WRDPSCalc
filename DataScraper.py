import requests
import json
import re
import time
from typing import Any

# Provided WEAPONS list
WEAPONS = [
    # Tier 1 Robot
    "Punisher", "Spiral", "Pin", "Molot", "Aphid", "Gekko", "Noricum", "Ecu",
    "Punisher_T", "Molot_T",
    "Thunder", "Trident", "Nashorn", "Kang_Dae", "Zenit",

    # Tier 2 Robot
    "Magnum", "Pinata", "Arbalest", "Gust", "Sting",
    "Orkan", "Hydra", "Tulumbas", "Taran", "Ballista", "Storm", "Ion",
    "Trebuchet", "Zeus", "Avenger", "Exodus",

    # Tier 3 Robot
    "Snaer", "Volt", "Halo", "Shredder", "Marquess", "Blaze", "Rime", "Spark", "Scald",
    "Shocktrain", "Skadi", "Vortex", "Weber", "Corona", "Hussar", "Igniter", "Cryo", "Fainter", "Scourge", "Scorcher",
    "Flux", "Chimera", "Hel", "Gauss", "Tempest", "Thermite", "Glory", "Avalanche", "Puncher", "Redeemer", "Dragoon",
    "Viper", "Ember", "Calamity", "Glacier", "Incinerator",

    # Tier 4 Robot
    "Magnetar", "Quarker", "Toxin", "Blight", "Cudgel", "Kramola", "Scatter", "Claw",
    "Spear", "Taeja", "Needle", "Ksiphos", "Splinter", "Trickster", "Tamer", "Shifang",
    "Morana", "Aramis", "Howler", "Smite", "Gangil", "Pow", "Elox", "Gladius",
    "Wasp", "Pulsar", "Atomizer", "Venom", "Havoc", "Hazard", "Mace", "Razdor", "Jaw", "Yeoje",
    "Spike", "Labrys", "Hurricane", "Shatter", "Deceiver", "Damper", "Leiming", "Chione",
    "Porthos", "Discipline", "Growler", "Deshret", "Regulator", "Mogwan", "Nanea", "Bash", "Murix",
    "Hornet", "Prisma", "Bane", "Nucleon", "Decay", "Devastator", "Hammer", "Smuta", "Talon",
    "Hwangje", "Stake", "Reaper", "Cestus", "Brisant", "Subduer", "Fengbao", "Jotunn", "Athos", "Dune",
    "Piercer", "Boom", "Pilum",
    
    # 11.7 New Robot Weapons
    "Hippo", "Kroko", "Liodari",

    # Ultimate (Robot / Titan / Shared)
    "Ultimate_Halo", "Ultimate_ARM_L-85", "Ultimate_Blaze", "Ultimate_Shredder", "Ultimate_Storm",
    "Ultimate_Taran", "Ultimate_Tulumbas", "Ultimate_Vortex",
    "Ultimate_Orkan", "Ultimate_Corona", "Ultimate_Pulsar", "Ultimate_Punisher_T", "Ultimate_Ion",
    "Ultimate_ARM_M-82", "Ultimate_Cryo", "Ultimate_Havoc", "Ultimate_Hussar", "Ultimate_Igniter",
    "Ultimate_Scourge", "Ultimate_Shocktrain", "Ultimate_Wasp",
    "Ultimate_Avenger", "Ultimate_Glory", "Ultimate_Calamity", "Ultimate_Dragoon", "Ultimate_Redeemer",
    
    # Titan Weaponry
    "Vengeance", "Retaliator", "Tsar", "Gendarme", "Rupture", "Cuirassier",
    "Cataclysm", "Grom", "Striker", "Bulava", "Basilisk", "Cyclone", "Squall", "Krait",
    "Kisten", "Dazzler", "Gargantua", "Maha-Vajra", "Glaive", "Veyron", "Argon", "Tonans",
    "Discordia", "Inferno", "Vendicatore", "Anguisher", "Arbiter", "Huginn", "Void", "Venire",
    "Lantern", "Pantagruel", "Vajra", "Evora", "Oxy", "Fulgur", "Tumultus", "Pyro", "Muninn", "Chasm", "Vincere",

    # Ultimate Titan Weapons
    "Ultimate_Gendarme", "Ultimate_Grom", "Ultimate_Squall", "Ultimate_Cyclone"
]

# Items to strictly ignore
EXCLUDE_KEYS = [
    # Metadata/Junk
    "单元", "直译", "俗称", "典故", "出场顺序", "英文维基页面", "公司", 
    "获取方式", "同类", "游戏简介", "限定前缀", "武器类型", "人工DPS",
    
    # Specific removals requested (Raw Chinese Keys)
    "伤害修正1",
    "伤害修正2",  # Added
    "伤害修正3",  # Added
    "炮击",
    "弹道速度",
    "垂直自瞄阈值", 
    "水平自瞄阈值", 
    "自瞄有效距离",
    "过热停火时间"
]

# Translation Maps
KEY_TRANSLATIONS = {
    # Core
    "英文": "name",
    "等级": "tier",
    "粒子面板倍率": "number_of_particles",
    "射程": "range",
    "搭载机体": "mount_type",
    "槽位": "slot",
    "弹药类型": "ammo_type",
    "弹药效果类型": "effect_type",
    "范围伤": "splash_radius",
    "弹匣总数": "clip_size",
    "射击间隔": "fire_interval",
    "每发粒子数": "particles_per_shot",
    "连发子弹量": "particles_per_burst",
    "连发间隔": "burst_interval",
    "面板装弹时间": "reload_time",
    "边射边装": "reload_while_firing",
    "每次装弹时间": "reload_interval",
    "每次装弹数量": "reload_amount",
    "伤害修正": "damage_modifier",
    "过热触发时间": "overheat_time",
    "过热冷却时间": "overheat_cooldown_time",  # Updated
    "瞄准锁定": "aim_lock",
    "蓄能层数": "max_charge",  # Updated
    "蓄能时间": "charge_time",
    
    # Attributes
    "弹药其他属性": "special_attributes",
    "每发消耗子弹": "ammo_per_shot",
    "装弹激活阈值": "reload_threshold",
    "散射系数水平": "spread_horizontal",
    "散射系数垂直": "spread_vertical",
    "加速射击间隔": "accel_fire_interval",
    "加速激活时间": "accel_activation_time",
    "加速保持时间": "accel_duration",
    "旋转速度": "rotation_speed",
    "原版": "original_version",
    "破防": "defense_bypass",
    "过热冷却系数": "overheat_cooling",
    "过热射速": "overheat_fire_rate",
    "过热散射": "overheat_spread",
    "连发加伤系数": "burst_damage_bonus",
}

VALUE_TRANSLATIONS = {
    # Mounts
    "机甲": "Mech",
    "泰坦": "Titan",
    # Slots
    "轻": "Light",
    "中": "Medium",
    "重": "Heavy",
    "阿尔法": "Alpha",
    "贝塔": "Beta",
    # Ammo Types
    "能量": "Energy",
    "火箭": "Rocket",
    "动能": "Kinetic",
    "实弹": "Kinetic",
    "音波": "Sonic",
    "其他": "Other",  # Added
    # Effects (Updated)
    "无": "None",
    "追踪": "Homing",
    "冰冻": "Freeze",
    "定身": "Lock-down",
    "定": "Lock-down",
    "炸": "Blast",
    "爆炸": "Blast",
    "毒": "Corrosion",
    "吸血": "Life Steal",
    "锈蚀": "Rust",
    "减速": "Slow",
    "压制": "Suppression",
    "盲": "Blind",
    "冰爆": "Freeze Blast",
    "脆化+锈蚀": "Fragility + Rust",  # Updated
    "崩裂+锈蚀": "Crumble + Rust",  # Updated
    "音爆": "Resonance",  # Updated
    "近距加伤": "Close Range Bonus",
    "光束弹射": "Chain",
    # Misc
    "是": True, 
    "否": False
}

# Cache for effect data
EFFECT_DATA_CACHE = None

def clean_value(text):
    text = re.sub(r'<ref.*?>.*?</ref>', '', text, flags=re.DOTALL)
    text = re.sub(r'<[^>]+>', '', text)
    return text.strip()

def fetch_effect_data():
    """Fetch and cache the effect data from Fandom wiki"""
    global EFFECT_DATA_CACHE
    
    if EFFECT_DATA_CACHE is not None:
        return EFFECT_DATA_CACHE
    
    url = "https://warrobots.fandom.com/wiki/Template:MasterWeaponEffect?action=raw"
    try:
        print("Fetching effect data from Fandom wiki...")
        response = requests.get(url, timeout=15)
        if response.status_code == 200:
            EFFECT_DATA_CACHE = response.text
            return EFFECT_DATA_CACHE
        else:
            print(f"Failed to fetch effect data: HTTP {response.status_code}")
            return None
    except Exception as e:
        print(f"Error fetching effect data: {e}")
        return None

def get_effect_values(weapon_name, effect_data):
    """Extract effect values (b1-b25) for a weapon from the effect data"""
    if not effect_data:
        return None
    
    # Convert weapon name: replace underscores with spaces
    search_name = weapon_name.replace('_', ' ')
    
    # Pattern to find the weapon section
    # Looking for |WeaponName = {{Stats Table ... }}
    pattern = r'\|' + re.escape(search_name) + r'\s*=\s*\{\{Stats Table(.*?)\}\}'
    match = re.search(pattern, effect_data, re.DOTALL | re.IGNORECASE)
    
    if not match:
        return None
    
    section = match.group(1)
    
    # Extract b1-b25 values
    effect_values = {}
    for i in range(1, 26):
        # Pattern for |b1 = value or |b1 = value ||
        # Now includes optional commas in numbers (e.g., 5,100)
        b_pattern = rf'\|b{i}\s*=\s*([\d,]+(?:\.\d+)?)'
        b_match = re.search(b_pattern, section)
        
        if b_match:
            value_str = b_match.group(1).strip()
            try:
                # Remove commas before converting to float
                value_str = value_str.replace(',', '')
                value = float(value_str)
                effect_values[f"effect_{i}"] = value
            except ValueError:
                pass
    
    return effect_values if effect_values else None

def get_weapon_data(weapon_name, effect_data=None):
    url = f"https://wiki.biligame.com/wwr/rest.php/v1/page/{weapon_name}"
    try:
        response = requests.get(url, timeout=10)
        if response.status_code != 200: return None
        
        source = response.json().get("source", "")
        raw_pairs = re.findall(r'\|([^=|\n]+)=([^|}\n]*)', source)
        
        weapon_dict: dict[str, Any] = {}
        
        for key, val in raw_pairs:
            key = key.strip()
            val = clean_value(val)
            
            # --- 1. EXCLUSION (Check RAW key first) ---
            if any(ex in key for ex in EXCLUDE_KEYS) or "预测" in key:
                continue
            
            # Check empty values (allowing 0 for numeric fields)
            if not val and key != "范围伤":
                continue

            # Special Logic: Reload While Firing
            if key == "边射边装":
                val = True 
            
            # Special Logic: Splash Radius
            if key == "范围伤":
                val = float(val) if val else 0

            # General numeric conversion
            if isinstance(val, str):
                if val.isdigit():
                    val = int(val)
                elif val.replace('.', '', 1).isdigit():
                    val = float(val)
            
            # --- 2. TRANSLATION ---
            # Translate Value
            if isinstance(val, str) and val in VALUE_TRANSLATIONS:
                val = VALUE_TRANSLATIONS[val]
            
            # Translate Key
            if key in KEY_TRANSLATIONS:
                translated_key = KEY_TRANSLATIONS[key]
            elif "面板伤害" in key:
                level = key.replace("面板伤害", "")
                translated_key = f"damage_{level}"
            else:
                translated_key = key # Keep raw if no translation found
            
            # --- 3. FORCE TRUE LOGIC ---
            # If these keys exist (after translation), set them to True regardless of the string value
            if translated_key in ["defense_bypass", "aim_lock"]:
                val = True

            weapon_dict[translated_key] = val
        
        # --- CLEAN UP DAMAGE VALUES ---
        max_bad_level = 0
        damage_keys = [k for k in weapon_dict if k.startswith("damage_")]
        
        for k in damage_keys:
            try:
                level = int(k.replace("damage_", ""))
                val = weapon_dict[k]
                if not isinstance(val, (int, float)):
                    if level > max_bad_level:
                        max_bad_level = level
            except ValueError:
                pass
        
        if max_bad_level > 0:
            for i in range(1, max_bad_level + 1):
                key_to_remove = f"damage_{i}"
                if key_to_remove in weapon_dict:
                    weapon_dict.pop(key_to_remove)

        # Default splash
        if "splash_radius" not in weapon_dict:
            weapon_dict["splash_radius"] = 0
        
        # --- FETCH EFFECT DATA ---
        # If weapon has an effect type that isn't "None", try to fetch effect values
        if "effect_type" in weapon_dict and weapon_dict["effect_type"] not in ["None", None]:
            if effect_data:
                effect_values = get_effect_values(weapon_name, effect_data)
                if effect_values:
                    weapon_dict.update(effect_values)
                    print(f"  → Found {len(effect_values)} effect values for {weapon_name}")
                else:
                    print(f"  → No effect data found for {weapon_name}")
            
        return weapon_dict
    except Exception as e:
        print(f"  → Error processing {weapon_name}: {e}")
        return None

def main():
    final_data = {}
    total = len(WEAPONS)
    
    # Fetch effect data once at the start
    effect_data = fetch_effect_data()
    if effect_data:
        print("Effect data loaded successfully!\n")
    else:
        print("Warning: Could not load effect data. Effect values will not be included.\n")
    
    for index, name in enumerate(WEAPONS):
        print(f"[{index+1}/{total}] Processing {name}...")
        data = get_weapon_data(name, effect_data)
        if data:
            final_data[name] = data
        time.sleep(0.1)

    with open("weapons.json", "w", encoding="utf-8") as f:
        json.dump(final_data, f, ensure_ascii=False, indent=4)
    print(f"\nFile 'weapons.json' has been generated with {len(final_data)} weapons.")

if __name__ == "__main__":
    main()