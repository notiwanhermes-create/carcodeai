/**
 * Car and light-truck makes offered in the garage form.
 *
 * This replaces NHTSA's full manufacturer registry (12,000+ entries, mostly
 * trailer, RV and one-off builders). NHTSA's name for each make is simply the
 * display name upper-cased, which is what the models lookup needs.
 * Safe to import from client components.
 */

export type VehicleMake = { name: string; popular?: boolean };

export const VEHICLE_MAKES: VehicleMake[] = [
  { name: "Acura" },
  { name: "Alfa Romeo" },
  { name: "Aston Martin" },
  { name: "Audi", popular: true },
  { name: "Bentley" },
  { name: "BMW", popular: true },
  { name: "Buick" },
  { name: "Cadillac", popular: true },
  { name: "Chevrolet", popular: true },
  { name: "Chrysler" },
  { name: "Daewoo" },
  { name: "Dodge", popular: true },
  { name: "Eagle" },
  { name: "Ferrari" },
  { name: "Fiat" },
  { name: "Fisker" },
  { name: "Ford", popular: true },
  { name: "Genesis" },
  { name: "Geo" },
  { name: "GMC", popular: true },
  { name: "Honda", popular: true },
  { name: "Hummer" },
  { name: "Hyundai", popular: true },
  { name: "INEOS" },
  { name: "Infiniti" },
  { name: "Isuzu" },
  { name: "Jaguar" },
  { name: "Jeep", popular: true },
  { name: "Karma" },
  { name: "Kia", popular: true },
  { name: "Lamborghini" },
  { name: "Land Rover" },
  { name: "Lexus", popular: true },
  { name: "Lincoln" },
  { name: "Lotus" },
  { name: "Lucid" },
  { name: "Maserati" },
  { name: "Maybach" },
  { name: "Mazda", popular: true },
  { name: "McLaren" },
  { name: "Mercedes-Benz", popular: true },
  { name: "Mercury" },
  { name: "MINI" },
  { name: "Mitsubishi" },
  { name: "Nissan", popular: true },
  { name: "Oldsmobile" },
  { name: "Plymouth" },
  { name: "Polestar" },
  { name: "Pontiac" },
  { name: "Porsche" },
  { name: "Ram", popular: true },
  { name: "Rivian" },
  { name: "Rolls-Royce" },
  { name: "Saab" },
  { name: "Saturn" },
  { name: "Scion" },
  { name: "smart" },
  { name: "Subaru", popular: true },
  { name: "Suzuki" },
  { name: "Tesla", popular: true },
  { name: "Toyota", popular: true },
  { name: "VinFast" },
  { name: "Volkswagen", popular: true },
  { name: "Volvo" },
];

/** Common ways people type a make, mapped to the listed name. */
const MAKE_ALIASES: Record<string, string> = {
  chevy: "Chevrolet",
  vw: "Volkswagen",
  mercedes: "Mercedes-Benz",
  "mercedes benz": "Mercedes-Benz",
  benz: "Mercedes-Benz",
  merc: "Mercedes-Benz",
  landrover: "Land Rover",
  "range rover": "Land Rover",
  alfa: "Alfa Romeo",
  "rolls royce": "Rolls-Royce",
  rolls: "Rolls-Royce",
  aston: "Aston Martin",
};

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const BY_NORMALIZED = new Map(VEHICLE_MAKES.map((m) => [norm(m.name), m.name]));

/**
 * The listed spelling of a make ("toyota", "TOYOTA", "chevy" -> "Toyota",
 * "Chevrolet"). Makes that are not on the list are returned as typed, trimmed:
 * entering an unlisted make is allowed.
 */
export function canonicalMakeName(raw: string): string {
  const key = norm(raw || "");
  if (!key) return "";
  return BY_NORMALIZED.get(key) ?? MAKE_ALIASES[key] ?? BY_NORMALIZED.get(key.replace(/-/g, " ")) ?? raw.trim();
}

/**
 * What to keep when the user leaves the Make field: the listed spelling, or —
 * when they typed the unmistakable start of exactly one listed make ("chev") —
 * that make. Anything else is kept as typed.
 */
export function completeMakeName(raw: string): string {
  const listed = canonicalMakeName(raw);
  const key = norm(raw || "");
  if (!key || BY_NORMALIZED.has(norm(listed))) return listed;
  const startsWith = VEHICLE_MAKES.filter((m) => norm(m.name).startsWith(key));
  return key.length >= 3 && startsWith.length === 1 ? startsWith[0].name : listed;
}

/** Makes matching what the user typed, best match first. Empty query: popular makes first. */
export function searchMakes(query: string): string[] {
  const q = norm(query || "");
  if (!q) {
    return [...VEHICLE_MAKES].sort((a, b) => Number(!!b.popular) - Number(!!a.popular) || a.name.localeCompare(b.name)).map((m) => m.name);
  }
  const scored: Array<{ name: string; score: number }> = [];
  const alias = MAKE_ALIASES[q];
  for (const m of VEHICLE_MAKES) {
    const n = norm(m.name);
    let score = 0;
    if (n === q || m.name === alias) score = 1000;
    else if (n.startsWith(q)) score = 700;
    else if (n.includes(` ${q}`) || n.includes(`-${q}`)) score = 500;
    else if (n.includes(q)) score = 200;
    if (score > 0) scored.push({ name: m.name, score: score + (m.popular ? 1 : 0) });
  }
  return scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).map((x) => x.name);
}
