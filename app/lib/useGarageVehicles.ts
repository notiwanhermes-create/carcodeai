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

const STORAGE_KEY = "carcode_garage_v1";

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

function readStoredGarage(): StoredGarage | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  const parsed = safeJsonParse<StoredGarage>(raw);
  if (!parsed || !Array.isArray(parsed.garage)) return null;
  return {
    garage: parsed.garage || [],
    activeId: parsed.activeId ?? null,
  };
}

function writeStoredGarage(data: StoredGarage) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // ignore storage failures
  }
}

function normalizePart(s: string) {
  return s.trim().toLowerCase();
}

function normalizeVin(vin: string) {
  return vin.replace(/\s+/g, "").toUpperCase();
}

function vehicleMatchKey(v: GarageVehicle) {
  if (v.vin?.trim()) return `vin:${normalizeVin(v.vin)}`;
  return `spec:${normalizePart(v.year)}|${normalizePart(v.make)}|${normalizePart(v.model)}|${normalizePart(v.engine || "")}|${normalizePart(v.nickname || "")}`;
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

  const [vehicles, setVehicles] = useState<GarageVehicle[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const didInitialServerSync = useRef(false);
  const lastSyncedUserId = useRef<string | undefined>(undefined);

  useEffect(() => {
    const stored = readStoredGarage();
    if (stored) {
      setVehicles(stored.garage || []);
      setActiveId(stored.activeId || (stored.garage?.[0]?.id ?? null));
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    writeStoredGarage({ garage: vehicles, activeId });
  }, [activeId, hydrated, vehicles]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    function onStorage(e: StorageEvent) {
      if (e.key !== STORAGE_KEY) return;
      const stored = readStoredGarage();
      if (!stored) return;
      setVehicles(stored.garage || []);
      setActiveId(stored.activeId || (stored.garage?.[0]?.id ?? null));
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

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
    if (didInitialServerSync.current && lastSyncedUserId.current === userId) return;
    didInitialServerSync.current = true;
    lastSyncedUserId.current = userId;

    (async () => {
      setSyncing(true);
      try {
        const res = await fetch("/api/garage", { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || "Failed to load vehicles.");
        const remoteVehicles: GarageVehicle[] = Array.isArray(data?.vehicles) ? data.vehicles : [];

        const stored = readStoredGarage();
        const localVehicles = stored?.garage || [];
        const localActiveId = stored?.activeId ?? null;

        // Push local-only vehicles up to server (first login sync).
        const remoteByKey = new Map<string, GarageVehicle>();
        for (const v of remoteVehicles) remoteByKey.set(vehicleMatchKey(v), v);

        const created: GarageVehicle[] = [];
        for (const lv of localVehicles) {
          const key = vehicleMatchKey(lv);
          if (remoteByKey.has(key)) continue;
          const createRes = await fetch("/api/garage", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            cache: "no-store",
            body: JSON.stringify({
              year: lv.year,
              make: lv.make,
              model: lv.model,
              engine: lv.engine || undefined,
              vin: lv.vin || undefined,
              nickname: lv.nickname || undefined,
            }),
          });
          const createData = await createRes.json().catch(() => ({}));
          if (!createRes.ok) {
            // Non-fatal: keep going; we still want remote list displayed.
            continue;
          }
          const createdVehicle = createData?.vehicle as GarageVehicle | undefined;
          if (createdVehicle?.id) {
            created.push(createdVehicle);
            remoteByKey.set(vehicleMatchKey(createdVehicle), createdVehicle);
          }
        }

        // Keep any local-only vehicles that couldn't be created server-side (network/validation issues).
        const stillLocalOnly = localVehicles.filter((lv) => !remoteByKey.has(vehicleMatchKey(lv)));
        const finalVehicles = created.length
          ? [...created, ...remoteVehicles, ...stillLocalOnly]
          : [...remoteVehicles, ...stillLocalOnly];

        // Preserve the active selection across local→server ID translation.
        let nextActive: string | null = null;
        if (localActiveId) {
          const localActive = localVehicles.find((v) => v.id === localActiveId);
          if (localActive) {
            const key = vehicleMatchKey(localActive);
            const mapped = remoteByKey.get(key);
            if (mapped) nextActive = mapped.id;
          }
        }
        if (!nextActive) {
          nextActive = finalVehicles[0]?.id ?? null;
        }

        setVehicles(finalVehicles);
        setActiveId(nextActive);
      } finally {
        setSyncing(false);
      }
    })();
  }, [hydrated, serverEnabled, userId]);

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

