/**
 * The garage directory over the app's database (V2I).
 *
 * RESEARCH PROTOTYPE. The only file of the service that touches Prisma; the
 * client is passed in. It only READS garage_vehicles, filtered by the
 * authenticated owner. The garage records year, make, model and engine; fuel,
 * cylinders and market are not recorded there, so they stay unknown here.
 */
import type { PrismaClient } from "@/app/generated/prisma/client";
import type { VehicleContext } from "../diagnostic-workflow";
import type { VehicleDirectory } from "./vehicles";

export function createPrismaVehicleDirectory(prisma: PrismaClient): VehicleDirectory {
  return {
    async find(owner, vehicleId) {
      const v = await prisma.vehicle.findFirst({
        where: { id: vehicleId, userId: owner.userId },
        select: { id: true, modelYear: true, make: true, model: true, engine: true, archivedAt: true },
      });
      if (!v) return null;
      const context: VehicleContext = { make: v.make, model: v.model };
      if (v.modelYear !== null) context.year = v.modelYear;
      if (v.engine !== null) context.engine = v.engine;
      return { id: v.id, archived: v.archivedAt !== null, context };
    },
  };
}
