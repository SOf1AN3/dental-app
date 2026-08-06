from playwright.sync_api import sync_playwright

BASE = "http://localhost:3000"
EMAIL = "karim@test.dental"
PASSWORD = "test123"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1440, "height": 900})
    page = context.new_page()

    page.on("console", lambda msg: print(f"[{msg.type}] {msg.text[:200]}"))

    # Login
    print("=== Login ===")
    page.goto(f"{BASE}/login")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(500)

    page.fill("input[name=email]", EMAIL)
    page.fill("input[name=password]", PASSWORD)
    page.click("button[type=submit]")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(3000)
    print(f"After login URL: {page.url}")
    print(f"After login h1: {page.locator('h1').first.text_content()}")

    # Navigate to /owner
    print("\n=== Navigate to /owner ===")
    resp = page.goto(f"{BASE}/owner")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(2000)
    print(f"Owner page URL: {page.url}")
    print(f"Owner page status: {resp.status if resp else 'N/A'}")
    print(f"Owner page h1: {page.locator('h1').first.text_content()}")

    # Navigate to /owner/clinics
    print("\n=== Navigate to /owner/clinics ===")
    resp = page.goto(f"{BASE}/owner/clinics")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(2000)
    print(f"Clinics URL: {page.url}")
    print(f"Clinics status: {resp.status if resp else 'N/A'}")
    print(f"Clinics h1: {page.locator('h1').first.text_content()}")

    browser.close()
