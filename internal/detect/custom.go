package detect

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"go.yaml.in/yaml/v3"
)

var customNamePattern = regexp.MustCompile(`^[a-zA-Z0-9._-]+$`)

// customDetectorSpec is the on-disk YAML format for user-defined detectors
// stored in <configDir>/detectors/*.yaml.
//
// Example:
//
//	name: rust
//	description: Rust projects with Cargo
//	match:
//	  files:
//	    - Cargo.toml
//	processes:
//	  - name: run
//	    command: cargo run
//	  - name: test
//	    command: cargo watch -x test
type customDetectorSpec struct {
	Name        string `yaml:"name"`
	Description string `yaml:"description,omitempty"`
	Match       struct {
		Files []string `yaml:"files"`
	} `yaml:"match"`
	Processes []struct {
		Name    string `yaml:"name"`
		Command string `yaml:"command"`
	} `yaml:"processes"`
}

// CustomDetector is a Detector backed by a YAML spec file.
type CustomDetector struct {
	spec customDetectorSpec
}

func (d *CustomDetector) Name() string { return d.spec.Name }

func (d *CustomDetector) Detect(dir string) (*Result, error) {
	for _, f := range d.spec.Match.Files {
		info, err := os.Stat(filepath.Join(dir, f))
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return nil, nil
			}
			return nil, fmt.Errorf("check match file %q: %w", f, err)
		}
		if info.IsDir() {
			return nil, nil
		}
	}

	procs := make([]Process, 0, len(d.spec.Processes))
	for _, p := range d.spec.Processes {
		procs = append(procs, Process{Name: p.Name, Command: p.Command})
	}
	if len(procs) == 0 {
		return nil, nil
	}
	return &Result{Type: d.spec.Name, Processes: procs}, nil
}

// LoadCustomDetectors reads every .yaml / .yml file under dir/detectors/ and
// returns them as Detector instances. Invalid specifications are reported with
// their filename so users can repair a detector instead of silently missing it.
func LoadCustomDetectors(configDir string) ([]Detector, error) {
	dir := filepath.Join(configDir, "detectors")
	entries, err := os.ReadDir(dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("read detector directory: %w", err)
	}

	var detectors []Detector
	seenNames := make(map[string]string)
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		ext := strings.ToLower(filepath.Ext(e.Name()))
		if ext != ".yaml" && ext != ".yml" {
			continue
		}

		data, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			return nil, fmt.Errorf("read detector %s: %w", e.Name(), err)
		}
		var spec customDetectorSpec
		decoder := yaml.NewDecoder(bytes.NewReader(data))
		decoder.KnownFields(true)
		if err := decoder.Decode(&spec); err != nil {
			return nil, fmt.Errorf("parse detector %s: %w", e.Name(), err)
		}
		var extra any
		if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
			if err != nil {
				return nil, fmt.Errorf("parse detector %s: %w", e.Name(), err)
			}
			return nil, fmt.Errorf("parse detector %s: expected one YAML document", e.Name())
		}
		if err := normalizeCustomDetector(&spec); err != nil {
			return nil, fmt.Errorf("invalid detector %s: %w", e.Name(), err)
		}
		if previous, exists := seenNames[spec.Name]; exists {
			return nil, fmt.Errorf("duplicate detector name %q in %s and %s", spec.Name, previous, e.Name())
		}
		seenNames[spec.Name] = e.Name()
		detectors = append(detectors, &CustomDetector{spec: spec})
	}
	return detectors, nil
}

func normalizeCustomDetector(spec *customDetectorSpec) error {
	spec.Name = strings.TrimSpace(spec.Name)
	if spec.Name == "" {
		return fmt.Errorf("name is required")
	}
	if !customNamePattern.MatchString(spec.Name) {
		return fmt.Errorf("name %q is invalid", spec.Name)
	}
	if len(spec.Match.Files) == 0 {
		return fmt.Errorf("match.files must contain at least one path")
	}
	seenFiles := make(map[string]struct{}, len(spec.Match.Files))
	for i, file := range spec.Match.Files {
		file = filepath.Clean(strings.TrimSpace(file))
		if file == "." || !filepath.IsLocal(file) {
			return fmt.Errorf("match.files[%d] must be a relative path inside the project", i)
		}
		if _, exists := seenFiles[file]; exists {
			return fmt.Errorf("match.files[%d] duplicates %q", i, file)
		}
		seenFiles[file] = struct{}{}
		spec.Match.Files[i] = file
	}
	if len(spec.Processes) == 0 {
		return fmt.Errorf("processes must contain at least one process")
	}
	seenProcesses := make(map[string]struct{}, len(spec.Processes))
	for i := range spec.Processes {
		process := &spec.Processes[i]
		process.Name = strings.TrimSpace(process.Name)
		process.Command = strings.TrimSpace(process.Command)
		if process.Name == "" || !customNamePattern.MatchString(process.Name) {
			return fmt.Errorf("processes[%d].name %q is invalid", i, process.Name)
		}
		if process.Command == "" {
			return fmt.Errorf("processes[%d].command is required", i)
		}
		if _, exists := seenProcesses[process.Name]; exists {
			return fmt.Errorf("processes[%d] duplicates process %q", i, process.Name)
		}
		seenProcesses[process.Name] = struct{}{}
	}
	return nil
}

// ConfigDir returns the default config directory path for wts
// (~/.config/wts on Unix).
func ConfigDir() string {
	if xdg := os.Getenv("XDG_CONFIG_HOME"); xdg != "" {
		return filepath.Join(xdg, "wts")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".config", "wts")
}
