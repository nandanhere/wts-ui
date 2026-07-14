package detect

import (
	"fmt"
	"os"
	"path/filepath"
)

// GoDetector recognizes Go projects by go.mod and infers processes from cmd/
// sub-directories.
type GoDetector struct{}

func (d *GoDetector) Name() string { return "go" }

func (d *GoDetector) Detect(dir string) (*Result, error) {
	exists, err := regularFileExists(filepath.Join(dir, "go.mod"))
	if err != nil {
		return nil, fmt.Errorf("check go.mod: %w", err)
	}
	if !exists {
		return nil, nil
	}

	var procs []Process
	cmdDir := filepath.Join(dir, "cmd")
	entries, err := os.ReadDir(cmdDir)
	if err != nil && !os.IsNotExist(err) {
		return nil, fmt.Errorf("read cmd directory: %w", err)
	}
	if err == nil {
		for _, e := range entries {
			if e.IsDir() {
				procs = append(procs, Process{
					Name:    e.Name(),
					Command: "go run " + quoteShellArgument("./cmd/"+e.Name()),
				})
			}
		}
	}

	if len(procs) == 0 {
		procs = append(procs, Process{
			Name:    "run",
			Command: "go run .",
		})
	}

	return &Result{Type: "go", Processes: procs}, nil
}
