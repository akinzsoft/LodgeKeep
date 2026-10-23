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
// --match=booking/ captures only the shots whose name starts with that text.
const match = process.argv.find((arg) => arg.startsWith('--match='))?.slice('--match='.length);
const failures = [];

/** The same check the demo seed uses: never point this at a real site. */
export function assertLocal(baseUrl) {
  const { hostname } = new URL(baseUrl);
  if (hostname !== 'localhost' && !hostname.endsWith('.localhost')) {
    throw new Error(`Refusing to capture ${baseUrl}: the demo hotel runs on *.localhost only.`);
  }
}

const locate = (page, target) =>
  target.selector ? page.locator(target.selector).first() : page.getByRole(target.role, { name: target.name, exact: target.exact ?? true }).first();

/**
 * One manifest step: `click`, `fill` ({label, value}), `select` ({label, option}),
 * `scroll` (bring an element into view so a long screen shows the useful part) or `wait` (ms).
 */
/** `@today-4` becomes the demo property's date four days ago (Africa/Lagos), so ranges always cover the seeded days. */
function resolveValue(value) {
  const match = /^@today([+-]\d+)?$/.exec(value);
  if (!match) return value;
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Lagos' }));
  d.setDate(d.getDate() + Number(match[1] ?? 0));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Long screens: always start from the top, so the shot shows the useful part, not wherever the last screen was scrolled. */
const scrollToTop = (page) =>
  page.evaluate(() => {
    globalThis.scrollTo(0, 0);
    for (const el of document.querySelectorAll('*')) if (el.scrollTop > 0) el.scrollTop = 0;
  });

async function runStep(page, step) {
  if (step.click && step.click.force) await locate(page, step.click).dispatchEvent('click'); // a clipped tab bar can leave a tab "not visible"
  else if (step.click) await locate(page, step.click).click();
  else if (step.fill) await page.getByLabel(step.fill.label, { exact: true }).first().fill(resolveValue(step.fill.value));
  else if (step.select) {
    const select = (step.select.selector ? page.locator(step.select.selector) : page.getByLabel(step.select.label, { exact: true })).first();
    // `contains` picks the option whose text includes that text (outlet names carry a "(store)" style suffix).
    if (step.select.contains) {
      const value = await select.evaluate((el, text) => [...el.options].find((o) => o.text.includes(text))?.value, step.select.contains);
      await select.selectOption(value);
    } else await select.selectOption(step.select.option);
  }
  else if (step.scroll) await locate(page, step.scroll).scrollIntoViewIfNeeded();
  else if (step.wait) await page.waitForTimeout(step.wait);
  else throw new Error(`Unknown step ${JSON.stringify(step)}`);
}

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
  // Pop-up cards (sign-in reminders) would cover the top-right of every shot: dismiss them first.
  await page.waitForTimeout(2500);
  for (const dismiss of await page.getByRole('button', { name: 'Dismiss', exact: true }).all()) await dismiss.click();

  for (const entry of manifest.guides) {
    if (only && entry.guide !== only) continue;
    const dir = join(OUT, entry.guide);
    await mkdir(dir, { recursive: true });
    const frontmatter = [];
    for (const shot of entry.shots) {
      if (match && !shot.name.startsWith(match)) continue;
      try {
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Home' }).first().click();
      await scrollToTop(page);
      for (const step of shot.steps) await runStep(page, step);
      if (!shot.steps.some((step) => step.scroll)) await scrollToTop(page);
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
      await page.mouse.move(2, 2); // no stray hover shading from the last click
      const png = await page.screenshot({ type: 'png' });
      // The highlight is an inline style React does not clear: remove it so it cannot appear in the next shot.
      await page.evaluate(() => {
        for (const el of document.querySelectorAll('[style*="E11D48"], [style*="rgb(225, 29, 72)"]')) {
          el.style.outline = '';
          el.style.outlineOffset = '';
          el.style.borderRadius = '';
        }
      });
      const data = await toWebp(png);
      await mkdir(dirname(join(dir, `${shot.name}.webp`)), { recursive: true });
      await writeFile(join(dir, `${shot.name}.webp`), data);
      console.log(`${entry.guide}/${shot.name}.webp  ${(data.length / 1024).toFixed(0)} KB`);
      frontmatter.push(`  - file: ${entry.guide}/${shot.name}.webp\n    alt: ${shot.alt}\n    caption: ${shot.caption}`);
      } catch (error) {
        failures.push(`${entry.guide}/${shot.name}: ${error.message.split('\n')[0]}`);
        console.error(`FAILED ${entry.guide}/${shot.name}`);
      }
    }
    console.log(`\nFront matter for ${entry.guide}:\nimages:\n${frontmatter.join('\n')}\n`);
  }
  await browser.close();
  if (failures.length) {
    console.error(`\n${failures.length} shot(s) failed:\n${failures.join('\n')}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
