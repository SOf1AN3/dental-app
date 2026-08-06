from playwright.sync_api import sync_playwright

BASE = "http://localhost:3000"
EMAIL = "karim@test.dental"
PASSWORD = "test123"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1440, "height": 900})
    page = context.new_page()

    # Listen for console messages
    page.on("console", lambda msg: print(f"[CONSOLE {msg.type}] {msg.text}"))
    page.on("pageerror", lambda err: print(f"[PAGE ERROR] {err}"))

    # Login
    page.goto(f"{BASE}/login")
    page.wait_for_load_state("networkidle")
    page.fill("input[name=email]", EMAIL)
    page.fill("input[name=password]", PASSWORD)
    page.click("button[type=submit]")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(2000)

    # Check Clinics
    print("\n=== GOING TO /owner/clinics ===")
    response = page.goto(f"{BASE}/owner/clinics")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(2000)
    print(f"Response status: {response.status}")
    text = page.locator("body").text_content() or ""
    # Check for error patterns
    if "Error" in text or "error" in text:
        idx = text.find("rror")
        print(f"Error found near: {text[max(0,idx-50):idx+200]}")
    # Check if we got HTML or RSC payload
    if "self.__next" in text:
        print("Got RSC payload instead of rendered HTML")

    # Check Plans
    print("\n=== GOING TO /owner/plans ===")
    response = page.goto(f"{BASE}/owner/plans")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(2000)
    print(f"Response status: {response.status}")
    text = page.locator("body").text_content() or ""
    if "Error" in text or "error" in text:
        idx = text.find("rror") if "rror" in text else text.find("error")
        print(f"Error found near: {text[max(0,idx-50):idx+200]}")

    browser.close()
