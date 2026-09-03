import { relations } from "drizzle-orm";
import * as tables from "./index";

export const clinicsRelations = relations(tables.clinics, ({ many }) => ({
  patients: many(tables.patients),
  appointments: many(tables.appointments),
  invoices: many(tables.invoices),
  quotes: many(tables.quotes),
  payments: many(tables.payments),
  stockItems: many(tables.stockItems),
  prosthesisOrders: many(tables.prosthesisOrders),
  prosthesisLabs: many(tables.prosthesisLabs),
  prescriptions: many(tables.prescriptions),
  consultationNotes: many(tables.consultationNotes),
  dentalCharts: many(tables.dentalCharts),
  odontogramStates: many(tables.odontogramStates),
  radiographs: many(tables.radiographs),
  treatmentPlans: many(tables.treatmentPlans),
  waitingRoomEntries: many(tables.waitingRoomEntries),
  supportTickets: many(tables.supportTickets),
  clinicMemberships: many(tables.clinicMemberships),
  treatmentCatalog: many(tables.treatmentCatalog),
  drugCatalog: many(tables.drugCatalog),
  clinicalSessions: many(tables.clinicalSessions),
  schedule: many(tables.clinicSchedule),
}));

export const clinicScheduleRelations = relations(tables.clinicSchedule, ({ one }) => ({
  clinic: one(tables.clinics, { fields: [tables.clinicSchedule.clinicId], references: [tables.clinics.id] }),
}));

export const treatmentCatalogRelations = relations(tables.treatmentCatalog, ({ one }) => ({
  clinic: one(tables.clinics, { fields: [tables.treatmentCatalog.clinicId], references: [tables.clinics.id] }),
}));

export const drugCatalogRelations = relations(tables.drugCatalog, ({ one }) => ({
  clinic: one(tables.clinics, { fields: [tables.drugCatalog.clinicId], references: [tables.clinics.id] }),
}));

export const patientsRelations = relations(tables.patients, ({ one, many }) => ({
  clinic: one(tables.clinics, { fields: [tables.patients.clinicId], references: [tables.clinics.id] }),
  appointments: many(tables.appointments),
  invoices: many(tables.invoices),
  quotes: many(tables.quotes),
  payments: many(tables.payments),
  prescriptions: many(tables.prescriptions),
  treatmentPlans: many(tables.treatmentPlans),
  consultationNotes: many(tables.consultationNotes),
  dentalCharts: many(tables.dentalCharts),
  odontogramStates: many(tables.odontogramStates),
  radiographs: many(tables.radiographs),
  prosthesisOrders: many(tables.prosthesisOrders),
  waitingRoomEntries: many(tables.waitingRoomEntries),
  clinicalSessions: many(tables.clinicalSessions),
}));

export const usersRelations = relations(tables.users, ({ many }) => ({
  accounts: many(tables.accounts),
  sessions: many(tables.sessions),
  clinicMemberships: many(tables.clinicMemberships),
}));

export const clinicalSessionsRelations = relations(tables.clinicalSessions, ({ one, many }) => ({
  clinic: one(tables.clinics, { fields: [tables.clinicalSessions.clinicId], references: [tables.clinics.id] }),
  patient: one(tables.patients, { fields: [tables.clinicalSessions.patientId], references: [tables.patients.id] }),
  appointment: one(tables.appointments, { fields: [tables.clinicalSessions.appointmentId], references: [tables.appointments.id] }),
  dentist: one(tables.users, { fields: [tables.clinicalSessions.dentistId], references: [tables.users.id] }),
  items: many(tables.clinicalSessionItems),
  prescription: one(tables.prescriptions, { fields: [tables.clinicalSessions.id], references: [tables.prescriptions.sessionId] }),
  invoice: one(tables.invoices, { fields: [tables.clinicalSessions.id], references: [tables.invoices.sessionId] }),
}));

export const clinicalSessionItemsRelations = relations(tables.clinicalSessionItems, ({ one }) => ({
  session: one(tables.clinicalSessions, { fields: [tables.clinicalSessionItems.sessionId], references: [tables.clinicalSessions.id] }),
}));

export const invoicesRelations = relations(tables.invoices, ({ one, many }) => ({
  clinic: one(tables.clinics, { fields: [tables.invoices.clinicId], references: [tables.clinics.id] }),
  patient: one(tables.patients, { fields: [tables.invoices.patientId], references: [tables.patients.id] }),
  session: one(tables.clinicalSessions, { fields: [tables.invoices.sessionId], references: [tables.clinicalSessions.id] }),
  items: many(tables.invoiceItems),
  payments: many(tables.payments),
}));

export const quotesRelations = relations(tables.quotes, ({ one, many }) => ({
  clinic: one(tables.clinics, { fields: [tables.quotes.clinicId], references: [tables.clinics.id] }),
  patient: one(tables.patients, { fields: [tables.quotes.patientId], references: [tables.patients.id] }),
  items: many(tables.quoteItems),
}));

export const appointmentsRelations = relations(tables.appointments, ({ one }) => ({
  clinic: one(tables.clinics, { fields: [tables.appointments.clinicId], references: [tables.clinics.id] }),
  patient: one(tables.patients, { fields: [tables.appointments.patientId], references: [tables.patients.id] }),
}));

export const invoiceItemsRelations = relations(tables.invoiceItems, ({ one }) => ({
  invoice: one(tables.invoices, { fields: [tables.invoiceItems.invoiceId], references: [tables.invoices.id] }),
}));

export const quoteItemsRelations = relations(tables.quoteItems, ({ one }) => ({
  quote: one(tables.quotes, { fields: [tables.quoteItems.quoteId], references: [tables.quotes.id] }),
}));

