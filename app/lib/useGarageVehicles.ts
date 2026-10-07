"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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

const norm = (s?: string) => (s || "").trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Two entries describe the same vehicle when their VINs match, or — when a VIN
 * is missing on either side — when year, make, model and engine all match.
 */
export function isSameVehicle(a: Omit<GarageVehicle, "id">, b: Omit<GarageVehicle, "id">): boolean {
  const vinA = norm(a.vin);
  const vinB = norm(b.vin);
  if (vinA && vinB) return vinA === vinB;
  return (
    norm(a.year) === norm(b.year) &&
    norm(a.make) === norm(b.make) &&
    norm(a.model) === norm(b.model) &&
    norm(a.engine) === norm(b.engine)
  );
}

export type GuestImportResult = {
  /** Vehicles created in the account. `from` is the on-device copy, `to` the new account vehicle. */
  imported: Array<{ from: GarageVehicle; to: GarageVehicle }>;
  /** Not imported because the same vehicle is already in the account. Left on the device, untouched. */
  duplicates: Array<{ from: GarageVehicle; existing: GarageVehicle }>;
  /** Could not be saved. Left on the device, untouched. */
  failed: Array<{ from: GarageVehicle; error: string }>;
};

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
  deleteVehicle: (id: string) => Promise<void>;
  /** Signed-in only: vehicles saved on this device as a guest that the user has not imported or dismissed. */
  guestVehicles: GarageVehicle[];
  importGuestVehicles: () => Promise<GuestImportResult>;
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
  const prevStorageKey = useRef<string>(storageKey);

  const hydrated = ready && loadedKey === storageKey;

  useEffect(() => {
    if (!ready) return;

    // On sign-out or account switch, drop the PREVIOUS ACCOUNT's cached copy
    // (privacy on shared devices; the server still has it). The guest garage
    // lives only in this browser, so it is never deleted here.
    if (prevStorageKey.current !== storageKey) {
      if (prevStorageKey.current !== ANON_STORAGE_KEY) {
        try {
          window.localStorage.removeItem(prevStorageKey.current);
        } catch {}
      }
      prevStorageKey.current = storageKey;
    }

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

  const guestVehicles = useMemo(
    () => (userId ? guestStored.filter((v) => !dismissedGuestIds.includes(v.id)) : []),
    [dismissedGuestIds, guestStored, userId],
  );

  /**
   * Copy the guest vehicles on this device into the signed-in account.
   * Runs only when the user asks. Duplicates are reported, never merged, and
   * anything that is not imported stays on the device exactly as it was.
   */
  const importGuestVehicles = useCallback(async (): Promise<GuestImportResult> => {
    const result: GuestImportResult = { imported: [], duplicates: [], failed: [] };
    if (!userId) return result;

    const candidates = (readStoredGarage(ANON_STORAGE_KEY)?.garage || []).filter(
      (v) => !readDismissedGuestIds(userId).includes(v.id),
    );
    if (candidates.length === 0) return result;

    setSyncing(true);
    try {
      // Compare against the account's current list, straight from the server.
      const accountVehicles = await fetchServerVehicles();

      for (const guest of candidates) {
        const existing = accountVehicles.find((v) => isSameVehicle(v, guest));
        if (existing) {
          result.duplicates.push({ from: guest, existing });
          continue;
        }
        try {
          const created = await createOnServer(guest);
          accountVehicles.unshift(created);
          result.imported.push({ from: guest, to: created });
        } catch (e) {
          result.failed.push({ from: guest, error: e instanceof Error ? e.message : "Failed to import." });
        }
      }

      // Imported vehicles now live in the account: remove just those from the
      // device copy. Duplicates and failures stay on the device.
      if (result.imported.length > 0) {
        const importedIds = new Set(result.imported.map((x) => x.from.id));
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
      if (result.duplicates.length > 0) {
        const next = [...readDismissedGuestIds(userId), ...result.duplicates.map((d) => d.from.id)];
        writeDismissedGuestIds(userId, next);
        setDismissedGuestIds(Array.from(new Set(next)));
      }

      setGuestStored(readStoredGarage(ANON_STORAGE_KEY)?.garage || []);
      setVehicles(accountVehicles);
      setActiveId((prevActive) => {
        if (prevActive && accountVehicles.some((v) => v.id === prevActive)) return prevActive;
        return result.imported[0]?.to.id ?? accountVehicles[0]?.id ?? null;
      });
      return result;
    } finally {
      setSyncing(false);
    }
  }, [createOnServer, fetchServerVehicles, userId]);

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
    importGuestVehicles,
    dismissGuestVehicles,
  };
}
