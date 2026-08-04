package cli

import (
	"image/color"
	"strings"
	"time"

	"charm.land/bubbles/v2/help"
	"charm.land/bubbles/v2/key"
	"charm.land/bubbles/v2/spinner"
	"charm.land/bubbles/v2/textinput"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"

	"github.com/xrehpicx/wts/internal/config"
	"github.com/xrehpicx/wts/internal/gitwt"
	"github.com/xrehpicx/wts/internal/model"
	"github.com/xrehpicx/wts/internal/runtime"
)

type actionDoneMsg struct{ text string }
type actionErrMsg struct{ err error }
type attachReadyMsg struct{ spec runtime.AttachSpec }
type groupCreatedMsg struct {
	project *model.Project
	target  model.Target
}
type statusRefreshedMsg struct {
	rows      []runtime.StatusRow
	worktrees []gitwt.Worktree
	err       error
}
type logsMsg struct {
	dir           string
	linesByTarget map[string][]string
}
type tickLogsMsg struct{}

type tuiStyles struct {
	title       lipgloss.Style
	subtitle    lipgloss.Style
	statusOk    lipgloss.Style
	statusErr   lipgloss.Style
	statusBusy  lipgloss.Style
	panelTitle  lipgloss.Style
	panelBorder lipgloss.Style
	panelFocus  lipgloss.Style
	selectedRow lipgloss.Style
	row         lipgloss.Style
	colHeader   lipgloss.Style
	runDot      lipgloss.Style
	exitedDot   lipgloss.Style
	stopDot     lipgloss.Style
	activeMark  lipgloss.Style
	metaLabel   lipgloss.Style
	metaValue   lipgloss.Style
	separator   lipgloss.Style
	dimText     lipgloss.Style
	logText     lipgloss.Style
	footer      lipgloss.Style
	modalBorder lipgloss.Style
	modalFocus  lipgloss.Style
}

type createGroupFocus int

const (
	createGroupFocusName createGroupFocus = iota
	createGroupFocusMembers
)

type tuiModel struct {
	rc                  *runtimeContext
	idx                 int
	listOffset          int
	width               int
	height              int
	keys                tuiKeyMap
	help                help.Model
	showAll             bool
	message             string
	messageIsErr        bool
	rows                []runtime.StatusRow
	targets             []model.Target
	targetIdx           int
	styles              tuiStyles
	spinner             spinner.Model
	loading             bool
	loadingDir          string
	loadingMsg          string
	quitInfo            string
	attachSpec          *runtime.AttachSpec
	filterMode          bool
	filterInput         textinput.Model
	preFilterIdx        int
	logLines            map[string][]string
	logDir              string
	createGroupMode     bool
	createGroupInput    textinput.Model
	createGroupFocus    createGroupFocus
	createGroupCursor   int
	createGroupSelected map[string]bool
}

type tuiKeyMap struct {
	Next        key.Binding
	Prev        key.Binding
	Switch      key.Binding
	Restart     key.Binding
	Stop        key.Binding
	StopAll     key.Binding
	Attach      key.Binding
	ProcPrev    key.Binding
	ProcNext    key.Binding
	Filter      key.Binding
	CreateGroup key.Binding
	Help        key.Binding
	Quit        key.Binding
}

func newTUIKeyMap() tuiKeyMap {
	return tuiKeyMap{
		Next:        key.NewBinding(key.WithKeys("n", "j", "down"), key.WithHelp("j/↓", "next")),
		Prev:        key.NewBinding(key.WithKeys("p", "k", "up"), key.WithHelp("k/↑", "prev")),
		Switch:      key.NewBinding(key.WithKeys("s", "enter"), key.WithHelp("s/↵", "start/switch")),
		Restart:     key.NewBinding(key.WithKeys("r"), key.WithHelp("r", "restart target")),
		Stop:        key.NewBinding(key.WithKeys("x"), key.WithHelp("x", "stop target")),
		StopAll:     key.NewBinding(key.WithKeys("X"), key.WithHelp("X", "stop all")),
		Attach:      key.NewBinding(key.WithKeys("a"), key.WithHelp("a", "attach tmux")),
		ProcPrev:    key.NewBinding(key.WithKeys("h", "left", "["), key.WithHelp("h/←", "prev target")),
		ProcNext:    key.NewBinding(key.WithKeys("l", "right", "]"), key.WithHelp("l/→", "next target")),
		Filter:      key.NewBinding(key.WithKeys("/"), key.WithHelp("/", "search target")),
		CreateGroup: key.NewBinding(key.WithKeys("g"), key.WithHelp("g", "new group")),
		Help:        key.NewBinding(key.WithKeys("?"), key.WithHelp("?", "help")),
		Quit:        key.NewBinding(key.WithKeys("q", "ctrl+c"), key.WithHelp("q", "quit")),
	}
}

