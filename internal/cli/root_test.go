package cli

import (
	"context"
	"strings"
	"testing"

	"github.com/xrehpicx/wts/internal/gitwt"
)

func TestRunOptionsFromFlagsRejectsMixedProcessAndGroup(t *testing.T) {
	t.Parallel()

	if _, err := runOptionsFromFlags("api", "dev", false); err == nil {
		t.Fatal("expected error when both process and group are set")
	}
}

func TestValidateStopSelectionRequiresWorktreeForTarget(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name    string
		process string
		group   string
	}{
		{name: "process", process: "api"},
		{name: "group", group: "dev"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			err := validateStopSelection(false, tc.process, tc.group, nil)
			if err == nil || !strings.Contains(err.Error(), "worktree") {
				t.Fatalf("expected worktree requirement error, got %v", err)
			}
		})
	}
}

func TestNextWorktreeIndexStartsAtEdgeWhenNothingIsActive(t *testing.T) {
	t.Parallel()

	items := []gitwt.Worktree{{Dir: "/tmp/a"}, {Dir: "/tmp/b"}, {Dir: "/tmp/c"}}
	if got := nextWorktreeIndex(items, "", 1); got != 0 {
		t.Fatalf("next index with no active worktree = %d; want 0", got)
	}
	if got := nextWorktreeIndex(items, "", -1); got != 2 {
		t.Fatalf("previous index with no active worktree = %d; want 2", got)
	}
}

func TestRootCommandRunsTUIByDefault(t *testing.T) {
	t.Parallel()

	called := false
	a := &app{
		runTUI: func(context.Context) error {
			called = true
			return nil
		},
	}

	cmd := a.newRootCmd()
	cmd.SetArgs(nil)

	if err := cmd.Execute(); err != nil {
		t.Fatalf("execute root command: %v", err)
	}
	if !called {
		t.Fatal("expected bare root command to launch TUI")
	}
}