export const paymentsRelations = relations(tables.payments, ({ one }) => ({
  clinic: one(tables.clinics, { fields: [tables.payments.clinicId], references: [tables.clinics.id] }),
  patient: one(tables.patients, { fields: [tables.payments.patientId], references: [tables.patients.id] }),
  invoice: one(tables.invoices, { fields: [tables.payments.invoiceId], references: [tables.invoices.id] }),
}));

export const treatmentPlansRelations = relations(tables.treatmentPlans, ({ one, many }) => ({
  clinic: one(tables.clinics, { fields: [tables.treatmentPlans.clinicId], references: [tables.clinics.id] }),
  patient: one(tables.patients, { fields: [tables.treatmentPlans.patientId], references: [tables.patients.id] }),
  items: many(tables.treatmentPlanItems),
}));

export const treatmentPlanItemsRelations = relations(tables.treatmentPlanItems, ({ one }) => ({
  plan: one(tables.treatmentPlans, { fields: [tables.treatmentPlanItems.planId], references: [tables.treatmentPlans.id] }),
}));

export const consultationNotesRelations = relations(tables.consultationNotes, ({ one }) => ({
  clinic: one(tables.clinics, { fields: [tables.consultationNotes.clinicId], references: [tables.clinics.id] }),
  patient: one(tables.patients, { fields: [tables.consultationNotes.patientId], references: [tables.patients.id] }),
}));

export const dentalChartsRelations = relations(tables.dentalCharts, ({ one }) => ({
  clinic: one(tables.clinics, { fields: [tables.dentalCharts.clinicId], references: [tables.clinics.id] }),
  patient: one(tables.patients, { fields: [tables.dentalCharts.patientId], references: [tables.patients.id] }),
}));

export const odontogramStatesRelations = relations(tables.odontogramStates, ({ one }) => ({
  clinic: one(tables.clinics, { fields: [tables.odontogramStates.clinicId], references: [tables.clinics.id] }),
  patient: one(tables.patients, { fields: [tables.odontogramStates.patientId], references: [tables.patients.id] }),
}));

export const radiographsRelations = relations(tables.radiographs, ({ one }) => ({
  clinic: one(tables.clinics, { fields: [tables.radiographs.clinicId], references: [tables.clinics.id] }),
  patient: one(tables.patients, { fields: [tables.radiographs.patientId], references: [tables.patients.id] }),
}));

export const prescriptionsRelations = relations(tables.prescriptions, ({ one, many }) => ({
  clinic: one(tables.clinics, { fields: [tables.prescriptions.clinicId], references: [tables.clinics.id] }),
  patient: one(tables.patients, { fields: [tables.prescriptions.patientId], references: [tables.patients.id] }),
  session: one(tables.clinicalSessions, { fields: [tables.prescriptions.sessionId], references: [tables.clinicalSessions.id] }),
  items: many(tables.prescriptionItems),
}));

export const prescriptionItemsRelations = relations(tables.prescriptionItems, ({ one }) => ({
  prescription: one(tables.prescriptions, { fields: [tables.prescriptionItems.prescriptionId], references: [tables.prescriptions.id] }),
}));

export const stockItemsRelations = relations(tables.stockItems, ({ one, many }) => ({
  clinic: one(tables.clinics, { fields: [tables.stockItems.clinicId], references: [tables.clinics.id] }),
  transactions: many(tables.stockTransactions),
}));

export const stockTransactionsRelations = relations(tables.stockTransactions, ({ one }) => ({
  item: one(tables.stockItems, { fields: [tables.stockTransactions.itemId], references: [tables.stockItems.id] }),
}));

export const prosthesisLabsRelations = relations(tables.prosthesisLabs, ({ one, many }) => ({
  clinic: one(tables.clinics, { fields: [tables.prosthesisLabs.clinicId], references: [tables.clinics.id] }),
  orders: many(tables.prosthesisOrders),
}));

export const prosthesisOrdersRelations = relations(tables.prosthesisOrders, ({ one }) => ({
  clinic: one(tables.clinics, { fields: [tables.prosthesisOrders.clinicId], references: [tables.clinics.id] }),
  patient: one(tables.patients, { fields: [tables.prosthesisOrders.patientId], references: [tables.patients.id] }),
  lab: one(tables.prosthesisLabs, { fields: [tables.prosthesisOrders.labId], references: [tables.prosthesisLabs.id] }),
}));

export const waitingRoomEntriesRelations = relations(tables.waitingRoomEntries, ({ one }) => ({
  clinic: one(tables.clinics, { fields: [tables.waitingRoomEntries.clinicId], references: [tables.clinics.id] }),
  patient: one(tables.patients, { fields: [tables.waitingRoomEntries.patientId], references: [tables.patients.id] }),
}));

export const supportTicketsRelations = relations(tables.supportTickets, ({ one }) => ({
  clinic: one(tables.clinics, { fields: [tables.supportTickets.clinicId], references: [tables.clinics.id] }),
}));

export const clinicMembershipsRelations = relations(tables.clinicMemberships, ({ one }) => ({
  user: one(tables.users, { fields: [tables.clinicMemberships.userId], references: [tables.users.id] }),
  clinic: one(tables.clinics, { fields: [tables.clinicMemberships.clinicId], references: [tables.clinics.id] }),
}));

export const clinicSubscriptionsRelations = relations(tables.clinicSubscriptions, ({ one }) => ({
  clinic: one(tables.clinics, { fields: [tables.clinicSubscriptions.clinicId], references: [tables.clinics.id] }),
  plan: one(tables.subscriptionPlans, { fields: [tables.clinicSubscriptions.planId], references: [tables.subscriptionPlans.id] }),
}));

export const subscriptionPlansRelations = relations(tables.subscriptionPlans, ({ many }) => ({
  subscriptions: many(tables.clinicSubscriptions),
}));
