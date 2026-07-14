package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestNormalizeGeneratedFiles(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	path := filepath.Join(dir, "command.md")
	if err := os.WriteFile(path, []byte("generated\n\n\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	carriagePath := filepath.Join(dir, "carriage.md")
	if err := os.WriteFile(carriagePath, []byte("generated\r"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := normalizeGeneratedFiles(dir); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "generated\n" {
		t.Fatalf("normalized contents = %q", got)
	}
	carriageContents, err := os.ReadFile(carriagePath)
	if err != nil {
		t.Fatal(err)
	}
	if string(carriageContents) != "generated\n" {
		t.Fatalf("carriage-return contents = %q", carriageContents)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != before.Mode().Perm() {
		t.Fatalf("normalized mode = %o; want original %o", info.Mode().Perm(), before.Mode().Perm())
	}
}

func TestNormalizeGeneratedFilesSkipsSymlinks(t *testing.T) {
	t.Parallel()

	targetDir := t.TempDir()
	target := filepath.Join(targetDir, "target.md")
	if err := os.WriteFile(target, []byte("leave unchanged\r"), 0o644); err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	if err := os.Symlink(target, filepath.Join(root, "linked.md")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if err := normalizeGeneratedFiles(root); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "leave unchanged\r" {
		t.Fatalf("symlink target was modified: %q", got)
	}
}
