import type { FullConfig } from '@playwright/test';

/** Waits until both backend services answer through the web origin. */
export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL ?? 'http://localhost:5173';
  const deadline = Date.now() + 90_000;

  for (const path of ['/api/health', '/media/health']) {
    for (;;) {
      try {
        const response = await fetch(`${baseURL}${path}`);
        if (response.ok) break;
      } catch {
        // Service still starting.
      }
      if (Date.now() > deadline) throw new Error(`${path} did not become healthy in time`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}
