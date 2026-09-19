import { describe, expect, it } from "vitest";
import type { WorkspacePlanningDocumentDescriptor } from "../../lib/wtsClient";
import { planningDocumentDisplayPath, resolvePlanningDocumentLink } from "./planningDocumentPaths";

const documents: WorkspacePlanningDocumentDescriptor[] = [
  { documentId: "readme", fileName: "README.md" },
  { documentId: "plan", fileName: "PLAN.md" },
  { documentId: `generated-${"a".repeat(64)}`, fileName: "epics/checkout/PLAN.md" },
  { documentId: `generated-${"b".repeat(64)}`, fileName: "epics/checkout/tasks/README.md" },
  { documentId: `generated-${"c".repeat(64)}`, fileName: "epics/payments/PLAN.md" },
  { documentId: `generated-${"d".repeat(64)}`, fileName: "epics/checkout/Notes and résumé.md" },
  { documentId: `generated-${"e".repeat(64)}`, fileName: "evidence.csv" },
];
const current = documents[2]!;

describe("planning document display paths", () => {
  it("preserves parent folders so duplicate basenames remain distinct", () => {
    expect(planningDocumentDisplayPath(current.fileName)).toBe("epics/checkout/PLAN.md");
    expect(planningDocumentDisplayPath(documents[4]!.fileName)).toBe("epics/payments/PLAN.md");
  });
  it("normalizes local dot segments without discarding folder names", () => {
    expect(planningDocumentDisplayPath("./epics//checkout/tasks/../PLAN.md")).toBe("epics/checkout/PLAN.md");
  });
  it.each(["/fixture/plans/PLAN.md", "C:\\fixture\\plans\\PLAN.md", "\\\\server\\plans\\PLAN.md"])("shows only the basename for legacy absolute path %s", fileName => {
    expect(planningDocumentDisplayPath(fileName)).toBe("PLAN.md");
  });
  it("has a readable fallback for an empty file name", () => {
    expect(planningDocumentDisplayPath("")).toBe("Planning file");
  });
});

describe("known planning document links", () => {
  it.each([
    ["./tasks/README.md", 3], ["../payments/PLAN.md", 4], ["../../README.md", 0],
    ["./PLAN.md", 2], ["../../evidence.csv", 6], ["tasks/../PLAN.md", 2],
  ] as const)("resolves %s against the current directory to its existing opaque ID", (href, index) => {
    expect(resolvePlanningDocumentLink(documents, current, href)).toEqual({ documentId: documents[index]!.documentId });
  });
  it("decodes spaces and Unicode once and retains a file link fragment", () => {
    expect(resolvePlanningDocumentLink(documents, current, "Notes%20and%20r%C3%A9sum%C3%A9.md#next-step")).toEqual({ documentId: documents[5]!.documentId, hash: "#next-step" });
  });
  it("uses the selected list descriptor and exact filename case for legacy fixtures", () => {
    const legacy: WorkspacePlanningDocumentDescriptor[] = [{ documentId: "plan", fileName: "/fixture/PLAN.md" }, { documentId: "readme", fileName: "/fixture/README.md" }];
    expect(resolvePlanningDocumentLink(legacy, legacy[0]!, "./README.md")).toEqual({ documentId: "readme" });
    expect(resolvePlanningDocumentLink(legacy, legacy[0]!, "readme.md")).toBeUndefined();
  });
  it("does not guess when two descriptors have the same normalized path", () => {
    const ambiguous = [...documents, { documentId: "findings" as const, fileName: "./epics/checkout/PLAN.md" }];
    expect(resolvePlanningDocumentLink(ambiguous, current, "PLAN.md")).toBeUndefined();
    const legacy = [{ documentId: "plan" as const, fileName: "/one/PLAN.md" }, { documentId: "findings" as const, fileName: "/two/PLAN.md" }];
    expect(resolvePlanningDocumentLink(legacy, legacy[0]!, "PLAN.md")).toBeUndefined();
  });
  it("requires the current descriptor to belong to this document list", () => {
    expect(resolvePlanningDocumentLink(documents, { ...current, documentId: "findings" }, "../../PLAN.md")).toBeUndefined();
  });
  it.each([
    "../../../PLAN.md", "../../../../epics/checkout/PLAN.md", "/PLAN.md", "//host/PLAN.md",
    "https://example.test/PLAN.md", "javascript:alert(1)", "data:text/html,hello", "file:///PLAN.md", "C:/PLAN.md",
    "..\\PLAN.md", "tasks%2fREADME.md", "tasks%5cREADME.md", "%2e%2e/payments/PLAN.md", ".%2E/payments/PLAN.md",
    "%252e%252e/payments/PLAN.md", "%68ttps%3Aexample.test/PLAN.md", "PLAN.md%00", "PLAN.md\u0000", "PLAN.md\n",
    "Notes%ZZ.md", "PLAN.md?download=1", "missing.md", "#next-step", "", "PLAN.md#%00", "PLAN.md#bad\\fragment",
  ])("rejects the unsupported or escaping link %s", href => {
    expect(resolvePlanningDocumentLink(documents, current, href)).toBeUndefined();
  });
  it("does not turn an unsafe descriptor path into a root-level link target", () => {
    const unsafe = [...documents, { documentId: "findings" as const, fileName: "../outside.md" }, { documentId: "kanban" as const, fileName: "folder\\board.md" }];
    expect(resolvePlanningDocumentLink(unsafe, documents[0]!, "outside.md")).toBeUndefined();
    expect(resolvePlanningDocumentLink(unsafe, documents[0]!, "board.md")).toBeUndefined();
  });
});
