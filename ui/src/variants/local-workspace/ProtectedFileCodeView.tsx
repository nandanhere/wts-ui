import { CodeView, type CodeViewReactOptions } from "@pierre/diffs/react";
import type { RemovalProtectedFilePreview } from "../../lib/wtsClient";
import { useTheme } from "../../theme";

export default function ProtectedFileCodeView({
  preview,
}: {
  preview: RemovalProtectedFilePreview;
}) {
  const { resolvedTheme } = useTheme();
  const options: CodeViewReactOptions = {
    disableFileHeader: true,
    enableLineSelection: true,
    layout: { paddingTop: 12, paddingBottom: 22, gap: 0 },
    lineHoverHighlight: "line",
    overflow: "scroll",
    stickyHeaders: false,
    themeType: resolvedTheme,
  };

  return (
    <CodeView
      items={[
        {
          id: preview.relativePath,
          type: "file",
          file: {
            name: preview.relativePath,
            contents: preview.contents,
          },
        },
      ]}
      options={options}
    />
  );
}
