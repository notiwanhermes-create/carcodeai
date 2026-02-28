/**
 * Normalize vehicle make for logo lookup. Aliases map to canonical keys
 * that match filenames in /public/make-logos/{key}.svg
 */
export const MAKE_ALIASES: Record<string, string> = {
  mercedes: "mercedes-benz",
  "mercedes benz": "mercedes-benz",
  "mercedes-benz": "mercedes-benz",
  vw: "volkswagen",
  "land rover": "land-rover",
  landrover: "land-rover",
  "range rover": "land-rover",
  chevy: "chevrolet",
  bently: "bentley",
};

/** Filename stems (no extension) for logo files in /public/make-logos/{key}.svg */
const MAKES_WITH_LOGOS = new Set([
  "acura", "audi", "bentley", "bmw", "buick", "cadillac", "chevrolet", "chrysler",
  "dodge", "ford", "gmc", "honda", "hyundai", "infiniti", "jaguar", "jeep", "kia",
  "land-rover", "lexus", "lincoln", "mazda", "mercedes", "mini", "mitsubishi",
  "nissan", "porsche", "ram", "subaru", "tesla", "toyota", "volkswagen", "volvo",
]);

export function normalizeMake(make?: string): string {
  const raw = (make ?? "").trim().toLowerCase();
  if (!raw) return "";
  const withHyphens = raw.replace(/\s+/g, "-");
  return MAKE_ALIASES[raw] ?? MAKE_ALIASES[withHyphens] ?? withHyphens;
}

/**
 * Returns the logo path for the make, or null if no logo file exists.
 * Uses .svg assets in /public/make-logos/
 */
export function getMakeLogo(make?: string): string | null {
  const key = normalizeMake(make);
  if (!key) return null;
  // mercedes-benz and mercedes both use mercedes.svg
  const fileKey = key === "mercedes-benz" ? "mercedes" : key;
  if (!MAKES_WITH_LOGOS.has(fileKey)) return null;
  return `/make-logos/${fileKey}.svg`;
}
