import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  expect,
  test,
  type Browser,
  type Locator,
  type Page,
} from "@playwright/test";
import {
  editorBody,
  newPage,
  openNewSpace,
  pageIdOf,
  save,
  signIn,
  storedText,
  type SpaceInfo,
} from "./helpers.ts";
import { startServer, type E2eServer } from "./server.ts";

// A reconnecting provider backs off, so edits made while the server was
// down can take a while to arrive.
const RECONNECT_TIMEOUT_MS = 60_000;

const data = mkdtempSync(join(tmpdir(), "docleus-collab-e2e-"));
let server: E2eServer | undefined;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  server = await startServer(data);
});

test.afterAll(async () => {
  await server?.stop();
});

interface Pair {
  readonly space: SpaceInfo;
  readonly pageId: string;
  readonly alice: Page;
  readonly bob: Page;
}

/** Alice starts a page on a change request; Bob opens it at that branch. */
async function openTogether(browser: Browser): Promise<Pair> {
  const alice = await (await browser.newContext()).newPage();
  const space = await openNewSpace(alice, "alice@example.com");
  await newPage(alice);
  await expect(alice).toHaveURL(/[?&]branch=cr%2F1|[?&]branch=cr\/1/);
  const pageId = pageIdOf(alice);

  const bob = await (await browser.newContext()).newPage();
  await signIn(bob, "bob@example.com");
  await bob.goto(alice.url());
  await expect(editorBody(bob)).toBeVisible();
  return { space, pageId, alice, bob };
}

function paragraph(page: Page, text: string): Locator {
  return editorBody(page).locator("p").filter({ hasText: text });
}

async function moveToEndOf(page: Page, existing: string): Promise<void> {
  await paragraph(page, existing).click();
  await page.keyboard.press("End");
}

function caretOf(page: Page, name: string): Locator {
  return editorBody(page)
    .locator(".collaboration-carets__caret")
    .filter({ hasText: name });
}

test("two browsers edit one page together and see each other's carets", async ({
  browser,
}) => {
  const { space, pageId, alice, bob } = await openTogether(browser);
  for (const page of [alice, bob]) {
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setCPUThrottlingRate", { rate: 6 });
  }

  await editorBody(alice).click();
  await alice.keyboard.type("First");
  await alice.keyboard.press("Enter");
  await alice.keyboard.type("Second");
  await expect(paragraph(bob, "Second")).toBeVisible();

  await Promise.all([moveToEndOf(alice, "First"), moveToEndOf(bob, "Second")]);
  await Promise.all([
    alice.keyboard.type(" from Alice"),
    bob.keyboard.type(" from Bob"),
  ]);
  for (const page of [alice, bob]) {
    await expect(paragraph(page, "First from Alice")).toBeVisible();
    await expect(paragraph(page, "Second from Bob")).toBeVisible();
  }
  await expect(caretOf(alice, "bob")).toBeVisible();
  await expect(caretOf(bob, "alice")).toBeVisible();

  await save(alice);
  expect(await storedText(alice, space, pageId, "cr/1")).toBe(
    "First from Alice\nSecond from Bob",
  );
});

test("a server restart in the middle of editing loses nothing", async ({
  browser,
}) => {
  const { space, pageId, alice, bob } = await openTogether(browser);

  await editorBody(alice).click();
  await alice.keyboard.type("Before the restart");
  await expect(paragraph(bob, "Before the restart")).toBeVisible();

  await server?.stop();
  await alice.keyboard.press("Enter");
  await alice.keyboard.type("While the server is down");
  server = await startServer(data);

  await expect(paragraph(bob, "While the server is down")).toBeVisible({
    timeout: RECONNECT_TIMEOUT_MS,
  });
  await moveToEndOf(bob, "While the server is down");
  await bob.keyboard.type(", and after");
  await expect(
    paragraph(alice, "While the server is down, and after"),
  ).toBeVisible({ timeout: RECONNECT_TIMEOUT_MS });

  await save(alice);
  expect(await storedText(alice, space, pageId, "cr/1")).toBe(
    "Before the restart\nWhile the server is down, and after",
  );
});
