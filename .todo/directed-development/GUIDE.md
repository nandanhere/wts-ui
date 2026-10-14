# Work through WTS

## Send feedback

1. Hold Option and select a WTS region. Describe the required change in the feedback bubble.
2. Send the request. Add more requests while the agent runs. WTS keeps them in the same conversation and queue.
3. Open **Review changes** for a finished request. This view shows that task's recorded file changes.
4. Use **Return to selection** to return to the selected region or review thread.

An agent reply describes its work. The recorded patch shows the file changes that WTS observed. Open **Host checks** to inspect or run saved verification commands against that result.

## Prepare tasks or alternatives

1. Open **Tasks and alternatives** in a recorded result.
2. Select **Dependent tasks** or **Alternatives**. Add a title and request for each task.
3. For dependent tasks, select the required earlier tasks. WTS starts a task only after its prerequisites complete.
4. Select **Start tasks** or **Start alternatives**. Each task uses an isolated workspace. The original files remain available while tasks run.
5. Select **Read task result** to inspect a candidate's recorded patch and host checks.

A plan supports up to eight tasks. Up to three tasks can run or prepare at once across all plans. A failed prerequisite blocks its dependent tasks. Independent tasks can continue.

Each task receives the exact originating request and reply, its selected UI or MR context, and the results of its prerequisites. Later parent messages are excluded from the origin artifact.

Cancellation applies to one task. To submit a failed plan again, use **Use this plan again**, inspect the requests, and start the new plan. WTS assigns new request identities.

## Inspect a live preview

Select **Open live preview** for a completed WTS UI candidate. WTS opens a separate window that uses the candidate's files. The window can read WTS data. Use the main window for changes to workspaces, tasks, or provider threads.

Two preview processes can run at once. Close a preview window to release its process. Supported UI changes use Vite updates. Native Rust changes require a rebuilt executable and a restart.

WTS can reuse installed UI dependencies when the source and candidate package files match. It checks shared dependencies again on restart. Each preview has a separate Vite cache. If dependencies differ or are missing, open the task workspace, install its dependencies, and retry.

The dedicated candidate preview requires the desktop app. An HTTP client can still inspect the candidate patch and open its workspace.

## Apply a candidate

1. Open the candidate's **Host checks** and run the saved checks. Use **Open candidate verification** if the workspace has no saved checks.
2. Open **Integrate candidate**. Inspect the listed files and any blockers.
3. Keep other editors and Git tools idle during the operation.
4. Select **Apply files** when matching checks pass and the original source state matches the captured input. The button includes the file count.

Applying a candidate changes local working files. It does not create a commit or publish changes. WTS retains the alternative workspaces and their evidence.

If the response is lost, refresh the file effects or retry the saved request. WTS uses the same request identity. An interrupted operation shows the confirmed file effects. **Continue integration** resumes that operation when its recorded state still matches.

## Retain a decision or restore a result

Open **Decision**, select a choice, add an optional reason, and select **Save decision**. The record includes the source identity and the available host check results. A saved decision does not apply files.

Open **Restore task changes** to inspect the proposed reversal of a task. WTS checks the current files before it writes. If files conflict, inspect the listed paths. Do not discard later work to force a restore.

## Validation boundaries

Automated browser checks use controlled HTTP responses. Separate process tests exercise Git files, the agent queue, verification commands, application recovery, and live preview servers. A real provider trial checks the queue with three dependent changes in a temporary repository.

The native automation connection was unavailable during this work. The optional native check is to open a candidate preview, read a plan document, close and reopen the preview, and confirm that write controls direct the user to the main window.
