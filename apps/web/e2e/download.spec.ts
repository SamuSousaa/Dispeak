import { expect, test } from '@playwright/test';

test('the download page is public and links to the installer', async ({ page }) => {
  // No release is uploaded to the dev server: the page must do without the version.
  await page.goto('/download');
  await expect(page.getByRole('heading', { name: 'Dispeaker' })).toBeVisible();
  await expect(page.getByTestId('download-installer')).toHaveAttribute(
    'href',
    '/download/Dispeaker-Setup.exe',
  );
  await expect(page.getByTestId('download-version')).toHaveText('WINDOWS 10 E 11, 64 BITS');

  // With a release feed, its version and date are shown.
  await page.route('**/download/latest.yml', (route) =>
    route.fulfill({
      contentType: 'text/yaml',
      body: "version: 9.8.7\npath: Dispeaker-Setup-9.8.7.exe\nreleaseDate: '2026-10-11T12:00:00.000Z'\n",
    }),
  );
  await page.reload();
  await expect(page.getByTestId('download-version')).toContainText('VERSÃO 9.8.7');
  await expect(page.getByTestId('download-version')).toContainText('OUTUBRO DE 2026');

  await page.getByRole('link', { name: 'USAR NO NAVEGADOR' }).click();
  await expect(page).toHaveURL(/\/login/);
});
