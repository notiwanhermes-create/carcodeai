/**
 * Maps vehicle make (lowercase key) to logo path under /public.
 * Add files to public/make-logos/ (e.g. bmw.svg or bmw.png).
 * Inline SVGs (data URLs) are used for makes that must show without a network request.
 */
const BMW_LOGO_INLINE =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none"><circle cx="16" cy="16" r="14" stroke="#fff" stroke-width="1.5" fill="rgba(255,255,255,0.08)"/><text x="16" y="21" text-anchor="middle" fill="#93c5fd" font-size="14" font-weight="700" font-family="system-ui,sans-serif">B</text></svg>'
  );

export const MAKE_LOGOS: Record<string, string> = {
  bmw: BMW_LOGO_INLINE,
  audi: "/make-logos/audi.svg",
  mercedes: "/make-logos/mercedes.svg",
  "mercedes-benz": "/make-logos/mercedes.svg",
  toyota: "/make-logos/toyota.svg",
  honda: "/make-logos/honda.svg",
  ford: "/make-logos/ford.svg",
  chevrolet: "/make-logos/chevrolet.svg",
  nissan: "/make-logos/nissan.svg",
  volkswagen: "/make-logos/volkswagen.svg",
  vw: "/make-logos/volkswagen.svg",
  hyundai: "/make-logos/hyundai.svg",
  kia: "/make-logos/kia.svg",
  mazda: "/make-logos/mazda.svg",
  subaru: "/make-logos/subaru.svg",
  jeep: "/make-logos/jeep.svg",
  ram: "/make-logos/ram.svg",
  gmc: "/make-logos/gmc.svg",
  lexus: "/make-logos/lexus.svg",
  acura: "/make-logos/acura.svg",
  infiniti: "/make-logos/infiniti.svg",
  cadillac: "/make-logos/cadillac.svg",
  buick: "/make-logos/buick.svg",
  chrysler: "/make-logos/chrysler.svg",
  dodge: "/make-logos/dodge.svg",
  volvo: "/make-logos/volvo.svg",
  "land rover": "/make-logos/land-rover.svg",
  landrover: "/make-logos/land-rover.svg",
  jaguar: "/make-logos/jaguar.svg",
  porsche: "/make-logos/porsche.svg",
  mini: "/make-logos/mini.svg",
  bently: "/make-logos/bentley.svg",
  bentley: "/make-logos/bentley.svg",
};

/** Normalize make to lookup key (trim + lowercase; spaces → hyphens for "mercedes-benz"). */
export function getMakeLogo(make?: string): string | null {
  if (!make) return null;
  const makeKey = make.trim().toLowerCase();
  const keyWithHyphens = makeKey.replace(/\s+/g, "-");
  return MAKE_LOGOS[keyWithHyphens] ?? MAKE_LOGOS[makeKey] ?? null;
}
