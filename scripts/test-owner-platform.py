from playwright.sync_api import sync_playwright

BASE = "http://localhost:3000"
EMAIL = "karim@test.dental"
PASSWORD = "test123"

results = []

def section(name):
    print(f"\n=== {name} ===")

def ok(msg):
    results.append(f"  [PASS] {msg}")
    print(f"  [PASS] {msg}")

def fail(msg):
    results.append(f"  [FAIL] {msg}")
    print(f"  [FAIL] {msg}")

def check(label, condition, detail=""):
    if condition:
        ok(label)
    else:
        fail(f"{label} | {detail}")

def h1_text(page):
    el = page.locator("h1").first
    return el.text_content() if el.is_visible() else "(not found)"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1440, "height": 900})
    page = context.new_page()

    section("1. Login")
    page.goto(f"{BASE}/login")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(500)
    check("Login page renders", page.locator("h2").filter(has_text="Connexion").is_visible())

    page.fill("input[name=email]", EMAIL)
    page.fill("input[name=password]", PASSWORD)
    page.click("button[type=submit]")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(3000)
    check("Redirected to /select-clinic", "/select-clinic" in page.url, f"url={page.url}")

    section("2. Owner Dashboard")
    page.goto(f"{BASE}/owner")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(2000)
    actual_h1 = h1_text(page)
    check("h1 = Console proprietaire", "Console" in actual_h1, f"got: {actual_h1}")
    cards = page.locator("div.grid > div").all()
    check(f"4 stat cards visible", len(cards) >= 4, f"got {len(cards)}")
    for c in cards:
        val = c.locator("p.font-bold").text_content() or ""
        lbl = c.locator("p.text-sm").text_content() or ""
        ok(f"  {lbl}: {val}")

    section("3. Sidebar")
    labels = [l.inner_text().strip() for l in page.locator("aside a").all()]
    check("Sidebar has 6 links", len(labels) >= 6, f"got {len(labels)}")
    for target in ["Plateforme", "Cliniques", "Abonnements", "Facturation", "Support"]:
        check(f"  Link '{target}'", any(target in l for l in labels))

    section("4. Clinics page")
    page.goto(f"{BASE}/owner/clinics")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(1000)
    actual_h1 = h1_text(page)
    check("h1 = Cliniques", "Cliniques" in actual_h1, f"got: {actual_h1}")

    section("5. Plans page")
    page.goto(f"{BASE}/owner/plans")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(1000)
    actual_h1 = h1_text(page)
    check("h1 = Plans d'abonnement", "Plans" in actual_h1, f"got: {actual_h1}")
    check("Create plan form visible", page.locator("form").count() >= 1)

    section("6. Billing page")
    page.goto(f"{BASE}/owner/billing")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(1000)
    actual_h1 = h1_text(page)
    check("h1 = Facturation plateforme", "Facturation" in actual_h1, f"got: {actual_h1}")

    section("7. Support page")
    page.goto(f"{BASE}/owner/support")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(1000)
    actual_h1 = h1_text(page)
    check("h1 = Support", "Support" in actual_h1, f"got: {actual_h1}")

    section("8. Health page")
    page.goto(f"{BASE}/owner/health")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(1000)
    actual_h1 = h1_text(page)
    check("h1 = Monitoring", "Monitoring" in actual_h1, f"got: {actual_h1}")

    passed = sum(1 for r in results if "[PASS]" in r)
    failed = sum(1 for r in results if "[FAIL]" in r)
    print(f"\n{'='*40}")
    print(f"RESULTS: {passed} passed, {failed} failed")
    print(f"{'='*40}")
    for r in results:
        print(r)

    browser.close()
