import type { Request } from 'playwright';

// A navigation in an iframe is not a navigation of the destination page.
// Popup main frames still count; detached frames cannot claim ownership.
export function isTopLevelNavigation(request: Pick<Request, 'isNavigationRequest' | 'frame'>): boolean {
  try {
    if (!request.isNavigationRequest()) return false;
    const frame = request.frame();
    return frame === frame.page().mainFrame();
  } catch { return false; }
}
