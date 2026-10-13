"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sameVehicle } from "./garage-import";
import type { VehicleStats } from "./garage-types";

export type GarageVehicle = {
  id: string;
  year: string;
  make: string;
  model: string;
  engine?: string;
  vin?: string;
  nickname?: string;
  /** The rest is only present for a signed-in user's vehicles, which come from the account. */
  trim?: string;
  odometerValue?: number | null;
  odometerUnit?: "km" | "mi" | null;
  archivedAt?: string | null;
  stats?: VehicleStats;
};

type StoredGarage = { garage: GarageVehicle[]; activeId: string | null };

const STORAGE_PREFIX = "carcode_garage_v1";
const ANON_STORAGE_KEY = `${STORAGE_PREFIX}:anon`;
const DISMISSED_IMPORT_PREFIX = "carcode_guest_import_dismissed_v1";

function storageKeyForUser(userId?: string) {
  return userId?.trim() ? `${STORAGE_PREFIX}:user:${userId.trim()}` : ANON_STORAGE_KEY;
}

function uid(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
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
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(key);
  } catch {
    return null;
  }
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

/**
 * Remove every account's cached vehicle list from this browser except the one
 * for `keepKey` (the signed-in account's own). A guest keeps none.
 *
 * The cache only exists so a signed-in page does not start out empty; the
 * account is the source of truth and the list is reloaded from it every time.
 * Sweeping here, on every load, means a list is gone as soon as the app is
 * opened signed out or as someone else, including after a sign-out that
 * reloaded the page. The guest garage is a different key and is never touched.
 */
function dropAccountCaches(keepKey: string | null) {
  if (typeof window === "undefined") return;
  try {
    for (let i = window.localStorage.length - 1; i >= 0; i--) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith(`${STORAGE_PREFIX}:user:`) && key !== keepKey) window.localStorage.removeItem(key);
    }
  } catch {
    // ignore storage failures
  }
}

