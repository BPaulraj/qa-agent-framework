---
name: qa-adapter-web
description: Web UI adapter (L1) covering how to drive and verify a browser application, both exploratory via Playwright MCP and scripted in the repo's existing framework (Playwright, Cypress, Selenium, WebdriverIO). Covers locators, waits, evidence capture, result mapping, and web-specific checks. Use whenever executing or automating a test with appType web.
---

# Web adapter (L1)

Read `qa.config.json → environments.<env>.webBaseUrl` and `automation.web` first. The guard hook
blocks navigation to blocked environments.

## A. Exploratory execution (Playwright MCP)

Tools: `mcp__playwright__browser_*`. If they aren't available, tell the user to enable the
Playwright MCP server (`/qa-init` writes `.mcp.json`) and restart Claude Code, or fall back to scripted mode.

Loop per case step:
1. `browser_navigate` to `webBaseUrl` + path
2. `browser_snapshot` to read the accessibility tree. Use it (not screenshots) to find elements and
   read text; it is cheaper and more precise.
3. Act: `browser_click`, `browser_type`, `browser_fill_form`, `browser_select_option`,
   `browser_press_key`, `browser_file_upload`
4. Wait for the outcome: `browser_wait_for` (text appears or disappears). Never assume instant updates.
5. Verify against the step's `expected` using the snapshot text. For API-backed checks also use
   `browser_network_requests` (status codes, failed calls).
6. Evidence: `browser_take_screenshot` with filename `<caseId>-step<N>.png` at each verification
   point and at any failure. Copy the file from `.qa/mcp-output/` into `<runDir>/evidence/`.
   On failure also save `browser_console_messages` and the relevant network entries to
   `<runDir>/evidence/<caseId>-console.txt` / `-network.txt`.

Credentials: read them from env vars named in `environments.<env>.auth`. Type them with
`browser_type`, and never echo the value in your messages or evidence.

While exploring, also try: refresh mid-flow, browser back, a double-click on submit, an empty or long
or unicode input, and a deep link without a session. Note locators you relied on; they seed the scripted version.

## B. Scripted execution (repo framework)

If `.claude/skills/repo-automation-conventions/SKILL.md` exists, **it takes precedence** over the
generic guidance below (base classes, driver factory, page object style, run flags). Existing tests
in automation repos are run via the catalog (`make-suite.mjs` → build command → `parse-results.mjs`);
see the qa-executor agent.

**Match the repo.** Before writing anything, open 2–3 existing tests in `automation.web.testDir` and
copy their structure: page objects or not, fixtures, base URL handling, auth setup, naming, data
helpers. Follow `automation.web.conventions`. If `framework` is `none`, propose Playwright plus the
repo's main language and ask before adding it.

Naming contract (maps results back to cases): the test title **starts with the case id**:
`test('TC-CHK-001 Guest can check out with a saved card', …)`. Keep one case per test.

Framework guidance:

| Framework | Locators | Waiting | Evidence |
|---|---|---|---|
| Playwright | `getByRole`, `getByLabel`, `getByTestId`; avoid CSS/XPath chains | web-first `expect(locator).toHaveText()`; never `waitForTimeout` | `trace: 'on-first-retry'`, `screenshot: 'only-on-failure'` |
| Cypress | `cy.findByRole` (testing-library) or `data-cy`/`data-testid` | built-in retry; `cy.intercept` + `cy.wait('@alias')` for network | `screenshotOnRunFailure`, videos per config |
| Selenium | `By.id`, `data-testid`; avoid absolute XPath | `WebDriverWait` + `ExpectedConditions`; never `Thread.sleep` | screenshot in teardown on failure |
| WebdriverIO | `$('aria/…')`, `data-testid` | `waitForDisplayed`, `expect(el).toHaveText` | `afterTest` screenshot hook |

General rules:
- Test data comes from the case's `data`. Secrets come from `process.env` / `System.getenv` and are never hardcoded.
- Each test creates its own data (prefix `qa-auto-`) or uses dedicated read-only fixtures, and cleans up
  where possible
- Assertions check the case's `expected` values precisely
- Update the case: `automation.status: automated`, `automation.script: <path>[:<test title>]`

Running: use `automation.web.runCommand`. Filter to the selected cases with the framework's grep
(Playwright `--grep "TC-CHK-001|TC-CHK-002"`, Cypress `--spec` or `@cypress/grep`, JUnit/TestNG
groups, pytest `-k`). Prefer a machine-readable reporter (Playwright `--reporter=json`, JUnit XML)
and map results by the case id prefix in the test title. Copy failure screenshots and traces into `<runDir>/evidence/`.

## Web-specific checks worth adding to cases

- Page refresh and browser back mid-flow; deep links; session expiry → redirect to login and return
- Double submit (button disabled or request idempotent)
- Client vs. server validation (repeat the request via API without UI validation)
- Responsive breakpoints when layout matters (`browser_resize` to 375, 768, and 1280 widths)
- Console errors and failed network calls during the happy path (should be none)
- Accessibility basics: every input has a label, keyboard-only flow works, focus visible, images have alt
  text. Use axe if the repo already has `@axe-core/playwright` or similar.
- Cross-browser only when the pack or config says it matters (use pairwise over browser × feature)
