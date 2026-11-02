import { expect, type Locator, type Page } from "@playwright/test";

let counter = 0;

/** A slug unique within the run, so tests share one server but no data. */
export function uniqueSlug(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

/** Development sign-in: every email is an instance admin, so it can act in every space. */
export async function signIn(page: Page, email: string): Promise<void> {
  await page.goto("/");
  const form = page.getByRole("form", { name: "Development sign-in" });
  await form.getByLabel("Email").fill(email);
  await form.getByRole("button", { name: "Sign in" }).click();
  await expect(
    page.getByRole("heading", { name: "Organizations" }),
  ).toBeVisible();
}

export interface SpaceInfo {
  /** `/orgs/<orgId>/spaces/<spaceId>`. */
  readonly path: string;
  readonly orgId: string;
  readonly spaceId: string;
}

/** Signs in and creates an organization (every plugin on) and a space. */
export async function openNewSpace(
  page: Page,
  email = "author@example.com",
): Promise<SpaceInfo> {
  await signIn(page, email);
  await page.goto("/?new=org");
  const org = page.getByRole("form", { name: "Create organization" });
  await org.getByLabel("Name").fill("E2E");
  await org.getByLabel("Slug").fill(uniqueSlug("org"));
  await org.getByRole("button", { name: "Create organization" }).click();

  await expect(page).toHaveURL(/\/orgs\/[^/?]+$/);

  await page.goto(`${new URL(page.url()).pathname}?new=space`);

  const space = page.getByRole("form", { name: "Create space" });
  await space.getByLabel("Name").fill("Docs");
  await space.getByLabel("Slug").fill(uniqueSlug("space"));
  await space.getByRole("button", { name: "Create space" }).click();
  await expect(page).toHaveURL(/\/orgs\/[^/]+\/spaces\/[^/]+$/);
  const path = new URL(page.url()).pathname;
  const [, , orgId = "", , spaceId = ""] = path.split("/");
  return { path, orgId, spaceId };
}

export function editorBody(page: Page): Locator {
  return page.getByRole("textbox", { name: "Page body" });
}

export async function newPage(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: /^\+? ?New page$/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/pages\/[^/?]+(\?.*)?$/);
  await expect(editorBody(page)).toBeVisible();
}

export async function save(page: Page): Promise<void> {
  await page.getByRole("textbox", { name: "Page body" }).focus();
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.locator(".bar .save-state")).toHaveText("Saved");
}

/** The current page's ID, from the URL. */
export function pageIdOf(page: Page): string {
  const match = /\/pages\/([^/?]+)/.exec(new URL(page.url()).pathname);
  if (!match?.[1]) throw new Error(`not on a page: ${page.url()}`);
  return decodeURIComponent(match[1]);
}

/** The plain text of a page as the server stores it at `branch`, or `undefined` when it does not exist there. */
export async function storedText(
  page: Page,
  space: SpaceInfo,
  pageId: string,
  branch = "main",
): Promise<string | undefined> {
  return page.evaluate(
    async (url) => {
      const response = await fetch(url);
      if (response.status === 404) return undefined;
      if (!response.ok)
        throw new Error(`${response.status} ${await response.text()}`);
      const texts: string[] = [];
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (typeof node !== "object" || node === null) return;
        const record = node as Record<string, unknown>;
        if (record.type === "text" && typeof record.text === "string")
          texts.push(record.text);
        walk(record.inline);
        walk(record.content);
      };
      const json = (await response.json()) as { page: { body: unknown } };
      walk(json.page.body);
      return texts.join("\n");
    },
    `/api${space.path}/pages/${pageId}${branch === "main" ? "" : `?branch=${encodeURIComponent(branch)}`}`,
  );
}