func (k tuiKeyMap) ShortHelp() []key.Binding {
	return []key.Binding{k.Next, k.Prev, k.ProcPrev, k.ProcNext, k.Switch, k.Stop, k.Help, k.Quit}
}

func (k tuiKeyMap) FullHelp() [][]key.Binding {
	return [][]key.Binding{
		{k.Next, k.Prev, k.Switch, k.Restart, k.Stop, k.StopAll, k.Attach},
		{k.ProcPrev, k.ProcNext, k.Filter, k.CreateGroup, k.Help, k.Quit},
	}
}

func newTUIStyles(isDark bool) tuiStyles {
	lightDark := lipgloss.LightDark(isDark)
	ac := func(light, dark string) color.Color {
		return lightDark(lipgloss.Color(light), lipgloss.Color(dark))
	}
	return tuiStyles{
		title: lipgloss.NewStyle().
			Bold(true).
			Foreground(ac("#0B3954", "#D9ECFF")),
		subtitle: lipgloss.NewStyle().
			Foreground(ac("#4A5568", "#6B7F96")),
		statusOk: lipgloss.NewStyle().
			Foreground(ac("#166534", "#8FE3B2")),
		statusErr: lipgloss.NewStyle().
			Foreground(ac("#B91C1C", "#FF9C9C")).
			Bold(true),
		statusBusy: lipgloss.NewStyle().
			Foreground(ac("#92400E", "#FFD392")),
		panelTitle: lipgloss.NewStyle().
			Bold(true).
			Foreground(ac("#1D4E89", "#A9CAFF")),
		panelBorder: lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(ac("#B8C5D6", "#3A4E68")).
			Padding(0, 1),
		panelFocus: lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(ac("#5A84B5", "#7DB2FF")).
			Padding(0, 1),
		selectedRow: lipgloss.NewStyle().
			Foreground(ac("#0B2239", "#F4F9FF")).
			Background(ac("#D9EBFF", "#25384E")).
			Bold(true),
		row:       lipgloss.NewStyle().Foreground(ac("#1F2937", "#D0DBE8")),
		colHeader: lipgloss.NewStyle().Foreground(ac("#3E5C76", "#6B8AAE")).Bold(true),
		runDot:    lipgloss.NewStyle().Foreground(ac("#166534", "#8FE3B2")),
		exitedDot: lipgloss.NewStyle().Foreground(ac("#92400E", "#FFD392")),
		stopDot:   lipgloss.NewStyle().Foreground(ac("#6B7280", "#4B5C6E")),
		activeMark: lipgloss.NewStyle().
			Foreground(ac("#92400E", "#FFD392")).
			Bold(true),
		metaLabel: lipgloss.NewStyle().
			Foreground(ac("#46607A", "#6B8AAE")).
			Width(10),
		metaValue: lipgloss.NewStyle().
			Foreground(ac("#0F172A", "#E6EEF7")),
		separator: lipgloss.NewStyle().
			Foreground(ac("#D1D5DB", "#2D3F54")),
		dimText: lipgloss.NewStyle().
			Foreground(ac("#6B7280", "#4B5C6E")),
		logText: lipgloss.NewStyle().
			Foreground(ac("#374151", "#9CAABB")),
		footer: lipgloss.NewStyle().
			Foreground(ac("#4B5563", "#6B7F96")),
		modalBorder: lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(ac("#7A8FA8", "#55759A")).
			Padding(0, 1),
		modalFocus: lipgloss.NewStyle().
			Foreground(ac("#0B2239", "#F4F9FF")).
			Background(ac("#D9EBFF", "#25384E")).
			Bold(true),
	}
}

