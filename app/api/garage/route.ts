import { getSessionUser } from "@/app/lib/auth";
import pool, { ensureDB } from "@/app/lib/db";

export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  await ensureDB();

  const vehicles = await pool.query(
    "SELECT id, year, make, model, engine, vin, is_active FROM garage_vehicles WHERE user_id = $1 ORDER BY created_at DESC",
    [user.id]
  );

  const maintenance = await pool.query(
    "SELECT id, vehicle_id, type, date, mileage, notes FROM maintenance_records WHERE user_id = $1 ORDER BY created_at DESC",
    [user.id]
  );

  const maintenanceByVehicle: Record<string, any[]> = {};
  for (const rec of maintenance.rows) {
    if (!maintenanceByVehicle[rec.vehicle_id]) {
      maintenanceByVehicle[rec.vehicle_id] = [];
    }
    maintenanceByVehicle[rec.vehicle_id].push({
      id: rec.id,
      vehicleId: rec.vehicle_id,
      type: rec.type,
      date: rec.date,
      mileage: rec.mileage,
      notes: rec.notes,
    });
  }

  const activeVehicle = vehicles.rows.find((v: any) => v.is_active);

  return Response.json({
    garage: vehicles.rows.map((v: any) => ({
      id: v.id,
      year: v.year,
      make: v.make,
      model: v.model,
      engine: v.engine || undefined,
      vin: v.vin || undefined,
    })),
    activeId: activeVehicle?.id || (vehicles.rows[0]?.id ?? null),
    maintenance: maintenanceByVehicle,
  });
}

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  await ensureDB();
  const body = await req.json();
  const { action } = body;

  if (action === "sync") {
    const { garage, activeId, maintenance } = body;
    const clientVehicleIds = new Set((garage || []).map((v: any) => v.id));

    const allClientMaintIds = new Set<string>();
    if (maintenance) {
      for (const records of Object.values(maintenance)) {
        for (const rec of records as any[]) {
          allClientMaintIds.add(rec.id);
        }
      }
    }

    await pool.query("BEGIN");
    try {
      const existing = await pool.query(
        "SELECT id FROM garage_vehicles WHERE user_id = $1",
        [user.id]
      );
      const existingIds = new Set(existing.rows.map((r: any) => r.id));

      const idsToDelete = [...existingIds].filter((id) => !clientVehicleIds.has(id));
      for (const id of idsToDelete) {
        await pool.query("DELETE FROM garage_vehicles WHERE id = $1 AND user_id = $2", [id, user.id]);
      }

      for (const v of garage || []) {
        if (existingIds.has(v.id)) {
          await pool.query(
            `UPDATE garage_vehicles SET year=$2, make=$3, model=$4, engine=$5, vin=$6, is_active=$7 WHERE id=$1 AND user_id=$8`,
            [v.id, v.year, v.make, v.model, v.engine || null, v.vin || null, v.id === activeId, user.id]
          );
        } else {
          await pool.query(
            `INSERT INTO garage_vehicles (id, user_id, year, make, model, engine, vin, is_active)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [v.id, user.id, v.year, v.make, v.model, v.engine || null, v.vin || null, v.id === activeId]
          );
        }
      }

      const existingMaint = await pool.query(
        "SELECT id FROM maintenance_records WHERE user_id = $1",
        [user.id]
      );
      const existingMaintIds = new Set(existingMaint.rows.map((r: any) => r.id));

      const maintToDelete = [...existingMaintIds].filter((id) => !allClientMaintIds.has(id));
      for (const id of maintToDelete) {
        await pool.query("DELETE FROM maintenance_records WHERE id = $1 AND user_id = $2", [id, user.id]);
      }

      if (maintenance) {
        for (const [vehicleId, records] of Object.entries(maintenance)) {
          for (const rec of records as any[]) {
            await pool.query(
              `INSERT INTO maintenance_records (id, user_id, vehicle_id, type, date, mileage, notes)
               VALUES ($1, $2, $3, $4, $5, $6, $7)
               ON CONFLICT (id) DO UPDATE SET type=$4, date=$5, mileage=$6, notes=$7`,
              [rec.id, user.id, vehicleId, rec.type, rec.date, rec.mileage || "", rec.notes || ""]
            );
          }
        }
      }

      await pool.query("COMMIT");
      return Response.json({ ok: true });
    } catch (e: any) {
      await pool.query("ROLLBACK");
      return Response.json({ error: e.message }, { status: 500 });
    }
  }

  if (action === "addVehicle") {
    const { vehicle } = body;
    await pool.query(
      `INSERT INTO garage_vehicles (id, user_id, year, make, model, engine, vin, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [vehicle.id, user.id, vehicle.year, vehicle.make, vehicle.model, vehicle.engine || null, vehicle.vin || null, true]
    );
    await pool.query(
      "UPDATE garage_vehicles SET is_active = FALSE WHERE user_id = $1 AND id != $2",
      [user.id, vehicle.id]
    );
    return Response.json({ ok: true });
  }

  if (action === "removeVehicle") {
    await pool.query(
      "DELETE FROM garage_vehicles WHERE id = $1 AND user_id = $2",
      [body.vehicleId, user.id]
    );
    return Response.json({ ok: true });
  }

  if (action === "setActive") {
    await pool.query(
      "UPDATE garage_vehicles SET is_active = FALSE WHERE user_id = $1",
      [user.id]
    );
    await pool.query(
      "UPDATE garage_vehicles SET is_active = TRUE WHERE id = $1 AND user_id = $2",
      [body.vehicleId, user.id]
    );
    return Response.json({ ok: true });
  }

  if (action === "addMaintenance") {
    const { record } = body;
    await pool.query(
      `INSERT INTO maintenance_records (id, user_id, vehicle_id, type, date, mileage, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [record.id, user.id, record.vehicleId, record.type, record.date, record.mileage || "", record.notes || ""]
    );
    return Response.json({ ok: true });
  }

  if (action === "removeMaintenance") {
    await pool.query(
      "DELETE FROM maintenance_records WHERE id = $1 AND user_id = $2",
      [body.recordId, user.id]
    );
    return Response.json({ ok: true });
  }

  return Response.json({ error: "Unknown action" }, { status: 400 });
}
