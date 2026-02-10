import type { MetadataRoute } from "next";

const SITE = "https://www.carcodeai.com";

// Add your most important codes here (you can expand later)
const TOP_CODES = [
  "p0300",
  "p0420",
  "p0171",
  "p0455",
  "p0442",
  "p0128",
  "p0133",
  "p0401",
  "p0301",
  "p0302",
];

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();

  return [
    { url: `${SITE}/`, lastModified: now, changeFrequency: "daily", priority: 1 },
    { url: `${SITE}/codes`, lastModified: now, changeFrequency: "weekly", priority: 0.8 },
    ...TOP_CODES.map((c) => ({
      url: `${SITE}/codes/${c}`,
      lastModified: now,
      changeFrequency: "monthly" as const,
      priority: 0.7,
    })),
  ];
}
