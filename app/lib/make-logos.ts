/**
 * Maps vehicle make (lowercase key) to logo path under /public.
 * Add or replace files in /public/make-logos/ (e.g. bmw.png, audi.svg).
 */
export const MAKE_LOGOS: Record<string, string> = {
  bmw: "/make-logos/bmw.svg",
  audi: "/make-logos/audi.svg",
  mercedes: "/make-logos/mercedes.svg",
  mercedes-benz: "/make-logos/mercedes.svg",
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
  land rover: "/make-logos/land-rover.svg",
  landrover: "/make-logos/land-rover.svg",
  jaguar: "/make-logos/jaguar.svg",
  porsche: "/make-logos/porsche.svg",
  mini: "/make-logos/mini.svg",
  bently: "/make-logos/bentley.svg",
  bentley: "/make-logos/bentley.svg",
};

export function getMakeLogo(make?: string): string | null {
  if (!make) return null;
  const raw = make.trim().toLowerCase();
  const keyWithHyphens = raw.replace(/\s+/g, "-");
  return MAKE_LOGOS[keyWithHyphens] ?? MAKE_LOGOS[raw] ?? null;
}
