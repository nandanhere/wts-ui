package main

import (
	"bytes"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/spf13/cobra/doc"

	"github.com/xrehpicx/wts/internal/cli"
)

func main() {
	manDir := flag.String("man-dir", filepath.Join("docs", "man"), "output directory for man pages")
	mdDir := flag.String("md-dir", filepath.Join("docs", "cli"), "output directory for markdown command docs")
	version := flag.String("version", "dev", "version string to embed in docs")
	flag.Parse()

	root := cli.NewRootCmd(*version, "dev")
	root.DisableAutoGenTag = true

	if err := os.MkdirAll(*manDir, 0o755); err != nil {
		panic(fmt.Errorf("create man dir: %w", err))
	}
	if err := os.MkdirAll(*mdDir, 0o755); err != nil {
		panic(fmt.Errorf("create markdown dir: %w", err))
	}

	header := &doc.GenManHeader{
		Title:   "WORKSWITCH",
		Section: "1",
		Source:  "workswitch",
		Manual:  "workswitch Manual",
	}

	if err := doc.GenManTree(root, header, *manDir); err != nil {
		panic(fmt.Errorf("generate man pages: %w", err))
	}
	if err := doc.GenMarkdownTree(root, *mdDir); err != nil {
		panic(fmt.Errorf("generate markdown docs: %w", err))
	}
	if err := normalizeGeneratedFiles(*manDir); err != nil {
		panic(fmt.Errorf("normalize man pages: %w", err))
	}
	if err := normalizeGeneratedFiles(*mdDir); err != nil {
		panic(fmt.Errorf("normalize markdown docs: %w", err))
	}
}

func normalizeGeneratedFiles(root string) error {
	return filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		contents, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		trimmed := bytes.TrimRight(contents, "\r\n")
		normalized := make([]byte, len(trimmed)+1)
		copy(normalized, trimmed)
		normalized[len(trimmed)] = '\n'
		if bytes.Equal(contents, normalized) {
			return nil
		}
		return os.WriteFile(path, normalized, info.Mode().Perm())
	})
}
