# Contextual agent feedback

WTS connects selected interface regions and GitLab review threads to local agent conversations. The agent changes source files and reports its results.

## Select a region

1. Hold Option on macOS, or Alt on Windows and Linux.
2. Move the pointer to the region that needs a change.
3. Click the highlighted region.
4. Describe the change in the chat.
5. Select **Send to agent**.

Release the key to leave selection mode. Escape also closes selection mode. Option typing in a text field keeps its usual behavior.

For keyboard selection, focus a control in the region. Press Option+Enter on macOS, or Alt+Enter on other platforms.

WTS includes the region name, stable UI ID, visible text, and control states. On macOS, WTS can include an image of its own window region. Regions that overlap private or editable fields do not include an image. The chat can continue with text context when image capture fails.

## Address a review comment

1. Open a merge request conversation.
2. Select **Ask agent to fix**.
3. Edit the request if necessary.
4. Select **Send to agent**.

The request includes the full thread, original file position, and merge request identity. The agent works in the same project workspace. It reads the latest local files before it applies feedback from an older version.

The GitLab reply draft stays separate. **Reply to GitLab** sends a provider reply. **Send to agent** starts local work. The agent instructions prohibit commits, pushes, publication, and provider comments.

## Continue the work

Close the bubble to continue to use WTS. Select **Agent feedback** to return. One transcript shows requests and results from the selected regions and review threads. Each request keeps its source context. Queued requests appear above the composer. The saved drafts menu keeps unfinished text available when you select another region.

WTS keeps accepted messages and agent results in its local data directory. The browser or desktop webview keeps unsent drafts on the device. It stores draft images separately from draft text.

**View local changes** opens the target workspace and repository. **Stop current task** requests cancellation of the active turn. If a send fails, **Retry send** uses the same request ID. It does not create a second accepted request. WTS does not send a saved draft automatically after a restart.

## Submit several fixes

Send another request while an agent is active. WTS saves the request in the queue. You can also select a different region or review thread without losing the current draft.

Requests in one workspace run in order. Different workspaces can run independently. Each task reads the current source before it makes changes. A later request includes recent completed, failed, and stopped turns for the same workspace, repository, and provider. The agent receives each earlier request with its original source context. The history excludes queued future requests and unrelated projects.

Use **Edit queued request** to change a queued request. Use **Cancel request** to remove it from the queue. WTS retains cancelled requests in the chat. A request that already started cannot be edited or cancelled as a queued request. Your edit text remains available if the task starts before you save it.

**Stop current task** stops the active turn. Other queued requests remain scheduled. A failed task does not retry on its own. **Retry** sends the continuation immediately.

The host preserves the queue across restarts. It waits for any surviving agent process before it starts another task in that workspace. Unsent drafts remain unsent.

## Recover a stopped task

A failed turn can leave source changes on disk. The failed response shows the cause and a recovery action in the transcript. Progress and provider diagnostics remain separate from the final answer.

Select **Retry** on the failed response to continue from the saved work. This action starts the request without a second send step. **View local changes** remains available to inspect the files.

The recovery action sends one continuation immediately. If the workspace is busy, WTS queues it. The action preserves unrelated draft text and the failed request's original target. Repeated clicks reuse the same request identity. The agent must check the current files before it continues. Earlier failed turns keep their original status.

Older records do not distinguish progress from a final answer. WTS keeps their failed output collapsed and marks it as unverified. A saved summary alone does not prove that the agent completed its tests.

Conversation tasks have a 60-minute execution limit. Other agent workflows keep their existing limits. **Stop current task** remains available during execution.

## WTS development

UI feedback uses a WTS source repository that the host configures. A renderer request cannot choose a source directory or preview URL. WTS reuses a workspace that contains that source. If no workspace matches, WTS can create a development workspace from a clean source checkout.

A Vite development session applies supported UI source changes through live reload. Native Rust changes still require a build and an app restart. Durable conversations let the user continue after that restart. A new checkout needs its own development server before it can show a live preview.

The desktop development build selects its source checkout automatically. Other hosts use `WTS_UI_REPOSITORY_ROOT` to select the source checkout.

Agent execution supports macOS and Linux. Windows supports saved chat access but does not yet support conversation agent execution. Native image capture supports macOS. Codex receives the PNG as an image attachment. Other providers receive its local file path with the context.

## Validation

The automated tests cover selection, text privacy, image crop bounds, request transport, exact workspace routing, full agent output, retries, and persistence. The default process tests use temporary repositories and test executables. They do not contact a live provider. They cover inherited process pipes, output limits, final answers, and failure recovery.

Run the checks from the repository root:

```bash
npm --prefix ui test -- --maxWorkers=2
npm --prefix ui run build
cargo test -p wts-app -p wts-server -p wts-desktop --lib
cargo test -p wts-app --test agent_conversations --test agent_conversation_gitlab --test agent_conversation_queue --test agent_conversation_output -- --test-threads=1
```

Run the feedback browser tests from `ui/`:

```bash
npx playwright test --config playwright.feedback.config.ts
```

These tests load the real feedback component and HTTP client with an isolated test server. They cover immediate retries, duplicate clicks, reload recovery, queue changes, and scrolling. They do not send saved user requests to an agent.

For an optional native check, start WTS in development mode and select a region with Option. Open the context label above the composer and inspect the captured image. Do not send the request unless you want the agent to change that source.

The optional provider test starts your installed Codex with your current account and model. It creates a temporary workspace and changes a test file. It checks the full final answer and preserves an existing draft. It does not use your WTS source workspace.

```bash
WTS_RUN_REAL_CODEX_SMOKE=1 WTS_REAL_CODEX_EXECUTABLE="$(command -v codex)" \
  cargo test -p wts-app --test agent_conversation_real_codex -- --ignored --nocapture
```
