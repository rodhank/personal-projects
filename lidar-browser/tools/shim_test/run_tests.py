# Headless Chrome test of lidar-shim.js (navigator.lidar + WebXR), the examples and the viewer site.
# Needs: tools/protocol_test_server.py running, pip install playwright && playwright install chromium
import asyncio, json, os
HERE = os.path.dirname(os.path.abspath(__file__))
from playwright.async_api import async_playwright
MOCK = open(os.path.join(HERE, 'mock-bridge.js')).read()
SHIM = open(os.path.join(HERE, '..', '..', 'ios', 'LidarBrowser', 'Resources', 'lidar-shim.js')).read()
ARGS = ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']
async def page_with_shim(b, vp=(1200,800)):
    pg = await b.new_page(viewport={'width':vp[0],'height':vp[1]})
    errs = []
    pg.on('pageerror', lambda e: errs.append(f'pageerror: {e}'))
    pg.on('console', lambda m: errs.append(f'console.{m.type}: {m.text}') if m.type == 'error' else None)
    await pg.add_init_script(MOCK); await pg.add_init_script(SHIM)
    return pg, errs
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=ARGS)
        # 1. navigator.lidar API directly
        pg, errs = await page_with_shim(b)
        await pg.goto('http://localhost:8080/examples/webxr-depth.html')
        r = await pg.evaluate("""async () => {
          const L = navigator.lidar; const out = {available: L.available, hasXR: !!navigator.xr};
          let frames = 0; L.addEventListener('frame', () => frames++);
          await L.start({fps: 15, rgb: true, mesh: true});
          await new Promise(r => setTimeout(r, 2500));
          const f = L.latestFrame;
          out.frames = frames; out.size = [f.width, f.height]; out.center = f.depthAt(128, 96); out.screenCenter = f.depthAtScreen(0.5,0.5);
          out.conf = f.confidence.length; out.rgb = f.rgb && f.rgb.size; out.hasView = !!f.viewTransform; out.proj = Array.from(f.projectionMatrix).slice(0,6).map(v=>+v.toFixed(3));
          await L.stop(); out.running = L.running; return out; }""")
        print('LIDAR API', r, errs)
        # 2. plain WebXR depth example
        pg, errs = await page_with_shim(b)
        await pg.goto('http://localhost:8080/examples/webxr-depth.html')
        await pg.click('#go'); await pg.wait_for_timeout(3000)
        print('WEBXR', await pg.evaluate('window.__xrResults'), errs)
        await pg.screenshot(path=os.path.join(HERE, 'ex_webxr.png'))
        await pg.click('#go'); await pg.wait_for_timeout(500)
        print('WEBXR after end:', await pg.evaluate("[document.getElementById('go').textContent, navigator.lidar.running, getComputedStyle(document.body).backgroundColor]"))
        # 3. three.js
        pg, errs = await page_with_shim(b)
        await pg.goto('http://localhost:8080/examples/three-ar.html')
        await pg.click('#go'); await pg.wait_for_timeout(3000)
        print('THREE-pre', await pg.evaluate('window.__threeResults'), errs[:6])
        if await pg.is_enabled('#drop'):
            await pg.click('#drop'); await pg.wait_for_timeout(800)
        print('THREE', await pg.evaluate('window.__threeResults'), errs[:5])
        await pg.screenshot(path=os.path.join(HERE, 'ex_three.png'))
        # 4. viewer site in native mode
        pg, errs = await page_with_shim(b, (1400, 860))
        await pg.goto('http://localhost:8080/')
        await pg.wait_for_timeout(3500)
        print('VIEWER', await pg.evaluate("() => ({conn: conn.textContent, msg: connMsg.textContent, seq: window.lidar.frame && window.lidar.frame.seq, res: sRes.textContent, device: device.textContent, mock: window.__mockLog})"), errs)
        await pg.select_option('#mode','blend'); await pg.wait_for_timeout(600)
        await pg.screenshot(path=os.path.join(HERE, 'viewer_native.png'))
        await pg.click('#disconnectBtn'); await pg.wait_for_timeout(500)
        print('VIEWER stop', await pg.evaluate("[conn.textContent, connMsg.textContent]"))
        # 5. denied permission
        pg, errs = await page_with_shim(b)
        await pg.add_init_script("window.__mockDeny = true")
        await pg.goto('http://localhost:8080/examples/webxr-depth.html')
        await pg.click('#go'); await pg.wait_for_timeout(800)
        print('DENIED', await pg.evaluate("[window.__xrResults.errors, document.getElementById('info').textContent]"))
        await b.close()
asyncio.run(main())
