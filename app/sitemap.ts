import type { MetadataRoute } from "next";
import { COMMON_CODES } from "./data/common-codes";

const SITE = "https://www.carcodeai.com";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();

  return [
    { url: `${SITE}/`, lastModified: now, changeFrequency: "daily", priority: 1 },
    { url: `${SITE}/codes`, lastModified: now, changeFrequency: "weekly", priority: 0.8 },
    ...COMMON_CODES.map((c) => ({
      url: `${SITE}/codes/${c.code.toLowerCase()}`,
      lastModified: now,
      changeFrequency: "monthly" as const,
      priority: 0.7,
    })),
  ];
}
