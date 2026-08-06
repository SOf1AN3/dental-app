from playwright.sync_api import sync_playwright

BASE = "http://localhost:3000"
EMAIL = "karim@test.dental"
PASSWORD = "test123"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1440, "height": 900})
    page = context.new_page()

    # Login
    page.goto(f"{BASE}/login")
    page.wait_for_load_state("networkidle")
    page.fill("input[name=email]", EMAIL)
    page.fill("input[name=password]", PASSWORD)
    page.click("button[type=submit]")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(2000)

    # Debug Clinics
    print("=== Clinics page ===")
    page.goto(f"{BASE}/owner/clinics")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(2000)
    print(f"URL: {page.url}")
    print(f"Title: {page.title()}")
    body = page.locator("body").text_content()
    print(f"Body (first 500 chars): {body[:500]}")
    page.screenshot(path="D:\\dental\\dental-app\\scripts\\debug-clinics.png")

    # Debug Plans
    print("\n=== Plans page ===")
    page.goto(f"{BASE}/owner/plans")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(2000)
    print(f"URL: {page.url}")
    print(f"Title: {page.title()}")
    body = page.locator("body").text_content()
    print(f"Body (first 500 chars): {body[:500]}")
    page.screenshot(path="D:\\dental\\dental-app\\scripts\\debug-plans.png")

    browser.close()
