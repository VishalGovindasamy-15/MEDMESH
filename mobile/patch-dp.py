import sys

p = 'src/components/DistrictPicker.tsx'
s = open(p).read()

old = """export interface PickerDistrict {
  id: number;
  name: string;
  /** English name where the API also returns a Tamil one. */
  name_ta?: string | null;
  headquarters?: string | null;
  facilities: number;
}"""
new = """export interface PickerDistrict {
  id: number;
  name: string;
  /** English name where the API also returns a Tamil one. */
  name_ta?: string | null;
  headquarters?: string | null;
  facilities: number;
  /**
   * What the `facilities` count is counting, when it is not facilities.
   * The doctors directory passes its own per-district clinician counts through
   * the same field; the row then says "183 clinicians" instead of "183
   * facilities", which would be simply wrong on that screen.
   */
  countUnit?: string | null;
}"""
if s.count(old) != 1:
    sys.exit(f'FAIL interface: {s.count(old)}')
s = s.replace(old, new)

old = """export function DistrictPicker({
  districts,
  value,
  onPick,
  onClose,
}: {
  districts: PickerDistrict[];
  value: number | null;
  onPick: (id: number | null) => void;
  onClose: () => void;
}) {"""
new = """export function DistrictPicker({
  districts,
  value,
  onPick,
  onClose,
  hideAll = false,
}: {
  districts: PickerDistrict[];
  value: number | null;
  onPick: (id: number | null) => void;
  onClose: () => void;
  /**
   * Suppress the "All districts" row.
   *
   * "All districts" is a filter concept. A jurisdiction field — the district a
   * dispatcher is scoped to, the base district of a vehicle, the district of a
   * facility being onboarded — has no meaningful "all", and offering one there
   * is an option that silently does nothing when tapped (the field maps to a
   * single id). Filters keep the row; forms lose it.
   */
  hideAll?: boolean;
}) {"""
if s.count(old) != 1:
    sys.exit(f'FAIL signature: {s.count(old)}')
s = s.replace(old, new)

old = """      <ScrollView style={{ maxHeight: 320 }} keyboardShouldPersistTaps="handled">
        <Pressable
          onPress={() => onPick(null)}"""
new = """      <ScrollView style={{ maxHeight: 320 }} keyboardShouldPersistTaps="handled">
        {hideAll ? null : (
        <Pressable
          onPress={() => onPick(null)}"""
if s.count(old) != 1:
    sys.exit(f'FAIL scrollview: {s.count(old)}')
s = s.replace(old, new)

old = """          </Pressable>

        {rows.map((d) => {"""
new = """          </Pressable>
        )}

        {rows.map((d) => {"""
if s.count(old) != 1:
    sys.exit(f'FAIL closer: {s.count(old)}')
s = s.replace(old, new)

open(p, 'w').write(s)
print('DistrictPicker ok')
