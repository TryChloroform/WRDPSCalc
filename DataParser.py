import re
import csv
from typing import Dict, List, Any
import argparse

def extract_value(text: str, key: str) -> str:
    """Extract value for a given key from wiki template format."""
    pattern = rf'\|{re.escape(key)}\s*=\s*([^\n|]*)'
    match = re.search(pattern, text, re.IGNORECASE)
    if match:
        value = match.group(1).strip()
        # Filter out template syntax artifacts
        if value and not value.startswith('}}') and not value.startswith('{{'):
            # Remove commas from numbers
            value = value.replace(',', '')
            return value
    return ""


def parse_weapon(weapon_text: str) -> Dict[str, Any]:
    """Parse a single weapon entry from wiki template format."""
    data = {
        'Name': extract_value(weapon_text, 'name'),
        'ID': extract_value(weapon_text, 'ID'),
        'Tier': extract_value(weapon_text, 'Tier'),
        'Range': extract_value(weapon_text, 'Range'),
        'Slot': extract_value(weapon_text, 'Slot'),
        'Reload': extract_value(weapon_text, 'Reload'),
        'Shot Interval': extract_value(weapon_text, 'Shot Interval'),
        'Shot Subinterval': extract_value(weapon_text, 'Shot Subinterval'),
        'AOE': extract_value(weapon_text, 'AOE'),
        'Ammo': extract_value(weapon_text, 'Ammo'),
        'Particles per Shot': extract_value(weapon_text, 'Particles per Shot'),
        'Attribute2': extract_value(weapon_text, 'Attribute2'),
        'Attribute3': extract_value(weapon_text, 'Attribute3'),
        'Attribute4': extract_value(weapon_text, 'Attribute4'),
        'Attribute5': extract_value(weapon_text, 'Attribute5'),
        'Attribute6': extract_value(weapon_text, 'Attribute6'),
    }
    # Extract damage levels for regular levels (1-12)
    for i in range(1, 13):
        shot_value = extract_value(weapon_text, f'shot{i}')
        data[f'Lv{i}_Damage'] = shot_value if shot_value else ""
    
    # Extract MK2 levels (1-12) - also accept shot13-shot24 format
    for i in range(1, 13):
        shot_value = extract_value(weapon_text, f'mk2shot{i}')
        if not shot_value:
            shot_value = extract_value(weapon_text, f'shot{i + 12}')
        data[f'MK2_Lv{i}_Damage'] = shot_value if shot_value else ""
    
    # Extract MK3 level (only level 1) - also accept shot25 format
    shot_value = extract_value(weapon_text, f'mk3shot1')
    if not shot_value:
        shot_value = extract_value(weapon_text, f'shot25')
    data[f'MK3_Lv1_Damage'] = shot_value if shot_value else ""
    
    return data

def split_weapons(file_content: str) -> List[str]:
    """Split the file content into individual weapon entries."""
    # Split by weapon name pattern (e.g., |Punisher = {{Weapon Stat or |Ultimate Orkan = {{Weapon Stat)
    # This regex finds weapon separators - matches any characters (including spaces) for weapon name
    pattern = r'\|([^=]+?)\s*=\s*\{\{Weapon Stat'
    
    # Find all weapon start positions
    matches = list(re.finditer(pattern, file_content))
    
    if not matches:
        return []
    
    weapons = []
    for i, match in enumerate(matches):
        start = match.start()
        # End is either the start of next weapon or end of file
        end = matches[i + 1].start() if i + 1 < len(matches) else len(file_content)
        weapon_text = file_content[start:end]
        weapons.append(weapon_text)
    
    return weapons

def parse_weapon_file(file_path: str, output_path: str = 'weapons_parsed.csv'):
    """
    Parse a text file containing multiple weapon entries and export to CSV.
    
    Args:
        file_path: Path to the input text file
        output_path: Path for the output CSV file (default: weapons_parsed.csv)
    """
    try:
        # Read the file
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
        
        # Split into individual weapons
        weapons = split_weapons(content)
        
        if not weapons:
            print("No weapons found in the file. Check the file format.")
            return
        
        print(f"Found {len(weapons)} weapon(s) to parse...")
        
        # Parse each weapon
        parsed_weapons = []
        for i, weapon_text in enumerate(weapons, 1):
            try:
                weapon_data = parse_weapon(weapon_text)
                if weapon_data['Name']:  # Only add if name exists
                    parsed_weapons.append(weapon_data)
                    print(f"  ✓ Parsed: {weapon_data['Name']}")
                else:
                    print(f"  ⚠ Skipped weapon {i}: No name found")
            except Exception as e:
                print(f"  ✗ Error parsing weapon {i}: {e}")
        
        if not parsed_weapons:
            print("No valid weapons parsed.")
            return
        
        # Get all column names
        all_columns = list(parsed_weapons[0].keys())
        
        # Export to CSV
        with open(output_path, 'w', newline='', encoding='utf-8') as csvfile:
            writer = csv.DictWriter(csvfile, fieldnames=all_columns)
            writer.writeheader()
            writer.writerows(parsed_weapons)
        
        print(f"\n✓ Successfully exported {len(parsed_weapons)} weapon(s) to {output_path}")
        
        # Print summary
        print("\nSummary:")
        print(f"  Total weapons: {len(parsed_weapons)}")
        print(f"  Total columns: {len(all_columns)}")
        print(f"  Weapons: {', '.join([w['Name'] for w in parsed_weapons if w.get('Name')])}")
        
    except FileNotFoundError:
        print(f"Error: File '{file_path}' not found.")
    except Exception as e:
        print(f"Error: {e}")

def main():
    parser = argparse.ArgumentParser(description='Parse weapon data from a text file and export to CSV.')
    parser.add_argument('input_file', nargs='?', default='weapons.txt', help='Path to the input text file containing weapon data (default: weapons.txt).')
    parser.add_argument('output_file', nargs='?', default='weapons.csv', help='Path for the output CSV file (default: weapons.csv).')
    
    args = parser.parse_args()
    
    parse_weapon_file(args.input_file, args.output_file)

if __name__ == "__main__":
    main()