func (m *tuiModel) applyColorScheme(isDark bool) {
	m.styles = newTUIStyles(isDark)
	m.help.Styles = help.DefaultStyles(isDark)
	m.filterInput.SetStyles(textinput.DefaultStyles(isDark))
	m.createGroupInput.SetStyles(textinput.DefaultStyles(isDark))
	lightDark := lipgloss.LightDark(isDark)
	m.spinner.Style = lipgloss.NewStyle().Foreground(
		lightDark(lipgloss.Color("#92400E"), lipgloss.Color("#FFD392")),
	)
}

func newTUIModel(rc *runtimeContext) *tuiModel {
	helpModel := help.New()
	helpModel.ShowAll = false
	s := spinner.New()
	s.Spinner = spinner.Spinner{
		Frames: []string{"◒", "◐", "◓", "◑"},
		FPS:    80 * time.Millisecond,
	}

	ti := textinput.New()
	ti.Prompt = ""
	ti.CharLimit = 64

	createGroupInput := textinput.New()
	createGroupInput.Prompt = ""
	createGroupInput.CharLimit = 64

	m := &tuiModel{
		rc:                  rc,
		keys:                newTUIKeyMap(),
		help:                helpModel,
		styles:              newTUIStyles(true),
		spinner:             s,
		filterInput:         ti,
		targetIdx:           0,
		createGroupInput:    createGroupInput,
		createGroupSelected: map[string]bool{},
	}
	m.applyColorScheme(true)

	targets := rc.project.Targets()
	if activeTarget, ok := rc.manager.ActiveTarget(rc.context()); ok {
		reordered := make([]model.Target, 0, len(targets))
		reordered = append(reordered, activeTarget)
		for _, target := range targets {
			if !sameTarget(target, activeTarget) {
				reordered = append(reordered, target)
			}
		}
		m.targets = reordered
	} else {
		m.targets = targets
	}

	m.refreshStatus()
	if len(m.rows) > 0 {
		for i := range m.rows {
			if m.rows[i].Active {
				m.idx = i
				if activeTarget, ok := rc.manager.ActiveTarget(rc.context()); ok {
					m.selectTarget(activeTarget)
				}
				break
			}
		}
	}
	return m
}

func (m *tuiModel) Init() tea.Cmd {
	return tea.Batch(m.fetchLogsCmd(), m.scheduleLogRefresh(), tea.RequestBackgroundColor)
}

