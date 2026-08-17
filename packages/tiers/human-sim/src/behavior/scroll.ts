import type { Page } from 'playwright';

/**
 * Simulate a human reading the page: 3-7 wheel pulses, each 200-800px
 * of deltaY, each followed by a 150-400ms pause as if scanning the
 * newly-revealed text. Total scrolled distance is roughly 600 - 5600px,
 * which empirically lands in the 30-85% of a typical page-height range.
 */
export async function humanScroll(page: Page): Promise<void> {
  const pulses = 3 + Math.floor(Math.random() * 5);
  for (let i = 0; i < pulses; i++) {
    const delta = 200 + Math.random() * 600;
    await page.mouse.wheel(0, delta);
    await page.waitForTimeout(150 + Math.random() * 250);
  }
}
