import { test, expect, type Page } from "@playwright/test";

/**
 * End-to-end: login → import catalog key → open encrypted title → stream-decrypt plays.
 *
 * Required env:
 *   E2E_ADMIN_USER (default admin)
 *   E2E_ADMIN_PASSWORD
 *   E2E_CATALOG_KEY   — same base64 key used to encrypt S3 objects
 *   E2E_TITLE_ID      — default city-lights-1931-movie
 */

const USER = process.env.E2E_ADMIN_USER ?? "admin";
const PASS = process.env.E2E_ADMIN_PASSWORD ?? "e2e-test-pass-123";
const CATALOG_KEY = process.env.E2E_CATALOG_KEY ?? "";
const TITLE_ID = process.env.E2E_TITLE_ID ?? "city-lights-1931-movie";

async function login(page: Page) {
  await page.goto("/login");
  await page.locator('input#username, input[name="username"], input[autocomplete="username"]').first().fill(USER);
  await page.locator('input[type="password"]').first().fill(PASS);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 30_000 });
}

async function ensureCatalogKey(page: Page) {
  await page.goto("/account");
  // EN + pt-BR headings
  await expect(
    page.getByRole("heading", {
      name: /storage encryption|criptografia de armazenamento/i,
    }),
  ).toBeVisible({
    timeout: 20_000,
  });
  // Wait for /api/crypto/status to finish
  await expect(page.getByText(/^(Loading…|Carregando…)$/)).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(
    page.getByText(/Org encryption:|Criptografia da org:/i),
  ).toBeVisible({ timeout: 15_000 });

  const section = page
    .locator("section")
    .filter({ hasText: /storage encryption|criptografia de armazenamento/i });
  const statusText = await section.innerText();
  if (
    /Unlocked on this device:\s*yes|Desbloqueada neste dispositivo:\s*sim/i.test(
      statusText,
    )
  ) {
    return;
  }

  const importBtn = page.getByRole("button", {
    name: /import existing key|importar chave existente/i,
  });
  if (await importBtn.isVisible().catch(() => false)) {
    await importBtn.click();
    await page.getByPlaceholder(/ENCRYPTION_CATALOG_KEY/i).fill(CATALOG_KEY);
    await page.locator('form input[type="password"]').first().fill(PASS);
    await page
      .getByRole("button", { name: /import & wrap key|importar e proteger/i })
      .click();
    await expect(
      page.getByText(
        /Unlocked on this device:\s*yes|Desbloqueada neste dispositivo:\s*sim/i,
      ),
    ).toBeVisible({
      timeout: 90_000,
    });
    return;
  }

  const unlockBtn = page.getByRole("button", {
    name: /unlock on this device|desbloquear neste dispositivo/i,
  });
  if (await unlockBtn.isVisible().catch(() => false)) {
    await page.locator('form input[type="password"]').first().fill(PASS);
    await unlockBtn.click();
    await expect(
      page.getByText(
        /Unlocked on this device:\s*yes|Desbloqueada neste dispositivo:\s*sim/i,
      ),
    ).toBeVisible({
      timeout: 90_000,
    });
    return;
  }

  throw new Error(
    `Cannot unlock catalog key. Panel text:\n${statusText.slice(0, 800)}`,
  );
}

test("encrypted title: import key and stream-decrypt playback", async ({ page }) => {
  test.setTimeout(300_000);
  if (!CATALOG_KEY) {
    throw new Error("E2E_CATALOG_KEY must be set (ENCRYPTION_CATALOG_KEY from .env.caixote)");
  }

  await login(page);
  await ensureCatalogKey(page);

  // Confirm unlocked
  await page.goto("/account");
  await expect(
    page.getByText(
      /Unlocked on this device:\s*yes|Desbloqueada neste dispositivo:\s*sim/i,
    ),
  ).toBeVisible({ timeout: 15_000 });

  await page.goto(`/title/${TITLE_ID}`);
  const video = page.locator("video");
  await expect(video).toBeVisible({ timeout: 30_000 });

  // Wait until decrypt finishes and media is attached
  await expect
    .poll(
      async () => {
        const decryptErr = await page
          .getByText(
            /decrypt failed|no catalog key|this title is encrypted but|falha ao descriptografar|chave do catálogo não está desbloqueada/i,
          )
          .first()
          .isVisible()
          .catch(() => false);
        if (decryptErr) {
          const msg = await page
            .locator("text=/decrypt|catalog key/i")
            .first()
            .innerText()
            .catch(() => "decrypt error");
          throw new Error(msg);
        }
        return video.evaluate((v: HTMLVideoElement) => ({
          readyState: v.readyState,
          hasSrc: Boolean(v.currentSrc || v.src),
          error: v.error ? `${v.error.code}:${v.error.message}` : null,
        }));
      },
      { timeout: 150_000, intervals: [1000, 2000, 3000] },
    )
    .toMatchObject({ hasSrc: true, error: null });

  // Play (muted — headless autoplay policy)
  await video.evaluate(async (v: HTMLVideoElement) => {
    v.muted = true;
    try {
      await v.play();
    } catch {
      /* click fallback below */
    }
  });
  if (await video.evaluate((v: HTMLVideoElement) => v.paused)) {
    await video.click({ force: true }).catch(() => undefined);
    await video.evaluate(async (v: HTMLVideoElement) => {
      v.muted = true;
      try {
        await v.play();
      } catch {
        /* ignore */
      }
    });
  }

  // currentTime advances or we have future data (HAVE_FUTURE_DATA = 3)
  await expect
    .poll(
      async () => {
        const s = await video.evaluate((v: HTMLVideoElement) => ({
          t: v.currentTime,
          rs: v.readyState,
          err: v.error?.code ?? null,
        }));
        if (s.err != null) throw new Error(`video error code ${s.err}`);
        return s.t > 0.15 || s.rs >= 3;
      },
      { timeout: 120_000, intervals: [500, 1000, 2000] },
    )
    .toBe(true);

  const final = await video.evaluate((v: HTMLVideoElement) => ({
    currentTime: v.currentTime,
    readyState: v.readyState,
    paused: v.paused,
    duration: v.duration,
    error: v.error?.code ?? null,
    srcKind: (v.currentSrc || v.src).startsWith("blob:") ? "blob" : "other",
  }));
  console.log("playback final state", final);
  expect(final.error).toBeNull();
  expect(final.currentTime > 0.15 || final.readyState >= 3).toBeTruthy();
});
