"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type GarageVehicle = {
  id: string;
  year: string;
  make: string;
  model: string;
  engine?: string;
  vin?: string;
  nickname?: string;
};

type StoredGarage = { garage: GarageVehicle[]; activeId: string | null };

const STORAGE_PREFIX = "carcode_garage_v1";

function storageKeyForUser(userId?: string) {
  return userId?.trim() ? `${STORAGE_PREFIX}:user:${userId.trim()}` : `${STORAGE_PREFIX}:anon`;
}

function uid() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? (crypto as any).randomUUID()
    : Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function safeJsonParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function readStoredGarage(key: string): StoredGarage | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(key);
  if (!raw) return null;
  const parsed = safeJsonParse<StoredGarage>(raw);
  if (!parsed || !Array.isArray(parsed.garage)) return null;
  return {
    garage: parsed.garage || [],
    activeId: parsed.activeId ?? null,
  };
}

function writeStoredGarage(key: string, data: StoredGarage) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(data));
  } catch {
    // ignore storage failures
  }
}

type UseGarageVehiclesArgs = {
  userId?: string;
};

type UseGarageVehiclesResult = {
  vehicles: GarageVehicle[];
  activeId: string | null;
  setActiveId: (id: string | null) => void;
  hydrated: boolean;
  syncing: boolean;
  refresh: () => Promise<void>;
  addVehicle: (input: Omit<GarageVehicle, "id">) => Promise<GarageVehicle>;
  deleteVehicle: (id: string) => Promise<void>;
};

export function useGarageVehicles({ userId }: UseGarageVehiclesArgs = {}): UseGarageVehiclesResult {
  const serverEnabled = Boolean(userId);
  const storageKey = storageKeyForUser(userId);

  const [vehicles, setVehicles] = useState<GarageVehicle[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const didInitialServerFetch = useRef(false);
  const prevStorageKey = useRef<string>(storageKey);

  useEffect(() => {
    // Clear previous account's cached garage on user change/sign-out (privacy).
    if (typeof window !== "undefined" && prevStorageKey.current !== storageKey) {
      try {
        window.localStorage.removeItem(prevStorageKey.current);
      } catch {}
      prevStorageKey.current = storageKey;
    }

    const stored = readStoredGarage(storageKey);
    if (stored) {
      setVehicles(stored.garage || []);
      setActiveId(stored.activeId || (stored.garage?.[0]?.id ?? null));
    } else {
      setVehicles([]);
      setActiveId(null);
    }
    setHydrated(true);
    // Reset server fetch flag when user changes.
    didInitialServerFetch.current = false;
  }, [storageKey]);

  useEffect(() => {
    if (!hydrated) return;
    writeStoredGarage(storageKey, { garage: vehicles, activeId });
  }, [activeId, hydrated, storageKey, vehicles]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    function onStorage(e: StorageEvent) {
      if (e.key !== storageKey) return;
      const stored = readStoredGarage(storageKey);
      if (!stored) return;
      setVehicles(stored.garage || []);
      setActiveId(stored.activeId || (stored.garage?.[0]?.id ?? null));
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [storageKey]);

  const refresh = useCallback(async () => {
    if (!serverEnabled) return;
    setSyncing(true);
    try {
      const res = await fetch("/api/garage", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Failed to load vehicles.");
      const remoteVehicles: GarageVehicle[] = Array.isArray(data?.vehicles) ? data.vehicles : [];

      setVehicles(remoteVehicles);
      setActiveId((prevActive) => {
        if (prevActive && remoteVehicles.some((v) => v.id === prevActive)) return prevActive;
        return remoteVehicles[0]?.id ?? null;
      });
    } finally {
      setSyncing(false);
    }
  }, [serverEnabled]);

  useEffect(() => {
    if (!hydrated) return;
    if (!serverEnabled) return;
    if (didInitialServerFetch.current) return;
    didInitialServerFetch.current = true;

    // Security: do NOT auto-import anon/local vehicles into an authenticated account.
    // Instead, fetch the server-owned list for the current session user.
    void refresh();
  }, [hydrated, refresh, serverEnabled]);

  const addVehicle = useCallback(
    async (input: Omit<GarageVehicle, "id">) => {
      if (!input.year || !input.make || !input.model) {
        throw new Error("Year, make, and model are required.");
      }

      if (!serverEnabled) {
        const v: GarageVehicle = {
          id: uid(),
          year: input.year,
          make: input.make,
          model: input.model,
          engine: input.engine || undefined,
          vin: input.vin || undefined,
          nickname: input.nickname || undefined,
        };
        setVehicles((prev) => [v, ...prev]);
        setActiveId(v.id);
        return v;
      }

      setSyncing(true);
      try {
        const res = await fetch("/api/garage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          cache: "no-store",
          body: JSON.stringify({
            year: input.year,
            make: input.make,
            model: input.model,
            engine: input.engine || undefined,
            vin: input.vin || undefined,
            nickname: input.nickname || undefined,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || "Failed to add vehicle.");
        const v = data?.vehicle as GarageVehicle | undefined;
        if (!v?.id) throw new Error("Failed to add vehicle.");

        setVehicles((prev) => {
          const next = [v, ...prev.filter((x) => x.id !== v.id)];
          return next;
        });
        setActiveId(v.id);
        return v;
      } finally {
        setSyncing(false);
      }
    },
    [serverEnabled],
  );

  const deleteVehicle = useCallback(
    async (id: string) => {
      if (!id) return;

      if (serverEnabled) {
        setSyncing(true);
        try {
          const res = await fetch(`/api/garage/${encodeURIComponent(id)}`, {
            method: "DELETE",
            cache: "no-store",
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            // If it doesn't exist server-side, still remove locally.
            if (res.status !== 404) throw new Error(data?.error || "Failed to delete vehicle.");
          }
        } finally {
          setSyncing(false);
        }
      }
      setVehicles((prev) => {
        const nextVehicles = prev.filter((v) => v.id !== id);
        setActiveId((prevActive) => (prevActive === id ? nextVehicles[0]?.id ?? null : prevActive));
        return nextVehicles;
      });
    },
    [serverEnabled],
  );

  return {
    vehicles,
    activeId,
    setActiveId,
    hydrated,
    syncing,
    refresh,
    addVehicle,
    deleteVehicle,
  };
}

