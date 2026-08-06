import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./src/lib/db/schema";
import { eq, and, inArray } from "drizzle-orm";

const client = postgres(process.env.DATABASE_URL!);
const db = drizzle(client, { schema });

async function main() {
  console.log("Seeding database...\n");

  const userId = "00000000-0000-0000-0000-000000000001";
  const clinicId = "00000000-0000-0000-0000-000000000010";

  // Clean existing data for this clinic to prevent duplicates on re-seed
  console.log("Cleaning existing data for clinic...");
  const existingInvoices = await db
    .select({ id: schema.invoices.id })
    .from(schema.invoices)
    .where(eq(schema.invoices.clinicId, clinicId));
  const invoiceIds = existingInvoices.map((i) => i.id);
  if (invoiceIds.length > 0) {
    await db.delete(schema.invoiceItems).where(inArray(schema.invoiceItems.invoiceId, invoiceIds));
    console.log(`  Deleted ${invoiceIds.length} invoice(s) and their items`);
  }
  await db.delete(schema.invoices).where(eq(schema.invoices.clinicId, clinicId));
  await db.delete(schema.appointments).where(eq(schema.appointments.clinicId, clinicId));
  await db.delete(schema.patients).where(eq(schema.patients.clinicId, clinicId));
  await db.delete(schema.clinicMemberships).where(
    and(
      eq(schema.clinicMemberships.userId, userId),
      eq(schema.clinicMemberships.clinicId, clinicId)
    )
  );
  console.log("  Cleanup done.\n");

  const [user] = await db
    .insert(schema.users)
    .values({
      id: userId,
      name: "Dr. Karim Mansouri",
      email: "karim@test.dental",
      passwordHash: "$2b$12$2.mY2i90AjX/WPmtyCCv3.TbbZMkYjCV4.pllf8u9fldwLKEb7DFK",
    })
    .onConflictDoNothing({ target: schema.users.id })
    .returning();
  console.log(`  User: ${user?.name ?? "already exists"} (${user?.email ?? "karim@test.dental"})`);

  const [clinic] = await db
    .insert(schema.clinics)
    .values({
      id: clinicId,
      name: "Clinique Dentaire Mansouri",
      slug: "clinique-mansouri",
      email: "contact@mansouri.dental",
      phone: "+213 555 12 34 56",
      address: "42 Rue Didouche Mourad, Alger",
      wilayaCode: "16",
    })
    .onConflictDoNothing({ target: schema.clinics.id })
    .returning();
  console.log(`  Clinic: ${clinic?.name ?? "already exists"}`);

  await db.insert(schema.clinicMemberships).values({
    userId,
    clinicId,
    role: "owner",
  });
  console.log("  Membership: created (owner)");

  const patientData = [
    { firstName: "Fatima", lastName: "Bensalem", phone: "+213 555 98 76 54" },
    { firstName: "Mohammed", lastName: "Kara", phone: "+213 556 11 22 33" },
    { firstName: "Sarah", lastName: "Lounis", phone: "+213 557 44 55 66" },
    { firstName: "Ahmed", lastName: "Toumi", phone: "+213 558 77 88 99" },
    { firstName: "Nadia", lastName: "Cherif", phone: "+213 559 00 11 22" },
  ];

  const patients = await db
    .insert(schema.patients)
    .values(
      patientData.map((p) => ({
        id: crypto.randomUUID(),
        clinicId,
        ...p,
      })),
    )
    .returning();
  console.log(`  Patients: ${patients.length} created`);

  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  function atDate(base: Date, hours: number, minutes: number): Date {
    const d = new Date(base);
    d.setHours(hours, minutes, 0, 0);
    return d;
  }

  const appointmentData = [
    {
      clinicId,
      patientId: patients[0].id,
      dentistId: userId,
      startTime: atDate(yesterday, 9, 0),
      endTime: atDate(yesterday, 10, 0),
      type: "consultation",
      status: "completed" as const,
      color: "#3B82F6",
    },
    {
      clinicId,
      patientId: patients[1].id,
      dentistId: userId,
      startTime: atDate(yesterday, 10, 30),
      endTime: atDate(yesterday, 11, 30),
      type: "cleaning",
      status: "completed" as const,
      color: "#10B981",
    },
    {
      clinicId,
      patientId: patients[0].id,
      dentistId: userId,
      startTime: atDate(today, 9, 0),
      endTime: atDate(today, 10, 0),
      type: "follow-up",
      status: "confirmed" as const,
      color: "#F59E0B",
    },
    {
      clinicId,
      patientId: patients[2].id,
      dentistId: userId,
      startTime: atDate(today, 11, 0),
      endTime: atDate(today, 12, 0),
      type: "consultation",
      status: "scheduled" as const,
      color: "#8B5CF6",
    },
    {
      clinicId,
      patientId: patients[4].id,
      dentistId: userId,
      startTime: atDate(tomorrow, 9, 0),
      endTime: atDate(tomorrow, 10, 0),
      type: "cleaning",
      status: "scheduled" as const,
      color: "#EF4444",
    },
  ];

  const appointments = await db
    .insert(schema.appointments)
    .values(appointmentData.map((a) => ({ id: crypto.randomUUID(), ...a })))
    .returning();
  console.log(`  Appointments: ${appointments.length} created`);

  const [invoice] = await db
    .insert(schema.invoices)
    .values({
      id: crypto.randomUUID(),
      clinicId,
      patientId: patients[0].id,
      number: "INV-001",
      date: today,
      status: "paid",
      subtotal: 150,
      total: 150,
    })
    .returning();
  console.log(`  Invoice: ${invoice.number} created (${invoice.total} DZD)`);

  const invoiceItems = await db
    .insert(schema.invoiceItems)
    .values([
      {
        id: crypto.randomUUID(),
        invoiceId: invoice.id,
        description: "Consultation generale",
        quantity: 1,
        unitPrice: 50,
        total: 50,
      },
      {
        id: crypto.randomUUID(),
        invoiceId: invoice.id,
        description: "Detartrage complet",
        quantity: 1,
        unitPrice: 100,
        total: 100,
      },
    ])
    .returning();
  console.log(`  Invoice Items: ${invoiceItems.length} created`);

  console.log("\nSeed complete!");
  console.log(`  Login email: karim@test.dental`);
  console.log(`  Password:   test123`);
  console.log(`  User:       Dr. Karim Mansouri`);
  console.log(`  Clinic:     Clinique Dentaire Mansouri`);
  console.log(`  Patients:   ${patients.length}`);
  console.log(`  Appointments: ${appointments.length}`);
  console.log(`  Invoices:   ${invoice.number} with ${invoiceItems.length} items`);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