function readDismissedGuestIds(userId: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(`${DISMISSED_IMPORT_PREFIX}:user:${userId}`);
    const parsed = raw ? safeJsonParse<unknown>(raw) : null;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeDismissedGuestIds(userId: string, ids: string[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(`${DISMISSED_IMPORT_PREFIX}:user:${userId}`, JSON.stringify(Array.from(new Set(ids))));
  } catch {
    // ignore storage failures
  }
}

/**
 * Two entries describe the same vehicle when their VINs match, or, when a VIN
 * is missing on either side, when year, make, model and engine all match.
 * The server uses the same rule when it imports a device's vehicles.
 */
export function isSameVehicle(a: Omit<GarageVehicle, "id">, b: Omit<GarageVehicle, "id">): boolean {
  return sameVehicle(a, b);
}

/** What the server did with one vehicle of a device import. */
export type DeviceImportOutcomeKind = "imported" | "attached" | "duplicate" | "failed";

type UseGarageVehiclesArgs = {
  userId?: string;
  /**
   * Pass false while the session is still being checked. Nothing is loaded
   * until it is known whether this is a guest or a signed-in user, so a
   * signed-in user never briefly sees the guest garage.
   */
  ready?: boolean;
};

type UseGarageVehiclesResult = {
  vehicles: GarageVehicle[];
  activeId: string | null;
  setActiveId: (id: string | null) => void;
  hydrated: boolean;
  syncing: boolean;
  refresh: () => Promise<void>;
  addVehicle: (input: Omit<GarageVehicle, "id">) => Promise<GarageVehicle>;
  /**
   * Remove a vehicle from the garage. For a signed-in user the server archives
   * a vehicle that has history and deletes one that has none; `archived` says which.
   */
  deleteVehicle: (id: string) => Promise<{ archived: boolean }>;
  /** Signed-in only: vehicles saved on this device as a guest that the user has not imported or dismissed. */
  guestVehicles: GarageVehicle[];
  /**
   * After a device import: take the vehicles the account now has off the device,
   * stop offering the ones it already had, and reload the account's list.
   * Anything that was not imported stays on the device exactly as it was.
   */
  finishDeviceImport: (outcomes: Array<{ clientId: string; outcome: DeviceImportOutcomeKind }>) => Promise<void>;
  dismissGuestVehicles: () => void;
};

export function useGarageVehicles({ userId, ready = true }: UseGarageVehiclesArgs = {}): UseGarageVehiclesResult {
  const serverEnabled = Boolean(userId);
  const storageKey = storageKeyForUser(userId);

  const [vehicles, setVehicles] = useState<GarageVehicle[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  // Which storage key the current `vehicles` state was loaded from. Writes are
  // only allowed back to that same key, so one account's (or the guest's)
  // vehicles can never be written into another's storage during a switch.
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [guestStored, setGuestStored] = useState<GarageVehicle[]>([]);
  const [dismissedGuestIds, setDismissedGuestIds] = useState<string[]>([]);
  const didInitialServerFetch = useRef(false);

  const hydrated = ready && loadedKey === storageKey;

  useEffect(() => {
    if (!ready) return;

    // Signed out, or signed in as someone else: no other account's cached list
    // stays in this browser (privacy on shared devices; the server still has it).
    dropAccountCaches(storageKey === ANON_STORAGE_KEY ? null : storageKey);

    const stored = readStoredGarage(storageKey);
    setVehicles(stored?.garage || []);
    setActiveId(stored ? stored.activeId || (stored.garage?.[0]?.id ?? null) : null);
    setLoadedKey(storageKey);
    // Reset server fetch flag when user changes.
    didInitialServerFetch.current = false;
  }, [ready, storageKey]);

  useEffect(() => {
    if (!hydrated) return;
    writeStoredGarage(storageKey, { garage: vehicles, activeId });
  }, [activeId, hydrated, storageKey, vehicles]);

  // Guest vehicles left on this device, offered for import once signed in.
  useEffect(() => {
    if (!ready || !userId) {
      setGuestStored([]);
      setDismissedGuestIds([]);
      return;
    }
    setGuestStored(readStoredGarage(ANON_STORAGE_KEY)?.garage || []);
    setDismissedGuestIds(readDismissedGuestIds(userId));
  }, [ready, userId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    function onStorage(e: StorageEvent) {
      if (e.key === ANON_STORAGE_KEY && userId) {
        setGuestStored(readStoredGarage(ANON_STORAGE_KEY)?.garage || []);
      }
      if (e.key !== storageKey) return;
      const stored = readStoredGarage(storageKey);
      if (!stored) return;
      setVehicles(stored.garage || []);
      setActiveId(stored.activeId || (stored.garage?.[0]?.id ?? null));
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [storageKey, userId]);

  const fetchServerVehicles = useCallback(async (): Promise<GarageVehicle[]> => {
    const res = await fetch("/api/garage", { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || "Failed to load vehicles.");
    return Array.isArray(data?.vehicles) ? (data.vehicles as GarageVehicle[]) : [];
  }, []);

  const refresh = useCallback(async () => {
    if (!serverEnabled) return;
    setSyncing(true);
    try {
      const remoteVehicles = await fetchServerVehicles();
      setVehicles(remoteVehicles);
      setActiveId((prevActive) => {
        if (prevActive && remoteVehicles.some((v) => v.id === prevActive)) return prevActive;
        return remoteVehicles[0]?.id ?? null;
      });
    } finally {
      setSyncing(false);
    }
  }, [fetchServerVehicles, serverEnabled]);

  useEffect(() => {
    if (!hydrated) return;
    if (!serverEnabled) return;
    if (didInitialServerFetch.current) return;
    didInitialServerFetch.current = true;

    // Guest vehicles are never imported automatically: the user is asked first
    // (see importGuestVehicles). Here we only load the account's own list.
    refresh().catch(() => {
      // Keep showing the cached list; the next action will retry.
    });
  }, [hydrated, refresh, serverEnabled]);

  const createOnServer = useCallback(async (input: Omit<GarageVehicle, "id">): Promise<GarageVehicle> => {
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
    return v;
  }, []);

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
        const v = await createOnServer(input);
        setVehicles((prev) => [v, ...prev.filter((x) => x.id !== v.id)]);
        setActiveId(v.id);
        return v;
      } finally {
        setSyncing(false);
      }
    },
    [createOnServer, serverEnabled],
  );

  const deleteVehicle = useCallback(
    async (id: string) => {
      if (!id) return { archived: false };
      let archived = false;

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
          archived = data?.archived === true;
        } finally {
          setSyncing(false);
        }
      }
      setVehicles((prev) => {
        const nextVehicles = prev.filter((v) => v.id !== id);
        setActiveId((prevActive) => (prevActive === id ? nextVehicles[0]?.id ?? null : prevActive));
        return nextVehicles;
      });
      return { archived };
    },
    [serverEnabled],
  );

  const guestVehicles = useMemo(
    () => (userId ? guestStored.filter((v) => !dismissedGuestIds.includes(v.id)) : []),
    [dismissedGuestIds, guestStored, userId],
  );

  const finishDeviceImport = useCallback(
    async (outcomes: Array<{ clientId: string; outcome: DeviceImportOutcomeKind }>) => {
      if (!userId) return;

      // Imported vehicles now live in the account: remove just those from the
      // device copy. Duplicates and failures stay on the device.
      const importedIds = new Set(outcomes.filter((o) => o.outcome === "imported").map((o) => o.clientId));
      if (importedIds.size > 0) {
        const anon = readStoredGarage(ANON_STORAGE_KEY);
        if (anon) {
          const remaining = anon.garage.filter((v) => !importedIds.has(v.id));
          writeStoredGarage(ANON_STORAGE_KEY, {
            garage: remaining,
            activeId: remaining.some((v) => v.id === anon.activeId) ? anon.activeId : remaining[0]?.id ?? null,
          });
        }
      }
      // Duplicates were shown to the user; don't keep prompting about them.
      const duplicateIds = outcomes.filter((o) => o.outcome === "duplicate").map((o) => o.clientId);
      if (duplicateIds.length > 0) {
        const next = Array.from(new Set([...readDismissedGuestIds(userId), ...duplicateIds]));
        writeDismissedGuestIds(userId, next);
        setDismissedGuestIds(next);
      }

      setGuestStored(readStoredGarage(ANON_STORAGE_KEY)?.garage || []);
      await refresh();
    },
    [refresh, userId],
  );

  /** "Not now": stop offering the current guest vehicles. They stay on the device. */
  const dismissGuestVehicles = useCallback(() => {
    if (!userId) return;
    const next = Array.from(new Set([...readDismissedGuestIds(userId), ...guestStored.map((v) => v.id)]));
    writeDismissedGuestIds(userId, next);
    setDismissedGuestIds(next);
  }, [guestStored, userId]);

  return {
    vehicles,
    activeId,
    setActiveId,
    hydrated,
    syncing,
    refresh,
    addVehicle,
    deleteVehicle,
    guestVehicles,
    finishDeviceImport,
    dismissGuestVehicles,
  };
}