func (m *tuiModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.BackgroundColorMsg:
		m.applyColorScheme(msg.IsDark())
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
	case spinner.TickMsg:
		if m.loading {
			var cmd tea.Cmd
			m.spinner, cmd = m.spinner.Update(msg)
			return m, cmd
		}
	case actionDoneMsg:
		m.loading = false
		m.loadingDir = ""
		m.loadingMsg = ""
		m.message = msg.text
		m.messageIsErr = false
		return m, tea.Batch(m.refreshStatusCmd(), m.fetchLogsCmd())
	case actionErrMsg:
		m.loading = false
		m.loadingDir = ""
		m.loadingMsg = ""
		m.message = msg.err.Error()
		m.messageIsErr = true
	case attachReadyMsg:
		m.loading = false
		m.loadingDir = ""
		m.loadingMsg = ""
		m.attachSpec = &msg.spec
		m.quitInfo = ""
		return m, tea.Quit
	case groupCreatedMsg:
		m.loading = false
		m.loadingDir = ""
		m.loadingMsg = ""
		m.createGroupMode = false
		m.createGroupSelected = map[string]bool{}
		m.createGroupInput.Blur()
		m.rc.project = msg.project
		m.rc.manager = runtime.NewManager(msg.project, m.rc.repoRoot, m.rc.worktrees, m.rc.newBackend())
		m.targets = m.rc.project.Targets()
		m.selectTarget(msg.target)
		m.message = "created group " + msg.target.Name
		m.messageIsErr = false
		return m, tea.Batch(m.refreshStatusCmd(), m.fetchLogsCmd())
	case statusRefreshedMsg:
		if msg.err != nil {
			m.message = msg.err.Error()
			m.messageIsErr = true
			return m, nil
		}
		currentDir := ""
		if cur := m.current(); cur != nil {
			currentDir = cur.Dir
		}
		if msg.worktrees != nil {
			m.rc.worktrees = append([]gitwt.Worktree(nil), msg.worktrees...)
			m.rc.manager.UpdateWorktrees(msg.worktrees)
		}
		m.rows = msg.rows
		if len(msg.rows) == 0 {
			m.idx = 0
			return m, nil
		}
		for i := range msg.rows {
			if msg.rows[i].Dir == currentDir {
				m.idx = i
				return m, nil
			}
		}
		if m.idx >= len(msg.rows) {
			m.idx = len(msg.rows) - 1
		}
	case logsMsg:
		cur := m.current()
		if cur != nil && msg.dir == cur.Dir {
			m.logLines = msg.linesByTarget
			m.logDir = msg.dir
		}
	case tickLogsMsg:
		return m, tea.Batch(m.refreshStatusCmd(), m.fetchLogsCmd(), m.scheduleLogRefresh())
	case tea.KeyPressMsg:
		if m.createGroupMode {
			return m.updateCreateGroupKeys(msg)
		}
		if m.filterMode {
			return m.updateFilterKeys(msg)
		}
		if m.loading {
			if key.Matches(msg, m.keys.Quit) {
				m.buildQuitInfo()
				return m, tea.Quit
			}
			return m, nil
		}
		switch {
		case key.Matches(msg, m.keys.Quit):
			m.buildQuitInfo()
			return m, tea.Quit
		case key.Matches(msg, m.keys.Help):
			m.showAll = !m.showAll
			m.help.ShowAll = m.showAll
		case key.Matches(msg, m.keys.Next):
			m.next()
			return m, m.fetchLogsCmd()
		case key.Matches(msg, m.keys.Prev):
			m.prev()
			return m, m.fetchLogsCmd()
		case key.Matches(msg, m.keys.Switch):
			return m, m.switchCurrentCmd()
		case key.Matches(msg, m.keys.Restart):
			return m, m.restartCurrentCmd()
		case key.Matches(msg, m.keys.StopAll):
			return m, m.stopAllCurrentCmd()
		case key.Matches(msg, m.keys.Stop):
			return m, m.stopCurrentCmd()
		case key.Matches(msg, m.keys.Attach):
			return m, m.attachCurrentCmd()
		case key.Matches(msg, m.keys.ProcNext):
			m.cycleTarget(1)
		case key.Matches(msg, m.keys.ProcPrev):
			m.cycleTarget(-1)
		case key.Matches(msg, m.keys.Filter):
			return m, m.enterFilterMode()
		case key.Matches(msg, m.keys.CreateGroup):
			return m, m.enterCreateGroupMode()
		}
	}

	if m.filterMode {
		var cmd tea.Cmd
		m.filterInput, cmd = m.filterInput.Update(msg)
		return m, cmd
	}

	return m, nil
}

// --- Navigation ---

func (m *tuiModel) next() {
	if len(m.rows) == 0 {
		return
	}
	m.idx = (m.idx + 1) % len(m.rows)
	m.logLines = nil
}

func (m *tuiModel) prev() {
	if len(m.rows) == 0 {
		return
	}
	m.idx = (m.idx - 1 + len(m.rows)) % len(m.rows)
	m.logLines = nil
}

func (m *tuiModel) current() *runtime.StatusRow {
	if len(m.rows) == 0 || m.idx < 0 || m.idx >= len(m.rows) {
		return nil
	}
	return &m.rows[m.idx]
}

func (m *tuiModel) activeRow() *runtime.StatusRow {
	for i := range m.rows {
		if m.rows[i].Active {
			return &m.rows[i]
		}
	}
	return nil
}

func (m *tuiModel) selectedTarget() (model.Target, bool) {
	if len(m.targets) == 0 || m.targetIdx < 0 || m.targetIdx >= len(m.targets) {
		return model.Target{}, false
	}
	return m.targets[m.targetIdx], true
}

func targetProcessState(row *runtime.StatusRow, target model.Target) (managed, exited bool) {
	if row == nil || target.Name == "" {
		return false, false
	}
	members := make(map[string]struct{}, max(1, len(target.ProcessNames)))
	for _, name := range target.ProcessNames {
		members[name] = struct{}{}
	}
	if len(members) == 0 {
		members[target.Name] = struct{}{}
	}
	allExited := true
	for _, process := range row.Processes {
		if _, matches := members[process.Name]; !matches {
			continue
		}
		managed = true
		if !process.Exited {
			allExited = false
		}
	}
	return managed, managed && allExited
}

