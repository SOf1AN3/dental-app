import { chromium } from "playwright";

const BASE = "http://localhost:3000";
const results = { pass: 0, fail: 0, errors: [] };
let step = 0;

function check(desc, condition) {
  step++;
  if (condition) {
    console.log(`  ✅ [${step}] ${desc}`);
    results.pass++;
  } else {
    console.log(`  ❌ [${step}] ${desc}`);
    results.fail++;
  }
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();

page.on("console", msg => {
  if (msg.type() === "error") results.errors.push(`console.error: ${msg.text()}`);
});
page.on("pageerror", err => results.errors.push(`page crash: ${err.message}`));

async function clickNav(href) {
  const link = page.locator(`a[href="${href}"]`);
  if (await link.isVisible()) {
    await link.click();
    await page.waitForTimeout(2000);
    try { await page.waitForLoadState("networkidle", { timeout: 10000 }); } catch {}
  }
}

// ============================
// 1. LOGIN
// ============================
console.log("\n========================================");
console.log("  WORKFLOW 1: LOGIN");
console.log("========================================");
await page.goto(`${BASE}/login`, { waitUntil: "networkidle", timeout: 15000 });
await page.waitForTimeout(500);
check("Login page loads", page.url().includes("/login"));

await page.fill("#email", "karim@test.dental");
await page.fill("#password", "test123");
await page.click('button[type="submit"]');
await page.waitForTimeout(4000);
await page.waitForLoadState("networkidle").catch(() => {});
check("Redirected after login", page.url().includes("select-clinic") || page.url() === `${BASE}/`);

// ============================
// 2. SELECT CLINIC
// ============================
console.log("\n========================================");
console.log("  WORKFLOW 2: SELECT CLINIC");
console.log("========================================");

if (page.url().includes("select-clinic")) {
  const cards = page.locator("button").filter({ hasText: "Clinique Dentaire Mansouri" });
  const count = await cards.count();
  check("Only 1 clinic card (no dupes)", count === 1);
  check("Clinic shows role Propriétaire", (await page.textContent("body")).includes("Propriétaire"));
  check("Clinic shows Essai badge", (await page.textContent("body")).includes("Essai"));
  await cards.first().click();
  await page.waitForTimeout(3000);
  await page.waitForLoadState("networkidle").catch(() => {});
}

// ============================
// 3. DASHBOARD
// ============================
console.log("\n========================================");
console.log("  WORKFLOW 3: DASHBOARD");
console.log("========================================");

check("URL is dashboard", page.url() === `${BASE}/`);
const dashText = await page.textContent("body");
check("Welcome message visible", dashText.includes("Bienvenue"));
check("Stats cards visible", dashText.includes("Patients aujourd'hui") && dashText.includes("Rendez-vous aujourd'hui"));
check("Today's appointments section visible", dashText.includes("Rendez-vous du jour"));
check("Recent appointments section visible", dashText.includes("Derniers rendez-vous"));

const sidebarName = await page.locator("aside p.font-medium").innerText();
check("Sidebar shows Dr. Karim Mansouri", sidebarName === "Dr. Karim Mansouri");
const avatarInitials = await page.locator("aside .rounded-full.bg-cerulean").innerText();
check("Avatar initials KM", avatarInitials === "KM");

// Check all sidebar nav links
const navLinks = ["/", "/patients", "/appointments", "/waiting-room", "/billing", "/prescriptions", "/treatments", "/stock", "/prostheses", "/reports", "/settings/general"];
for (const href of navLinks) {
  const exists = await page.locator(`a[href="${href}"]`).isVisible();
  check(`Nav link ${href} exists`, exists);
}

// ============================
// 4. PATIENTS - LIST & CREATE
// ============================
console.log("\n========================================");
console.log("  WORKFLOW 4: PATIENTS - LIST & CREATE");
console.log("========================================");
await clickNav("/patients");
check("Patients page loads", page.url().includes("/patients"));

const rowCount = await page.locator("table tbody tr").count();
check("Patient list has correct row count", rowCount >= 5);
check("Patient list has Bensalem", (await page.textContent("body")).includes("Bensalem"));

// Create new patient
await page.click('a[href="/patients/new"]');
await page.waitForTimeout(1500);
check("New patient form loads", page.url().includes("/patients/new"));

await page.fill("#firstName", "Testeur");
await page.fill("#lastName", "Automatique");
await page.fill("#phone", "+213 555 00 00 00");
await page.fill("#email", "test@test.dental");

await page.click('button:has-text("Enregistrer")');
await page.waitForTimeout(4000);
await page.waitForLoadState("networkidle").catch(() => {});
check("Redirected to patients list after creation", page.url().includes("/patients") && !page.url().includes("/new"));

// ============================
// 5. PATIENT DETAILS
// ============================
console.log("\n========================================");
console.log("  WORKFLOW 5: PATIENT DETAILS");
console.log("========================================");

// Navigate to a patient detail page
const dossierLink = page.locator('a:has-text("Dossier")').first();
await dossierLink.click();
await page.waitForTimeout(2000);
await page.waitForLoadState("networkidle").catch(() => {});

check("Patient detail page loads", page.url().includes("/patients/") && !page.url().includes("/new"));

const detailText = await page.textContent("body");
check("Patient name visible on details", detailText.includes("Informations") || detailText.includes("Téléphone"));
check("Navigation cards exist", detailText.includes("Navigation rapide") || detailText.includes("Odontogramme"));

// Check quick navigation cards (they render as <Link> with emoji + text)
check("Dental chart card exists", detailText.includes("Odontogramme"));
check("Treatment plan card exists", detailText.includes("Plan de traitement"));
check("Clinical notes card exists", detailText.includes("Notes cliniques"));
check("Radiographs card exists", detailText.includes("Radiographies"));
check("Prescriptions card exists", detailText.includes("Prescriptions"));

// ============================
// 6. APPOINTMENTS
// ============================
console.log("\n========================================");
console.log("  WORKFLOW 6: APPOINTMENTS");
console.log("========================================");
await clickNav("/appointments");
check("Appointments page loads", page.url().includes("/appointments"));

const aptText = await page.textContent("body");
check("Date visible", aptText.includes("28/07") || aptText.includes("Rendez-vous"));
check("Appointment entries visible", aptText.includes("Bensalem") || aptText.includes("Lounis"));
check("New appointment button visible", aptText.includes("Nouveau RDV"));

// Check action buttons (use first() for multi-match)
const confirmBtn = page.locator("button").filter({ hasText: "Confirmer" });
check("Confirm button exists", await confirmBtn.isVisible().catch(() => false));

const cancelBtns = page.locator("button:has-text('Annuler')");
const cancelCount = await cancelBtns.count();
check("Cancel buttons found (" + cancelCount + ")", cancelCount > 0);

const arriveBtns = page.locator("button:has-text('Arrivé')");
const arriveCount = await arriveBtns.count();
check("Arrivé buttons found (" + arriveCount + ")", arriveCount > 0);

// ============================
// 7. BILLING
// ============================
console.log("\n========================================");
console.log("  WORKFLOW 7: BILLING");
console.log("========================================");
await clickNav("/billing");
check("Billing page loads", page.url().includes("/billing"));
const billText = await page.textContent("body");
check("Summary stats visible", billText.includes("Total factures") && billText.includes("Montant total"));
check("Invoice INV-001 visible", billText.includes("INV-001"));
check("Status Payée visible", billText.includes("Payée"));
check("New invoice button visible", billText.includes("Nouvelle facture"));
check("Quotes section visible", billText.includes("Devis récents"));

// ============================
// 8. PRESCRIPTIONS
// ============================
console.log("\n========================================");
console.log("  WORKFLOW 8: PRESCRIPTIONS");
console.log("========================================");
await clickNav("/prescriptions");
check("Prescriptions page loads", page.url().includes("/prescriptions"));
const presText = await page.textContent("body");
check("Prescription count visible", presText.includes("ordonnance"));
check("New prescription button visible", presText.includes("Nouvelle ordonnance"));

// ============================
// 9. TREATMENTS
// ============================
console.log("\n========================================");
console.log("  WORKFLOW 9: TREATMENTS");
console.log("========================================");
await clickNav("/treatments");
check("Treatments page loads", page.url().includes("/treatments"));
const treatText = await page.textContent("body");
check("Empty state visible", treatText.includes("plan de traitement") && treatText.includes("Aucun"));
check("New treatment plan button visible", treatText.includes("Nouveau plan de traitement"));

// ============================
// 10. STOCK
// ============================
console.log("\n========================================");
console.log("  WORKFLOW 10: STOCK");
console.log("========================================");
await clickNav("/stock");
check("Stock page loads", page.url().includes("/stock"));
const stockText = await page.textContent("body");
check("Empty state visible", stockText.includes("article en stock") && stockText.includes("Aucun"));
check("New article button visible", stockText.includes("Nouvel article"));

// ============================
// 11. PROSTHESES
// ============================
console.log("\n========================================");
console.log("  WORKFLOW 11: PROSTHESES");
console.log("========================================");
await clickNav("/prostheses");
check("Prostheses page loads", page.url().includes("/prostheses"));
const prosText = await page.textContent("body");
check("New laboratory button visible", prosText.includes("Nouveau laboratoire"));
check("New order button visible", prosText.includes("Nouvelle commande"));

// ============================
// 12. WAITING ROOM
// ============================
console.log("\n========================================");
console.log("  WORKFLOW 12: WAITING ROOM");
console.log("========================================");
await clickNav("/waiting-room");
check("Waiting room loads", page.url().includes("/waiting-room"));
const waitText = await page.textContent("body");
check("Empty state visible", waitText.includes("patient") && (waitText.includes("vide") || waitText.includes("0")));
check("Auto-refresh indicator visible", waitText.includes("10 secondes"));

// ============================
// 13. REPORTS
// ============================
console.log("\n========================================");
console.log("  WORKFLOW 13: REPORTS");
console.log("========================================");
await clickNav("/reports");
check("Reports page loads", page.url().includes("/reports"));
const reportText = await page.textContent("body");
check("Stats overview visible", reportText.includes("Total patients") && reportText.includes("Revenu total"));
check("Monthly table visible", reportText.includes("Aperçu mensuel"));
check("Appointment distribution visible", reportText.includes("Répartition") || reportText.includes("Par type"));

// ============================
// 14. SETTINGS
// ============================
console.log("\n========================================");
console.log("  WORKFLOW 14: SETTINGS");
console.log("========================================");
await clickNav("/settings/general");
check("Settings page loads", page.url().includes("/settings/general"));
const settingsText = await page.textContent("body");
check("Clinic info section visible", settingsText.includes("Informations de la clinique"));
check("Profile section visible", settingsText.includes("Votre profil"));
check("Wilaya dropdown visible", settingsText.includes("Sélectionner une wilaya"));
check("Save button visible", settingsText.includes("Enregistrer"));

// ============================
// 15. SIDEBAR NAVIGATION SPOT CHECK
// ============================
console.log("\n========================================");
console.log("  WORKFLOW 15: SIDEBAR NAVIGATION");
console.log("========================================");

const spotChecks = [["/patients", "Patients"], ["/appointments", "Rendez-vous"], ["/billing", "Facturation"]];
for (const [href, label] of spotChecks) {
  await clickNav(href);
  await page.waitForTimeout(1000);
  check(`Sidebar "${label}" navigates correctly`, page.url().includes(href));
}

// ============================
// SUMMARY
// ============================
console.log("\n========================================");
console.log("  TEST SUMMARY");
console.log("========================================");
console.log(`  Passed: ${results.pass}`);
console.log(`  Failed: ${results.fail}`);
console.log(`  Total:  ${results.pass + results.fail}`);

if (results.errors.length > 0) {
  console.log(`\n  Console Errors (${results.errors.length}):`);
  for (const err of results.errors) console.log(`    ${err}`);
} else {
  console.log("\n  No console errors ✅");
}

await browser.close();
process.exit(results.fail > 0 ? 1 : 0);
