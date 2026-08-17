import type { Page } from 'playwright';

/**
 * Move the mouse to a target point along a cubic bezier curve with
 * 3 intermediate control points. Used by the human-sim tier to make
 * cursor motion look like a person instead of an instant teleport.
 *
 * The path is parameterized by ~60-120 evenly-spaced t samples; at each
 * step we drive `page.mouse.move(x, y)` and wait a few ms.
 */
export async function bezierMove(page: Page, to: { x: number; y: number }): Promise<void> {
  const start = { x: Math.random() * 1280, y: Math.random() * 720 };
  const cps = Array.from({ length: 3 }, () => ({ x: Math.random() * 1280, y: Math.random() * 720 }));
  const steps = 60 + Math.floor(Math.random() * 60);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const omt = 1 - t;
    const x = omt * omt * omt * start.x + 3 * omt * omt * t * cps[0]!.x + 3 * omt * t * t * cps[1]!.x + t * t * t * to.x;
    const y = omt * omt * omt * start.y + 3 * omt * omt * t * cps[0]!.y + 3 * omt * t * t * cps[1]!.y + t * t * t * to.y;
    await page.mouse.move(x, y);
    await page.waitForTimeout(2 + Math.random() * 4);
  }
}

/**
 * Hover a real element on the page, jitter the click target within the
 * bounding box, then issue a human-paced mousedown / mouseup.
 */
export async function humanClick(page: Page, selector: string): Promise<void> {
  const el = await page.waitForSelector(selector);
  const box = await el.boundingBox();
  if (!box) throw new Error('no box');
  const target = {
    x: box.x + box.width / 2 + (Math.random() - 0.5) * 6,
    y: box.y + box.height / 2 + (Math.random() - 0.5) * 6,
  };
  await bezierMove(page, target);
  await page.waitForTimeout(80 + Math.random() * 320);
  await page.mouse.down();
  await page.waitForTimeout(20 + Math.random() * 50);
  await page.mouse.up();
}
