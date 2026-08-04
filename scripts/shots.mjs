#!/usr/bin/env node
/**
 * Screenshot harness for the web PWA.
 *
 * Builds nothing and starts nothing on its own — point it at a directory of
 * built output and it serves, seeds, drives, and captures. Used to eyeball
 * progress on the reminder-editor work (docs/plans/due-parity-build-plan.md)
 * and to catch visual regressions between its phases.
 *
 *   pnpm --filter @alarmed/web build
 *   node scripts/shots.mjs [outDir]
 *
 * Notes for whoever picks this up:
 * - Build WITHOUT `CI=true`. The Vite config switches `base` to `/badgr.me/`
 *   when CI is set, and a naive static server then returns index.html for
 *   `/badgr.me/assets/*`, which shows up as MIME-type errors and a blank page.
 * - Chromium is pre-installed at PLAYWRIGHT_BROWSERS_PATH. Never run
 *   `playwright install`.
 */
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const DIST = resolve(process.argv[2] ?? "apps/web/dist");
const OUT = resolve(process.argv[3] ?? "/tmp/badgr-shots");
const PORT = 4317;

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

/** Static server with SPA fallback — but only for paths that aren't asset-shaped. */
function serve(root) {
  return new Promise((ready) => {
    const server = createServer(async (req, res) => {
      const urlPath = decodeURIComponent(req.url.split("?")[0]);
      let filePath = join(root, urlPath === "/" ? "index.html" : urlPath);
      if (!existsSync(filePath) || !extname(filePath)) {
        filePath = join(root, "index.html");
      }
      try {
        const body = await readFile(filePath);
        res.writeHead(200, { "content-type": MIME[extname(filePath)] ?? "application/octet-stream" });
        res.end(body);
      } catch {
        res.writeHead(404).end("not found");
      }
    });
    server.listen(PORT, () => ready(server));
  });
}

/**
 * Fixture tasks, pinned relative to a fixed "now" so screenshots are
 * comparable between runs. Deliberately covers the states worth looking at:
 * overdue, imminent, undated, paused, completed, and one with notes.
 */
function fixtures(now) {
  const iso = (offsetMinutes) => new Date(now + offsetMinutes * 60_000).toISOString();
  const base = {
    notes: null,
    createdAt: iso(-10_000),
    nagIntervalSeconds: 900,
    nagMaxCount: 6,
    nagUntil: null,
    escalationMode: "none",
    completedAt: null,
    dismissedAt: null,
    repeatRule: null,
    priority: 0,
    deviceOrigin: "web",
    deletedAt: null,
    snoozeCount: 0,
  };
  return [
    { ...base, id: "t-overdue", title: "Take shot", fireAt: iso(-95), updatedAt: iso(-95), snoozeCount: 2 },
    { ...base, id: "t-soon", title: "Call the pharmacy", fireAt: iso(18), updatedAt: iso(-60), nagIntervalSeconds: 300 },
    { ...base, id: "t-later", title: "Water the plants", fireAt: iso(240), updatedAt: iso(-400), repeatRule: "weekly" },
    { ...base, id: "t-paused", title: "Renew the passport", fireAt: iso(1400), updatedAt: iso(-900), dismissedAt: iso(-30) },
    { ...base, id: "t-undated", title: "Read the Bitwarden whitepaper", fireAt: null, updatedAt: iso(-1200) },
    { ...base, id: "t-notes", title: "Pack for the trip", fireAt: iso(600), updatedAt: iso(-200), notes: "- charger\n- passport\n- adapters" },
    { ...base, id: "t-done", title: "Pay the electricity bill", fireAt: iso(-1500), updatedAt: iso(-1400), completedAt: iso(-1400) },
  ];
}

const shots = [];
async function shoot(page, name, note) {
  const file = join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  shots.push({ name, note, file });
  console.log(`  captured ${name}${note ? ` — ${note}` : ""}`);
}

const server = await serve(DIST);
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
});

