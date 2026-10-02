import { CHECKOUT, expect, mountProduct, saveEvidence, screenshot, test, type CodeReviewFixture } from "./fixtures/productPolish";

const oid = (letter: string) => letter.repeat(40);

function reviewFixture(): CodeReviewFixture {
  return {
    runs: [],
    posted: [],
    review: (request) => ({
      schemaVersion: 2, workspaceId: CHECKOUT, provider: "codex", scope: "recentChanges", mode: "raptik",
      skill: { id: String(request.skill), label: "Raptik rules", reviewer: "Pratik" }, outcome: "reviewed",
      summary: "One issue and one question. No Blocking items.",
      findings: [
        { findingId: "f-1", severity: "warning", label: "issue", repositoryId: "repo_checkout", filePath: "src/capture.ts", line: 2, side: "additions", anchored: true,
          title: "Retry can capture twice", explanation: "Two requests with one key can pass the check together.", suggestedComment: "Issue: hold a lock for the key during the capture.",
          precedent: { body: "Lock the idempotency key before the write.", url: "https://gitlab.example.test/payments/checkout-api/-/merge_requests/4#note_9", score: 6 } },
        { findingId: "q-1", severity: "suggestion", label: "question", repositoryId: "repo_checkout", filePath: "src/idempotency.ts", line: 2, side: "additions", anchored: true,
          title: "Does getOrCreate expire keys?", explanation: "The cache has no visible expiry.", suggestedComment: "Question: when does getOrCreate drop an old key?" },
      ],
      actionableSteps: [],
      repositories: [{ repositoryId: "repo_checkout", repositoryLabel: "checkout-api", baseCommitOid: oid("a"), headCommitOid: oid("b"), patchSha256: "sha256:mr", changedLines: 6, sizeGateExceeded: false, strictness: "normal",
        mergeRequest: { iid: 16, baseCommitOid: oid("a"), startCommitOid: oid("a"), headCommitOid: oid("b") } }],
      reviewedAtUnixMs: Date.now(),
    }),
  };
}

test("MR workspace: compact header, one review bar, and an AI review that posts to GitLab", async ({ page, productOrigin }, testInfo) => {
  const codeReview = reviewFixture();
  const fixture = await mountProduct(page, productOrigin, { theme: "dark", path: `/sessions/${CHECKOUT}`, codeReview });
  try {
    await page.getByRole("tab", { name: /^Changes/ }).click();
    await expect(page.getByRole("combobox", { name: "Code comparison" })).toBeVisible();

    // The MR identity lives in the workspace header, and one bar holds views, AI review, and unread links.
    const identity = page.locator('[data-ui="workspace.identity"]');
    await expect(identity.getByRole("heading", { name: "Preserve one capture for each retry key" })).toBeVisible();
    await expect(identity.getByText("payments/checkout-api !16")).toBeVisible();
    const reviewScreen = page.getByTestId("repository-review-screen");
    await expect(reviewScreen.getByTestId("repository-review-toolbar")).toHaveCount(0);
    const bar = page.locator('[data-ui="repository-review.views"]');
    const barBox = (await bar.boundingBox())!;
    const headerBox = (await page.locator('[data-ui="workspace.header"]').boundingBox())!;
    expect(barBox.height, "The review bar is one compact row.").toBeLessThanOrEqual(44);
    expect(barBox.y - (headerBox.y + headerBox.height), "No review toolbar sits between the header and the bar.").toBeLessThanOrEqual(2);
    await expect(bar.getByRole("navigation", { name: "Unread MR comments" })).toBeVisible();
    await screenshot(page, testInfo, "01-mr-code");

    await bar.getByRole("button", { name: "AI review" }).click();
    const card = page.getByRole("region", { name: "AI code review" });
    await expect(card.getByRole("combobox", { name: "Code review skill" })).toContainText("Raptik rules");
    await expect(card.getByRole("combobox", { name: "Code review model" })).toHaveText(/Default · gpt-5\.5/);
    await card.getByRole("button", { name: "Review code" }).click();
    await expect.poll(() => codeReview.runs.length).toBe(1);
    expect(codeReview.runs[0]).toMatchObject({ provider: "codex", scope: "recentChanges", repositoryId: "repo_checkout", mergeRequestIid: 16, skill: "raptik-review" });

    // Questions show in their own section. The findings show on the lines of the published MR.
    const questions = card.getByRole("list", { name: "Agent questions" });
    await expect(questions.getByText("Does getOrCreate expire keys?")).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Code comparison" })).toContainText("Published MR");
    const annotation = page.getByRole("note", { name: "AI review: Issue, Retry can capture twice" });
    await expect(annotation).toBeVisible();
    await expect(annotation.getByText("Pratik said this before")).toBeVisible();
    await screenshot(page, testInfo, "02-mr-ai-review");

    await annotation.getByRole("button", { name: "Post to GitLab on line 2" }).click();
    await expect(annotation.getByRole("button", { name: "Posted to GitLab" })).toBeDisabled();
    expect(codeReview.posted).toEqual([{ path: "/api/v1/reviews/gitlab/repo_checkout/16/comments", body: {
      body: "Issue: hold a lock for the key during the capture.", filePath: "src/capture.ts", side: "additions", line: 2, workspaceId: CHECKOUT,
      expectedPosition: { baseCommitOid: oid("a"), startCommitOid: oid("a"), headCommitOid: oid("b") },
    } }]);

    // Conversations explain how the threads work.
    await bar.getByRole("tab", { name: /^Conversations/ }).click();
    await expect(page.locator('[data-ui="gitlab-conversations.help"]')).toBeVisible();
    await screenshot(page, testInfo, "03-mr-conversations");
    expect(fixture.unexpected).toEqual([]);
    expect(fixture.errors).toEqual([]);
  } finally {
    await saveEvidence(page, testInfo, fixture);
  }
});