func (m *tuiModel) selectTarget(target model.Target) {
	for i := range m.targets {
		if sameTarget(m.targets[i], target) {
			m.targetIdx = i
			return
		}
	}
}

func (m *tuiModel) cycleTarget(delta int) {
	if len(m.targets) == 0 {
		m.message = "no targets configured — add processes or groups to .wts.yaml"
		m.messageIsErr = true
		return
	}
	if m.targetIdx < 0 {
		m.targetIdx = 0
	} else {
		m.targetIdx = (m.targetIdx + delta + len(m.targets)) % len(m.targets)
	}
	target, _ := m.selectedTarget()
	m.message = "target: " + formatTargetLabel(target)
	m.messageIsErr = false
}

func (m *tuiModel) renderGroupLogs(target model.Target, logSpace, maxW int) []string {
	if len(target.ProcessNames) == 0 || logSpace <= 0 {
		return nil
	}

	// Build a tag style per process using the process name as a prefix.
	// Interleave the most recent lines from each process to show a unified
	// chronological-ish view (latest output at the bottom).

	// Collect tail lines from each process, most-recent-last.
	type taggedLine struct {
		tag  string
		text string
	}
	var merged []taggedLine
	nprocs := len(target.ProcessNames)

	// Give each process a fair share of lines, but let any process use
	// surplus space if another has fewer lines.
	budget := logSpace
	remaining := make([]string, 0, nprocs)
	for _, name := range target.ProcessNames {
		if len(m.logLines[name]) > 0 {
			remaining = append(remaining, name)
		}
	}
	if len(remaining) == 0 {
		return []string{m.styles.dimText.Render("waiting for output...")}
	}

	perProc := max(1, budget/len(remaining))
	for _, name := range remaining {
		plog := m.logLines[name]
		n := min(perProc, len(plog))
		start := len(plog) - n
		for _, l := range plog[start:] {
			merged = append(merged, taggedLine{tag: name, text: l})
		}
	}

	// Trim to fit.
	if len(merged) > logSpace {
		merged = merged[len(merged)-logSpace:]
	}

	// Compute the shortest unambiguous tag for each process name.
	shortTag := make(map[string]string, nprocs)
	for _, name := range target.ProcessNames {
		shortTag[name] = name
	}

	lines := make([]string, 0, len(merged))
	for _, ml := range merged {
		tag := m.styles.dimText.Render(shortTag[ml.tag] + " │ ")
		tagW := lipgloss.Width(tag)
		textW := max(1, maxW-tagW)
		lines = append(lines, tag+m.styles.logText.Render(truncateLine(ml.text, textW)))
	}
	return lines
}

func sameTarget(left, right model.Target) bool {
	return left.Kind == right.Kind && left.Name == right.Name
}

func formatTargetLabel(target model.Target) string {
	if target.Kind == model.TargetGroup {
		return "[group] " + target.Name
	}
	return target.Name
}

func runOptionsForTarget(target model.Target) runtime.RunOptions {
	opts := runtime.RunOptions{}
	if target.Kind == model.TargetGroup {
		opts.Group = target.Name
		return opts
	}
	opts.Process = target.Name
	return opts
}

// --- Group editor ---

func (m *tuiModel) enterCreateGroupMode() tea.Cmd {
	m.createGroupMode = true
	m.createGroupFocus = createGroupFocusName
	m.createGroupCursor = 0
	m.createGroupSelected = make(map[string]bool, len(m.rc.project.Processes))
	m.createGroupInput.SetValue("")

	if target, ok := m.selectedTarget(); ok {
		for _, name := range target.ProcessNames {
			m.createGroupSelected[name] = true
		}
	}

	m.message = ""
	m.messageIsErr = false
	return m.createGroupInput.Focus()
}