try {
  const NOW = Date.parse("2026-08-03T09:00:00.000Z");
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    colorScheme: "dark",
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
  });

  await context.addInitScript(
    ([tasks, now]) => {
      localStorage.setItem("alarmed.tasks", JSON.stringify(tasks));
      // Freeze Date.now so relative labels ("3 hr ago") are stable across runs.
      const RealDate = Date;
      // eslint-disable-next-line no-global-assign
      Date = class extends RealDate {
        constructor(...args) {
          super(...(args.length ? args : [now]));
        }
        static now() {
          return now;
        }
      };
    },
    [fixtures(NOW), NOW]
  );

  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);

  await shoot(page, "01-list", "task list with fixtures");

  const settings = page.getByRole("button", { name: "Settings" });
  if (await settings.count()) {
    await settings.first().click();
    await page.waitForTimeout(500);
    await shoot(page, "02-quick-panel", "quick settings panel");

    const all = page.getByText("All settings", { exact: false });
    if (await all.count()) {
      await all.first().click();
      await page.waitForTimeout(500);
      await shoot(page, "03-settings", "full settings drawer");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
    }
  }

  // Open the editor on the overdue task — the state the past-due work targets.
  const overdue = page.getByText("Take shot", { exact: false });
  if (await overdue.count()) {
    await overdue.first().click();
    await page.waitForTimeout(500);
    await shoot(page, "04-task-expanded", "expanded task panel");

    const edit = page.getByText("Edit task", { exact: false });
    if (await edit.count()) {
      await edit.first().click();
      await page.waitForTimeout(500);
      await shoot(page, "05-editor-top", "editor — past-due state");

      // The nag preset list sits below the fold; scroll the drawer itself.
      const drawer = page.locator("aside.drawer");
      await drawer.evaluate((el) => el.scrollTo(0, el.scrollHeight));
      await page.waitForTimeout(400);
      await shoot(page, "06-editor-presets", "nag presets + fire-time preview");

      const customRow = page.getByRole("radio", { name: /Custom/ });
      if (await customRow.count()) {
        await customRow.first().click();
        await page.waitForTimeout(300);
        await drawer.evaluate((el) => el.scrollTo(0, el.scrollHeight));
        await page.waitForTimeout(300);
        await shoot(page, "07-editor-custom", "custom nag controls");
        await customRow.first().click();
        await page.waitForTimeout(250);
      }

      const more = page.getByRole("button", { name: /More options/ });
      if (await more.count()) {
        await more.first().click();
        await page.waitForTimeout(400);
        await drawer.evaluate((el) => el.scrollTo(0, el.scrollHeight));
        await page.waitForTimeout(400);
        await shoot(page, "08-editor-more", "notes + repeat behind disclosure");

        // Phase 4: the pre-alarm row only exists on a dated task, and its
        // summary line is the thing worth seeing — pick a value so the shot
        // shows a derived sentence rather than the default "Off".
        const leadChip = page
          .locator(".when-row .when-chip", { hasText: /^15 min$/ })
          .first();
        if (await leadChip.count()) {
          await leadChip.scrollIntoViewIfNeeded();
          await leadChip.click();
          await page.waitForTimeout(350);
          await shoot(page, "09-editor-leadtime", "pre-alarm lead time (Phase 4)");
        }
      }
    }
  }

  // Vault panel: the recovery work (portable-sync plan §7). Close whatever the
  // editor left open first — an open drawer swallows clicks aimed behind it.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

  const settingsBtn = page.getByRole("button", { name: "Settings" });
  if (await settingsBtn.count()) {
    await settingsBtn.first().click();
    await page.waitForTimeout(400);
    const all = page.getByText("All settings", { exact: false });
    if (await all.count()) {
      await all.first().click();
      await page.waitForTimeout(500);
      const drawer = page.locator("aside.drawer");
      await drawer.evaluate((el) => el.scrollTo(0, el.scrollHeight));
      await page.waitForTimeout(400);
      await shoot(page, "10-vault-setup", "vault setup — no-recovery acknowledgement");

      const recoverLink = page.getByText("Forgotten your passphrase", { exact: false });
      if (await recoverLink.count()) {
        await recoverLink.first().click();
        await page.waitForTimeout(350);
        await drawer.evaluate((el) => el.scrollTo(0, el.scrollHeight));
        await page.waitForTimeout(350);
        await shoot(page, "11-vault-recover", "recover with the sheet");
      }
    }
  }

  if (errors.length) {
    console.log(`\n  ${errors.length} console error(s):`);
    for (const e of errors.slice(0, 5)) console.log(`   ! ${e.slice(0, 160)}`);
  }

  console.log(`\n${shots.length} screenshots -> ${OUT}`);
} finally {
  await browser.close();
  server.close();
}
