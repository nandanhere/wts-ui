# Product polish browser evidence

The fixture renders the full App with its real HTTP client, Pierre diff renderer, Mermaid renderer, React Aria controls, and global styles. Playwright intercepts every API route. It blocks unknown writes. The only modeled writes are local fixture workflow changes and read-only service analysis. No provider reply, agent send, runtime start, workspace removal, or user-data change occurs.

## Reproduce

From `ui`, use Node 22 and run:

```sh
npm exec -- playwright test --config playwright.product-polish.config.ts
```

Use `WTS_POLISH_UI_ROOT` to point at a frozen UI source tree. Use `WTS_POLISH_OUTPUT` to select the artifact directory. Each source tree has a separate Vite dependency cache. Browser storage is isolated.

## Confirmed before/after boundaries

| Check | Before | After |
|---|---|---|
| Cached Conversations return | Thread controls moved76px when saved/loading notices disappeared | Fixed toolbar keeps controls in place |
| Workspace outer scroll |180px became0after Plans or Spaces return |180px restored on both returns |
|375px workspace header | Title and tabs overlapped13.83px vertically | Separate rows |
|375px Plans file list |158px buttons overlapped69.25px | Separate file controls; End reveals final file |
|375px selected Plans filename | Available text width10.375px | Full toolbar row |
| Plans controls and guidance |10–11px text | At least12px; feedback input13px |
| Services analysis | Pending state claimed runnable results; empty state repeated; unselected ports still counted | Honest pending state; one empty state; only selected ports count |
| Local diff glyph font | New shared stack fell back to Courier13px | Actual CDP glyph font is Menlo13px |

Baseline red logs: `/tmp/wts-polish-before-final-evidence.log`, `/tmp/wts-polish-before-narrow.log`, `/tmp/wts-polish-font-red.log`.

Initial current-source full-App gate passed7/7in34.7seconds (`/tmp/wts-polish-after-full.log`). The added375×640review/queued-feedback case also passed. The expanded final run passed8of10cases. Two cases timed out during a host pause. A1500ms fixture timer took1,038,177ms. Both unchanged cases then passed in11.3seconds. No timeouts were increased. A later screenshot review identified a separate global-header overlap at1024px; its red geometry gate and root CSS fix are tracked below.

## Cache timing conditions

Machine: Apple M1Pro,10logical CPUs,16GiB memory, macOS/Darwin24.6.0. Node22.13.1. Chromium149.0.7827.55. Viewport1440×900. Vite development modules. One Playwright worker. Both phases ran sequentially with other team tests idle. Data was already cached. Each of15returns per view waited for a1500ms fixture refresh before the next sample.

The measurement starts at pointerdown and ends after Playwright observes the target as visible plus two animation frames. It includes automation overhead and is an upper-bound observation, not a native paint measurement. It does not prove every cached paint meets the200ms target. No general speed increase is claimed.

| Cached view | Before median | After median | Before observed maximum | After observed maximum |
|---|---:|---:|---:|---:|
| Plans |162.4ms |160.8ms |352.5ms |203.4ms |
| Conversations |100.6ms |103.4ms |287.1ms |337.5ms |

All60returns showed cached content before the delayed refresh completed. With15samples, nearest-rank p95equals the observed maximum. After Plans had one observation over200ms (203.4ms). After Conversations had one observation over200ms (337.5ms). Raw samples and source artifacts: `/tmp/wts-product-polish-timing-summary.json`.

## Coverage and limits

Scenarios cover board navigation, workspace details, Plans cache, local and MR Changes, conversation selection/drafts, background refresh, feedback transcript/queue, settings, empty review inbox, ActivityWatch setup guidance, failed cached reads and recovery, service selection, keyboard command palette, reduced-motion preference, physical scrolling, and375/1024/1440px layouts. The final375×640case uses a long conversation path and checks button geometry and physical wheel access to the feedback composer without sending.

Live GitLab/Jira/ActivityWatch behavior, native-window rendering, real agents, and real runtime lifecycle are outside this fixture. Root tracks those checks separately. Screenshots and mocked tests do not establish live external integration success. The short MR view now shows actual changed lines on entry. File and toolbar controls remain reachable through horizontal scrolling and keyboard focus.


## Final artifacts

- Main final screenshots: `/tmp/wts-product-polish-after-main-final`. Both themes passed in 22.5 seconds after the last selector/layout change (`/tmp/wts-polish-after-main-final.log`).
- Medium and selected-Services retry screenshots: `/tmp/wts-product-polish-after-retry`.
- Frozen baseline screenshots: `/tmp/wts-product-polish-before-final`.
- Short feedback composer: `/tmp/wts-product-polish-after-final/product-polish-short-narro-dce 62-ack-keep-controls-reachable-chromium/05-narrow-feedback-composer.png`.
- Typecheck: `/tmp/wts-polish-e 2 e-types-final.log` (passed).

A final1024px inspection found that the global header used two grid columns for three children between781and1100px. Its52px header contained buttons extending to76px. The browser assertion failed in `/tmp/wts-polish-medium-red.log`. The frozen baseline image has the same defect. Root removed the two-column override. The unchanged focused browser case passed in `/tmp/wts-polish-medium-green.log`. Final medium images are in `/tmp/wts-product-polish-medium-green`.

A final short MR check recorded the comparison toolbar at y451.86px and no visible code at375×640. After the layout change, the toolbar starts at342.53px and93.47px of actual shadow-rendered code is visible. The first wrapper measurement incorrectly included filename/actions; the final test uses the actual code element. Red logs are `/tmp/wts-polish-short-red.log` and `/tmp/wts-polish-short-code-red.log`. Final green log: `/tmp/wts-polish-short-final.log`.


## Final status

Source and fixtures are stable. The10functional browser scenarios pass across the final run and bounded unchanged retries. The two cache tests each passed15returns on both source versions. Strict E2E TypeScript and diff checks pass. Parent owns the final broad UI, native, build, and HTTP checks.

Final short MR and feedback screenshots: `/tmp/wts-product-polish-short-final/product-polish-short-narro-dce 62-ack-keep-controls-reachable-chromium/`. Final1024px screenshots: `/tmp/wts-product-polish-medium-green/product-polish-medium-view-22687-and-Plans-controls-readable-chromium/`. Main1440px light/dark screenshots: `/tmp/wts-product-polish-after-final/`.

Keyboard checks include opening and closing the command palette, restoring focus, Plans End navigation, horizontal file selection, the Diff options menu, and exact unread-link focus. At 375×640, a physical wheel gesture reveals the full feedback Send button. No test clicks Send, Reply to GitLab, Ask agent to fix, Cancel request, or a real external mutation.

The final short case passed in 7.3 seconds, including keyboard activation and Escape focus return for Diff options. The fixture ignores generated build/test reports so other test jobs cannot reload its page.