func (m *tuiModel) updateCreateGroupKeys(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch msg.Code {
	case tea.KeyEsc:
		m.createGroupMode = false
		m.createGroupSelected = map[string]bool{}
		m.createGroupInput.Blur()
		return m, nil
	case tea.KeyTab:
		if m.createGroupFocus == createGroupFocusName {
			m.createGroupFocus = createGroupFocusMembers
			m.createGroupInput.Blur()
			return m, nil
		}
		m.createGroupFocus = createGroupFocusName
		return m, m.createGroupInput.Focus()
	case tea.KeyEnter:
		return m, m.saveCreateGroupCmd()
	}

	if m.createGroupFocus == createGroupFocusMembers {
		switch msg.Code {
		case tea.KeyUp:
			if len(m.rc.project.Processes) > 0 {
				m.createGroupCursor = (m.createGroupCursor - 1 + len(m.rc.project.Processes)) % len(m.rc.project.Processes)
			}
			return m, nil
		case tea.KeyDown:
			if len(m.rc.project.Processes) > 0 {
				m.createGroupCursor = (m.createGroupCursor + 1) % len(m.rc.project.Processes)
			}
			return m, nil
		case tea.KeySpace:
			processNames := m.rc.project.ProcessNames()
			if len(processNames) == 0 {
				return m, nil
			}
			name := processNames[m.createGroupCursor]
			if m.createGroupSelected[name] {
				delete(m.createGroupSelected, name)
			} else {
				m.createGroupSelected[name] = true
			}
			return m, nil
		}
		return m, nil
	}

	var cmd tea.Cmd
	m.createGroupInput, cmd = m.createGroupInput.Update(msg)
	return m, cmd
}

func (m *tuiModel) selectedCreateGroupMembers() []string {
	members := make([]string, 0, len(m.createGroupSelected))
	for _, name := range m.rc.project.ProcessNames() {
		if m.createGroupSelected[name] {
			members = append(members, name)
		}
	}
	return members
}

func (m *tuiModel) saveCreateGroupCmd() tea.Cmd {
	name := strings.TrimSpace(m.createGroupInput.Value())
	members := m.selectedCreateGroupMembers()
	if name == "" {
		m.message = "group name is required"
		m.messageIsErr = true
		return nil
	}
	if len(members) == 0 {
		m.message = "select at least one process for the group"
		m.messageIsErr = true
		return nil
	}

	cfg := m.rc.project.Config()
	cfg.Groups = append(cfg.Groups, model.ProcessGroup{
		Name:      name,
		Processes: append([]string(nil), members...),
	})

	m.loading = true
	m.loadingMsg = "saving group " + name + "..."

	return func() tea.Msg {
		project, err := config.Save(m.rc.project.ConfigPath, cfg)
		if err != nil {
			return actionErrMsg{err: err}
		}
		target, err := project.ResolveTarget("", name)
		if err != nil {
			return actionErrMsg{err: err}
		}
		return groupCreatedMsg{project: project, target: target}
	}
}

// --- Process filter ---

func (m *tuiModel) enterFilterMode() tea.Cmd {
	m.filterMode = true
	m.preFilterIdx = m.targetIdx
	m.filterInput.SetValue("")
	return m.filterInput.Focus()
}

func (m *tuiModel) updateFilterKeys(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch msg.Code {
	case tea.KeyEnter:
		m.filterMode = false
		m.filterInput.Blur()
		target, ok := m.selectedTarget()
		if ok {
			m.message = "target: " + formatTargetLabel(target)
		} else {
			m.message = ""
		}
		m.messageIsErr = false
		return m, nil
	case tea.KeyEscape:
		m.filterMode = false
		m.filterInput.Blur()
		m.targetIdx = m.preFilterIdx
		return m, nil
	}

	var cmd tea.Cmd
	m.filterInput, cmd = m.filterInput.Update(msg)
	m.filterProcesses(m.filterInput.Value())
	return m, cmd
}

func (m *tuiModel) filterProcesses(query string) {
	if query == "" {
		m.targetIdx = m.preFilterIdx
		return
	}
	q := strings.ToLower(query)
	m.targetIdx = -1
	for i, target := range m.targets {
		if strings.Contains(strings.ToLower(formatTargetLabel(target)), q) {
			m.targetIdx = i
			return
		}
	}
}

func (m *tuiModel) countFilterMatches(query string) int {
	if query == "" {
		return len(m.targets)
	}
	q := strings.ToLower(query)
	count := 0
	for _, target := range m.targets {
		if strings.Contains(strings.ToLower(formatTargetLabel(target)), q) {
			count++
		}
	}
	return count
}
