package detect

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
)

// NodeDetector recognizes Node.js / TypeScript projects by the presence of a
// package.json and extracts npm scripts as processes.
type NodeDetector struct{}

func (d *NodeDetector) Name() string { return "nodejs" }

func (d *NodeDetector) Detect(dir string) (*Result, error) {
	pkgPath := filepath.Join(dir, "package.json")
	data, err := os.ReadFile(pkgPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read package.json: %w", err)
	}

	var pkg struct {
		Scripts map[string]string `json:"scripts"`
	}
	if err := json.Unmarshal(data, &pkg); err != nil {
		return nil, err
	}
	if len(pkg.Scripts) == 0 {
		return nil, nil
	}

	runner, err := npmRunner(dir)
	if err != nil {
		return nil, err
	}

	names := make([]string, 0, len(pkg.Scripts))
	for name := range pkg.Scripts {
		names = append(names, name)
	}
	sort.Strings(names)

	procs := make([]Process, 0, len(names))
	for _, name := range names {
		procs = append(procs, Process{
			Name:    name,
			Command: runner + " run " + quoteShellArgument(name),
		})
	}
	return &Result{Type: "nodejs", Processes: procs}, nil
}

// npmRunner returns "pnpm", "yarn", or "npm" based on lock file presence.
func npmRunner(dir string) (string, error) {
	for _, pair := range []struct {
		lock   string
		runner string
	}{
		{"pnpm-lock.yaml", "pnpm"},
		{"yarn.lock", "yarn"},
		{"bun.lock", "bun"},
		{"bun.lockb", "bun"},
	} {
		exists, err := regularFileExists(filepath.Join(dir, pair.lock))
		if err != nil {
			return "", fmt.Errorf("check %s: %w", pair.lock, err)
		}
		if exists {
			return pair.runner, nil
		}
	}
	return "npm", nil
}
