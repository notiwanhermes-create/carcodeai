/**
 * The owner's garage, as the guided-diagnostics service sees it (V2I).
 *
 * RESEARCH PROTOTYPE. A directory answers one question, filtered by the
 * authenticated owner: "is this vehicle yours, and what does the garage say
 * about it?". Another user's vehicle answers exactly like a missing one.
 * The Prisma implementation is a separate module (./prisma-vehicles).
 */
import type { VehicleContext } from "../diagnostic-workflow";
import type { SessionOwner } from "../diagnostic-workflow-persistence";

export type OwnedVehicle = {
  id: string;
  /** Archived vehicles have left the garage: their history stays, but no new session starts on them. */
  archived: boolean;
  /** What the garage records. Fields it does not record are absent (unknown), never guessed. */
  context: VehicleContext;
};

export interface VehicleDirectory {
  /** The owner's vehicle with this id, or null (missing, or someone else's). */
  find(owner: SessionOwner, vehicleId: string): Promise<OwnedVehicle | null>;
}

/** TEST ONLY: a fixed garage held in memory. */
export function createInMemoryVehicleDirectory(vehicles: Record<string, { ownerId: string; context: VehicleContext; archived?: boolean }>): VehicleDirectory {
  const byId = new Map(Object.entries(structuredClone(vehicles)));
  return {
    async find(owner, vehicleId) {
      const v = byId.get(vehicleId);
      if (!v || v.ownerId !== owner.userId) return null;
      return { id: vehicleId, archived: v.archived === true, context: structuredClone(v.context) };
    },
  };
}
