package detect

import (
	"bufio"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var makeTargetRe = regexp.MustCompile(`^([a-zA-Z0-9._-]+)\s*:`)

// Targets that are almost always infrastructure, not user-runnable processes.
var makeSkipTargets = map[string]bool{
	"all": true, "clean": true, "install": true, "uninstall": true,
	"dist": true, "distclean": true, "check": true, "help": true,
	".PHONY": true, ".DEFAULT": true,
}

// MakefileDetector recognizes projects with a Makefile and extracts targets as
// processes. This is a low-priority fallback detector.
type MakefileDetector struct{}

func (d *MakefileDetector) Name() string { return "makefile" }

func (d *MakefileDetector) Detect(dir string) (*Result, error) {
	for _, name := range []string{"Makefile", "makefile", "GNUmakefile"} {
		procs, err := parseMakefile(filepath.Join(dir, name))
		if err != nil {
			return nil, err
		}
		if len(procs) > 0 {
			return &Result{Type: "makefile", Processes: procs}, nil
		}
	}
	return nil, nil
}

func parseMakefile(path string) ([]Process, error) {
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	defer func() { _ = f.Close() }()

	var procs []Process
	seenTargets := make(map[string]struct{})
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "\t") || strings.HasPrefix(line, "#") {
			continue
		}
		matches := makeTargetRe.FindStringSubmatch(line)
		if len(matches) < 2 {
			continue
		}
		target := matches[1]
		if makeSkipTargets[target] || strings.HasPrefix(target, ".") {
			continue
		}
		if _, exists := seenTargets[target]; exists {
			continue
		}
		seenTargets[target] = struct{}{}
		procs = append(procs, Process{
			Name:    target,
			Command: "make " + target,
		})
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return procs, nil
}
