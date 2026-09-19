import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { RuntimeAnalysisResult } from "../../lib/wtsClient";
import { fakeWorkspaceClient, runtimeAnalysisFixture, workspaceListFixture } from "../../test/workspaceClientFake";
import { LocalWorkspace } from "./LocalWorkspace";
import { deferred } from "./localWorkspaceTestHelpers";

async function openServices(fake: ReturnType<typeof fakeWorkspaceClient>) {
  const user = userEvent.setup();
  render(<LocalWorkspace client={fake.client} initialCreateOpen />);
  const dialog = await screen.findByRole("dialog", { name: "New workspace" });
  await user.type(within(dialog).getByRole("textbox", { name: /Jira issue key or URL/ }), "POLISH-42");
  await user.type(within(dialog).getByRole("textbox", { name: "Repositories for this plan" }), "checkout-api");
  await user.click(within(dialog).getByRole("button", { name: "Review repositories" }));
  await user.click(within(dialog).getByRole("button", { name: "Analyze services" }));
  return { dialog, user };
}

describe("workspace service setup clarity", () => {
  it("does not claim services were found before analysis returns", async () => {
    const pending = deferred<RuntimeAnalysisResult>();
    const fake = fakeWorkspaceClient({ list: workspaceListFixture() });
    fake.analyzeWorkspaceRuntime.mockReturnValue(pending.promise);
    const { dialog } = await openServices(fake);
    expect(within(dialog).queryByText(/WTS found runnable services/)).not.toBeInTheDocument();
    expect(within(dialog).getByRole("status")).toHaveTextContent("WTS checks");
    expect(within(dialog).queryByRole("group", { name: "Service selection summary" })).not.toBeInTheDocument();
    await act(async () => { pending.resolve(runtimeAnalysisFixture()); });
  });

  it("gives an empty analysis one clear next step and retains its details", async () => {
    const fake = fakeWorkspaceClient({ list: workspaceListFixture(), runtimeAnalysis: runtimeAnalysisFixture({
      warnings: ["No runnable services were inferred from the selected commits."],
      graph: { status: "ready", detail: "Checked two files at the selected commit." },
    }) });
    const { dialog, user } = await openServices(fake);
    expect(await within(dialog).findByRole("heading", { name: "No services to configure" })).toBeVisible();
    expect(within(dialog).queryByText(/WTS found runnable services/)).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("group", { name: "Service selection summary" })).not.toBeInTheDocument();
    expect(within(dialog).queryByText("No runnable services were inferred from the selected commits.")).not.toBeInTheDocument();
    await user.click(within(dialog).getByText("Analysis details", { exact: true }));
    expect(within(dialog).getByText("Checked two files at the selected commit.")).toBeVisible();
    const next = within(dialog).getByRole("button", { name: "Review plan" });
    expect(next).toBeEnabled();
    await user.click(next);
    expect(within(dialog).getByText("This workspace will not start any runtime services.")).toBeVisible();
  });

  it("counts preferred ports only for the selected services", async () => {
    const analysis = runtimeAnalysisFixture({ services: [{
      candidateId: "candidate_checkout", serviceId: "checkout-api", displayName: "Checkout API", repositoryId: "repo_checkout",
      repositoryLabel: "checkout-api", commitOid: "a".repeat(40), workingDirectory: ".", command: ["npm", "start"],
      dependencies: [], confidence: "declared", evidence: [], includedByDefault: true,
      ports: [{ portId: "http", preferredPort: 4100, policy: "prefer", confidence: "declared", evidence: [] }],
    }] });
    const { dialog, user } = await openServices(fakeWorkspaceClient({ list: workspaceListFixture(), runtimeAnalysis: analysis }));
    const portLabel = await within(dialog).findByText(/^(preferred ports|ports to reserve)$/);
    const portCount = portLabel.parentElement!.querySelector("b")!;
    expect(portCount).toHaveTextContent(/^1$/);
    await user.click(within(dialog).getByRole("checkbox", { name: "Include Checkout API in runtime plan" }));
    expect(portCount).toHaveTextContent(/^0$/);
    expect(within(dialog).getByRole("button", { name: "Review plan" })).toBeEnabled();
  });
});
