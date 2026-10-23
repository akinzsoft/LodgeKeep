// Captures the Help guides' screenshots from the demo hotel, driven by manifest.json.
// How to run: docs/help-screenshots.md. Writes compressed webp files to
// public/help/images/<guide>/ and prints the front matter to paste into each guide.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { chromium } from 'playwright';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(root, 'public', 'help', 'images');
const MAX_BYTES = 250 * 1024; // the lint/test limit is 300 KB; stay clear of it
const only = process.argv.find((arg) => arg.startsWith('--guide='))?.slice('--guide='.length);

/** The same check the demo seed uses: never point this at a real site. */
export function assertLocal(baseUrl) {
  const { hostname } = new URL(baseUrl);
  if (hostname !== 'localhost' && !hostname.endsWith('.localhost')) {
    throw new Error(`Refusing to capture ${baseUrl}: the demo hotel runs on *.localhost only.`);
  }
}

const locate = (page, target) =>
  target.selector ? page.locator(target.selector).first() : page.getByRole(target.role, { name: target.name, exact: true }).first();

async function launch() {
  try {
    return await chromium.launch();
  } catch {
    // No downloaded Chromium: fall back to an installed Google Chrome.
    return chromium.launch({ channel: 'chrome' });
  }
}

/** Re-encodes until the file is small enough. */
async function toWebp(png) {
  for (const quality of [82, 72, 62, 50, 40]) {
    const data = await sharp(png).webp({ quality, effort: 6 }).toBuffer();
    if (data.length <= MAX_BYTES) return data;
  }
  throw new Error('Screenshot is still over the size limit at the lowest quality; capture a smaller area.');
}

async function main() {
  const manifest = JSON.parse(await readFile(join(root, 'scripts', 'help-capture', 'manifest.json'), 'utf8'));
  assertLocal(manifest.baseUrl);
  const browser = await launch();
  const context = await browser.newContext({
    viewport: manifest.viewport,
    deviceScaleFactor: 1,
    colorScheme: 'light',
    reducedMotion: 'reduce',
    locale: 'en-NG',
    timezoneId: 'Africa/Lagos',
  });
  const page = await context.newPage();
  // A fixed light theme, whatever the OS says, and no animation noise.
  await page.addInitScript(() => document.documentElement.setAttribute('data-theme', 'light'));

  await page.goto(manifest.baseUrl);
  await page.getByLabel('Email').fill(manifest.login.email);
  await page.locator('input[type="password"]').fill(manifest.login.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Home' }).first().waitFor();

  for (const entry of manifest.guides) {
    if (only && entry.guide !== only) continue;
    const dir = join(OUT, entry.guide);
    await mkdir(dir, { recursive: true });
    const frontmatter = [];
    for (const shot of entry.shots) {
      await page.getByRole('button', { name: 'Home' }).first().click();
      for (const step of shot.steps) await locate(page, step.click).click();
      await page.waitForLoadState('networkidle');
      // Never photograph a loading state: wait for every skeleton placeholder to go.
      await page.waitForFunction(() => document.querySelectorAll('[class*="Skeleton_"]').length === 0);
      await page.waitForTimeout(300);
      await page.addStyleTag({ content: '*{animation:none!important;transition:none!important;caret-color:transparent!important}' });
      if (shot.highlight) {
        await locate(page, shot.highlight).evaluate((el) => {
          el.style.outline = '3px solid #E11D48';
          el.style.outlineOffset = '3px';
          el.style.borderRadius = '6px';
        });
      }
      const data = await toWebp(await page.screenshot({ type: 'png' }));
      await writeFile(join(dir, `${shot.name}.webp`), data);
      console.log(`${entry.guide}/${shot.name}.webp  ${(data.length / 1024).toFixed(0)} KB`);
      frontmatter.push(`  - file: ${entry.guide}/${shot.name}.webp\n    alt: ${shot.alt}\n    caption: ${shot.caption}`);
    }
    console.log(`\nFront matter for ${entry.guide}:\nimages:\n${frontmatter.join('\n')}\n`);
  }
  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
