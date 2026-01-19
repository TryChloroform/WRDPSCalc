from flask import Flask, render_template, request, jsonify
import csv
import math

app = Flask(__name__, template_folder='.', static_folder='.')

# Global weapons data
weapons_data = {}

def load_weapons_csv():
    """Load weapons data from CSV file"""
    global weapons_data
    weapons_data = {}
    
    try:
        with open('weapons.csv', 'r', encoding='utf-8') as f:
            reader = csv.reader(f)
            header = next(reader)
            
            for row in reader:
                if len(row) < 41:
                    continue
                
                name = row[0].strip()
                weapon = {
                    'ID': row[1],
                    'Tier': row[2],
                    'Range': row[3],
                    'Slot': row[4],
                    'Reload': float(row[5]) if row[5] else 0,
                    'Shot Interval': float(row[6]) if row[6] else 0,
                    'Shot Subinterval': float(row[7]) if row[7] else 0,
                    'AOE': row[8],
                    'Ammo': int(row[9]) if row[9] else 1,
                    'Particles per Shot': int(row[10]) if row[10] else 1,
                    'Attribute2': row[11],
                    'Attribute3': row[12],
                    'Attribute4': row[13],
                    'Attribute5': row[14],
                    'Attribute6': row[15],
                    'levels': {}
                }
                
                # Parse damage levels
                level_names = [
                    'Lv1', 'Lv2', 'Lv3', 'Lv4', 'Lv5', 'Lv6', 'Lv7', 'Lv8', 'Lv9', 'Lv10', 'Lv11', 'Lv12',
                    'MK2_Lv1', 'MK2_Lv2', 'MK2_Lv3', 'MK2_Lv4', 'MK2_Lv5', 'MK2_Lv6', 
                    'MK2_Lv7', 'MK2_Lv8', 'MK2_Lv9', 'MK2_Lv10', 'MK2_Lv11', 'MK2_Lv12',
                    'MK3_Lv1'
                ]
                
                for idx, level_name in enumerate(level_names):
                    value = row[16 + idx]
                    if value and value.strip():
                        weapon['levels'][level_name] = float(value.strip())
                
                weapons_data[name] = weapon
        
        print(f"Loaded {len(weapons_data)} weapons")
    except Exception as e:
        print(f"Error loading weapons.csv: {e}")

@app.route('/')
def index():
    """Serve the main HTML file"""
    return render_template('index.html')

@app.route('/api/weapons-data')
def get_weapons_data():
    """Return all weapons data for populating dropdowns"""
    return jsonify(weapons_data)

@app.route('/api/calculate-ttk', methods=['POST'])
def calculate_ttk():
    """Calculate TTK for given weapon configuration"""
    try:
        data = request.json
        enemy_health = float(data['enemyHealth'])
        weapon_configs = data['weapons']
        
        weapons = []
        for config in weapon_configs:
            weapon_name = config['name']
            level = config['level']
            
            if weapon_name not in weapons_data:
                return jsonify({'error': f'Weapon {weapon_name} not found'}), 400
            
            weapon_data = weapons_data[weapon_name]
            if level not in weapon_data['levels']:
                return jsonify({'error': f'Level {level} not found for {weapon_name}'}), 400
            
            # Check if weapon has "Reloads while firing" attribute
            reloads_while_firing = weapon_data.get('Attribute4', '').strip().lower() == 'reloads while firing'
            
            weapons.append({
                'name': weapon_name,
                'damage': weapon_data['levels'][level],
                'shot_interval': weapon_data['Shot Interval'],
                'shot_subinterval': weapon_data['Shot Subinterval'],
                'reload': weapon_data['Reload'],
                'ammo': weapon_data['Ammo'],
                'particles_per_shot': weapon_data['Particles per Shot'],
                'current_ammo': weapon_data['Ammo'],
                'max_ammo': weapon_data['Ammo'],
                'reloads_while_firing': reloads_while_firing,
                'next_shot_time': 0.0,
                'total_bursts': 0,
                'reload_cycles': 0,
                'total_reload_time': 0.0
            })
        
        # Run the simulation
        current_health = enemy_health
        current_time = 0.0
        max_iterations = 1000000  # Safety limit to prevent infinite loops
        iterations = 0
        
        while current_health > 0 and iterations < max_iterations:
            iterations += 1
            
            # Find next shot time
            next_event = float('inf')
            for weapon in weapons:
                if weapon['next_shot_time'] < next_event:
                    next_event = weapon['next_shot_time']
            
            if next_event == float('inf'):
                break
            
            current_time = next_event
            
            # Fire weapons at current time
            for weapon in weapons:
                if current_time >= weapon['next_shot_time'] and weapon['current_ammo'] > 0:
                    # Fire this burst/shot
                    current_health -= weapon['damage']
                    weapon['total_bursts'] += 1
                    weapon['current_ammo'] -= 1
                    
                    if weapon['current_ammo'] <= 0:
                        # Out of ammo - need to reload
                        weapon['reload_cycles'] += 1
                        weapon['total_reload_time'] += weapon['reload']
                        
                        if weapon['reloads_while_firing']:
                            # Reload while firing: ammo restores gradually during reload time
                            # Next shot available after reload_time / max_ammo for each round
                            time_per_round = weapon['reload'] / weapon['max_ammo']
                            weapon['current_ammo'] = weapon['max_ammo']
                            weapon['next_shot_time'] = current_time + time_per_round
                        else:
                            # Standard reload: must wait full reload time
                            weapon['current_ammo'] = weapon['max_ammo']
                            weapon['next_shot_time'] = current_time + weapon['reload']
                    else:
                        # Still have ammo - schedule next shot normally
                        weapon['next_shot_time'] = current_time + weapon['shot_interval'] + \
                            (weapon['particles_per_shot'] - 1) * weapon['shot_subinterval']
        
        # Calculate totals
        total_bursts = sum(w['total_bursts'] for w in weapons)
        total_damage = sum(w['total_bursts'] * w['damage'] for w in weapons)
        dps = round(total_damage / current_time) if current_time > 0 else 0
        
        # Verify damage exceeds enemy health
        if total_damage < enemy_health:
            return jsonify({
                'error': f'Total damage ({round(total_damage)}) less than enemy health ({enemy_health})'
            }), 400
        
        # Build weapon breakdown
        breakdown = []
        for w in weapons:
            breakdown.append({
                'name': w['name'],
                'bursts': w['total_bursts'],
                'damage': round(w['total_bursts'] * w['damage']),
                'reloads': w['reload_cycles'],
                'reload_time': round(w['total_reload_time'] * 100) / 100
            })
        
        return jsonify({
            'success': True,
            'ttk': round(current_time * 100) / 100,
            'total_shots': total_bursts,
            'total_damage': round(total_damage),
            'dps': dps,
            'breakdown': breakdown
        })
    
    except Exception as e:
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    load_weapons_csv()
    app.run(debug=True, port=5000)
