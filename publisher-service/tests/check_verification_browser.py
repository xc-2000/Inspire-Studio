"""Run in the publisher container to exercise actual Chromium input events."""
import asyncio
import time
from playwright.async_api import async_playwright
from app.qr_login import CHROMIUM_HEADLESS, LoginSession, QrLoginManager


async def main():
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(executable_path="/usr/bin/chromium", headless=CHROMIUM_HEADLESS,
            ignore_default_args=["--enable-automation"],
            args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-blink-features=AutomationControlled"])
        try:
            page = await browser.new_page(viewport={"width": 800, "height": 600})
            await page.set_content('<iframe style="position:absolute;left:0;top:0;width:800px;height:600px;border:0" srcdoc="<button style=\'position:absolute;left:350px;top:250px;width:100px;height:100px\' onclick=\'this.textContent=String(event.detail)\'>verify</button>"></iframe>')
            manager = QrLoginManager()
            session = LoginSession("browser", "douyin", time.time(), time.time() + 60, status="verification", page=page)
            manager._sessions[session.id] = session
            await manager.verification_action(session.id, {"kind": "pointer", "x": .5, "y": .5, "endX": .5, "endY": .5})
            assert await page.frame_locator("iframe").locator("button").inner_text() == "1"
            print("PASS: real Chromium iframe click, scaled coordinates, single click event")
            await page.set_content('<iframe srcdoc="<button onclick=\'this.textContent=String(123)\'>接收短信验证码</button>"></iframe>')
            await page.frame_locator("iframe").get_by_text("接收短信验证码").wait_for()
            await manager.verification_action(session.id, {"kind": "method", "method": "sms"})
            assert await page.frame_locator("iframe").locator("button").inner_text() == "123"
            print("PASS: SMS shortcut locates and clicks the actual iframe control")
            # A mobile-app launch must not leave a browser-native dialog blocking
            # all subsequent clicks (which page.screenshot cannot show).
            markup = '''<button id="launch" onclick="window.open('sslocal://webview?url=https%3A%2F%2Fexample.com')">launch</button>
                <iframe style="display:none"></iframe>
                <button id="verify" onclick="this.textContent='clicked'">verify</button>'''
            diagnostics = []
            page.on("console", lambda event: diagnostics.append(event.text))
            await page.route("https://creator.douyin.com/**", lambda route: route.fulfill(body=markup, content_type="text/html",
                headers={"Content-Security-Policy": "sandbox allow-scripts allow-same-origin allow-forms allow-downloads"}))
            await page.goto("https://creator.douyin.com/input-regression-test")
            await page.locator("#launch").click()
            await page.wait_for_timeout(1000)
            await page.locator("#verify").click(timeout=3000)
            assert await page.locator("#verify").inner_text() == "clicked"
            assert any("sandbox" in entry.lower() and "sslocal" in entry.lower() for entry in diagnostics), diagnostics
            print("PASS: mobile deep-link attempt does not block later verification clicks")
            await page.set_content('<h1 id="clock"></h1><script>setInterval(()=>document.querySelector("h1").textContent=Date.now(),50)</script>')
            session.context = page.context
            frames = []
            for _ in range(3):
                await page.wait_for_timeout(250)
                frame = await manager.status(session.id)
                assert frame["status"] == "verification"
                frames.append(frame["qrCodeDataUrl"])
            assert len(set(frames)) == 3
            print("PASS: verification returns three fresh frames as the live page changes")
        finally:
            await browser.close()


asyncio.run(main())
