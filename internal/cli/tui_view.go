package cli

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"

	"github.com/charmbracelet/x/ansi"
	"github.com/xrehpicx/wts/internal/model"
)

func (m *tuiModel) View() tea.View {
	w, h := m.width, m.height
	if w <= 0 {
		w = 110
	}
	if h <= 0 {
		h = 30
	}
	if h < 5 {
		content := truncateLine(" wts · "+filepath.Base(m.rc.repoRoot), w)
		view := tea.NewView(content)
		view.AltScreen = true
		view.WindowTitle = "wts · " + filepath.Base(m.rc.repoRoot)
		return view
	}

	header := m.renderHeader(w)
	footer := m.renderFooter(w)

	contentH := max(1, h-lipgloss.Height(header)-lipgloss.Height(footer))
	content := m.renderContent(w, contentH)

	view := tea.NewView(lipgloss.JoinVertical(lipgloss.Left, header, content, footer))
	view.AltScreen = true
	view.WindowTitle = "wts · " + filepath.Base(m.rc.repoRoot)
	return view
}

// --- Render sections ---

func (m *tuiModel) renderHeader(width int) string {
	repoName := filepath.Base(m.rc.repoRoot)

	topLeft := " " + m.styles.title.Render("wts") + m.styles.dimText.Render(" · "+repoName)
	topRight := m.styles.subtitle.Render(fmt.Sprintf("%d worktrees", len(m.rows))) + " "

	row1 := headerRow(topLeft, topRight, width)

	var botLeft, botRight string

	if m.filterMode {
		botLeft = " " + m.styles.dimText.Render("/") + " " + m.filterInput.View()
		count := m.countFilterMatches(m.filterInput.Value())
		botRight = m.styles.subtitle.Render(fmt.Sprintf("%d matching", count)) + " "
	} else {
		target, ok := m.selectedTarget()
		active := m.activeRow()
		var summary string
		targetLabel := "no target"
		if ok {
			targetLabel = formatTargetLabel(target)
		}
		if active != nil {
			wt := m.styles.metaValue.Render(active.Worktree)
			branch := m.styles.dimText.Render(" [" + active.Branch + "]")
			var dot string
			nprocs := len(active.Processes)
			if active.Running && active.Exited {
				dot = m.styles.exitedDot.Render(" · ● exited")
			} else if active.Running && nprocs > 1 {
				dot = m.styles.runDot.Render(fmt.Sprintf(" · ● %d running", nprocs))
			} else if active.Running {
				dot = m.styles.runDot.Render(" · ● running")
			} else {
				dot = m.styles.stopDot.Render(" · ○ stopped")
			}
			summary = m.styles.title.Render(targetLabel) + m.styles.dimText.Render(" → ") + wt + branch + dot
		} else if !ok {
			summary = m.styles.dimText.Render("select a process or group with ←/→")
		} else {
			summary = m.styles.title.Render(targetLabel) + m.styles.dimText.Render(" (idle)")
		}
		botLeft = " " + summary

		if m.loading {
			botRight = m.styles.statusBusy.Render(m.spinner.View()+" "+m.loadingMsg) + "  "
		} else if m.message != "" {
			if m.messageIsErr {
				botRight = m.styles.statusErr.Render("✗ "+m.message) + " "
			} else {
				botRight = m.styles.statusOk.Render("✓ "+m.message) + " "
			}
		}
	}

	row2 := headerRow(botLeft, botRight, width)
	sep := m.styles.separator.Render(strings.Repeat("─", width))

	return lipgloss.JoinVertical(lipgloss.Left, row1, row2, sep)
}

func (m *tuiModel) renderContent(width, height int) string {
	width = max(1, width)
	height = max(1, height)
	if len(m.rows) == 0 {
		empty := m.styles.dimText.Render("No worktrees found. Create one with:")
		hint := m.styles.metaValue.Render("  git worktree add ../branch-name")
		return m.renderPanel("Worktrees", []string{empty, hint}, width, height, true)
	}

	if width < 88 {
		if height < 8 {
			if m.createGroupMode {
				return m.renderCreateGroupPanel(width, height)
			}
			return m.renderDetailPanel(width, height)
		}
		usableHeight := height - 1
		listHeight := (usableHeight * 2) / 5
		listHeight = max(3, listHeight)
		detailHeight := usableHeight - listHeight
		if detailHeight < 3 {
			detailHeight = 3
			listHeight = max(3, usableHeight-detailHeight)
		}
		left := m.renderListPanel(width, listHeight)
		right := m.renderDetailPanel(width, detailHeight)
		if m.createGroupMode {
			right = m.renderCreateGroupPanel(width, detailHeight)
		}
		return lipgloss.JoinVertical(lipgloss.Left, left, right)
	}

	spacer := 1
	usableWidth := max(2, width-spacer)
	leftWidth := max(1, usableWidth/3)
	rightWidth := usableWidth - leftWidth
	left := m.renderListPanel(leftWidth, height)
	right := m.renderDetailPanel(rightWidth, height)
	if m.createGroupMode {
		right = m.renderCreateGroupPanel(rightWidth, height)
	}
	left = lipgloss.NewStyle().MarginRight(spacer).Render(left)
	return lipgloss.JoinHorizontal(lipgloss.Top, left, right)
}

func (m *tuiModel) renderListPanel(width, height int) string {
	maxTextWidth := max(1, width-m.styles.panelFocus.GetHorizontalFrameSize())
	innerHeight := max(1, height-m.styles.panelFocus.GetVerticalFrameSize())
	lineCapacity := max(1, innerHeight-2) // panel title and spacer
	start, end := visibleWorktreeRange(len(m.rows), m.idx, m.listOffset, lineCapacity)
	m.listOffset = start
	lines := make([]string, 0, (end-start)*3)

	// Compute display names, disambiguating when names collide.
	nameCount := map[string]int{}
	for _, r := range m.rows {
		nameCount[r.Worktree]++
	}
	displayNames := make([]string, len(m.rows))
	for i, r := range m.rows {
		if nameCount[r.Worktree] > 1 {
			parent := filepath.Base(filepath.Dir(r.Dir))
			displayNames[i] = r.Worktree + " (" + parent + ")"
		} else {
			displayNames[i] = r.Worktree
		}
	}

	for i := start; i < end; i++ {
		row := m.rows[i]

		// --- Line 1: cursor + dot + name + badge ---
		cursor := "  "
		if i == m.idx {
			cursor = "▸ "
		}

		var dot string
		if row.Prunable {
			dot = m.styles.exitedDot.Render("⚠")
		} else if m.loading && row.Dir == m.loadingDir {
			dot = m.spinner.View()
		} else if row.Running && row.Exited {
			dot = m.styles.exitedDot.Render("●")
		} else if row.Running {
			dot = m.styles.runDot.Render("●")
		} else {
			dot = m.styles.stopDot.Render("○")
		}

		nameText := truncateLine(displayNames[i], max(1, maxTextWidth-6))
		namePart := cursor + dot + " " + nameText

		// Right-aligned badge.
		procBadge := ""
		if row.Prunable {
			procBadge = "prunable"
		} else if len(row.Processes) > 1 {
			procBadge = fmt.Sprintf("×%d", len(row.Processes))
		} else if row.Active {
			procBadge = "★"
		}

		var line1 string
		if procBadge != "" {
			nameW := lipgloss.Width(namePart)
			badgeW := lipgloss.Width(procBadge)
			gap := max(1, maxTextWidth-nameW-badgeW)
			line1 = namePart + strings.Repeat(" ", gap) + m.styles.dimText.Render(procBadge)
		} else {
			line1 = namePart
		}

		// --- Line 2: branch (indented, dimmed) + process names ---
		branchIndent := "     "
		availW := max(1, maxTextWidth-len(branchIndent))
		branchText := truncateLine(row.Branch, availW)

		var line2 string
		if row.Prunable {
			line2 = branchIndent + m.styles.dimText.Render(branchText)
		} else if len(row.Processes) > 0 && row.Running {
			// Show compact process status dots after branch.
			procParts := make([]string, 0, len(row.Processes))
			for _, p := range row.Processes {
				var pdot string
				if p.Running && p.Exited {
					pdot = m.styles.exitedDot.Render("●")
				} else if p.Running {
					pdot = m.styles.runDot.Render("●")
				} else {
					pdot = m.styles.stopDot.Render("○")
				}
				procParts = append(procParts, pdot+" "+m.styles.dimText.Render(p.Name))
			}
			procInfo := strings.Join(procParts, m.styles.dimText.Render(" · "))
			branchLine := m.styles.dimText.Render(branchText)
			sep := m.styles.dimText.Render(" · ")
			combined := branchLine + sep + procInfo
			if lipgloss.Width(combined) > availW {
				line2 = branchIndent + m.styles.dimText.Render(branchText)
			} else {
				line2 = branchIndent + combined
			}
		} else {
			line2 = branchIndent + m.styles.dimText.Render(branchText)
		}

		// Apply selection styling padded to full width for uniform highlight.
		if i == m.idx {
			sel := m.styles.selectedRow.Width(maxTextWidth)
			line1 = sel.Render(line1)
			line2 = sel.Render(line2)
		}

		lines = append(lines, line1, line2)

		// Add a blank separator between visible entries.
		if i < end-1 {
			lines = append(lines, "")
		}
	}

	return m.renderPanel("Worktrees", lines, width, height, true)
}

func visibleWorktreeRange(total, selected, offset, lineCapacity int) (int, int) {
	if total <= 0 {
		return 0, 0
	}

	// Each worktree uses two content lines plus one separator. The final
	// visible entry does not need a separator, hence the extra line here.
	visible := max(1, (max(1, lineCapacity)+1)/3)
	visible = min(visible, total)
	selected = min(max(0, selected), total-1)
	offset = min(max(0, offset), total-visible)

	if selected < offset {
		offset = selected
	} else if selected >= offset+visible {
		offset = selected - visible + 1
	}

	return offset, min(total, offset+visible)
}

func (m *tuiModel) renderDetailPanel(width, height int) string {
	maxW := max(1, width-m.styles.panelBorder.GetHorizontalFrameSize())
	target, ok := m.selectedTarget()
	panelTitle := "←/→ to select process or group"
	if ok {
		panelTitle = formatTargetLabel(target)
	}

	row := m.current()
	if row == nil {
		return m.renderPanel(panelTitle,
			[]string{m.styles.dimText.Render("No worktree selected.")},
			width, height, false)
	}

	innerHeight := max(1, height-2)
	capacity := innerHeight - 2
	if capacity < 4 {
		return m.renderPanel(panelTitle,
			[]string{m.styles.dimText.Render(row.Worktree)},
			width, height, false)
	}

	// Meta line: branch · dir
	meta := m.styles.metaValue.Render(row.Branch) +
		m.styles.dimText.Render(" · ") +
		m.styles.dimText.Render(truncateLine(shortenPath(row.Dir), max(1, maxW-lipgloss.Width(row.Branch)-4)))

	// Running processes summary
	var procSummary string
	if len(row.Processes) > 0 {
		parts := make([]string, 0, len(row.Processes))
		for _, p := range row.Processes {
			var dot string
			if p.Running && p.Exited {
				dot = m.styles.exitedDot.Render("●")
			} else if p.Running {
				dot = m.styles.runDot.Render("●")
			} else {
				dot = m.styles.stopDot.Render("○")
			}
			parts = append(parts, dot+" "+p.Name)
		}
		procSummary = strings.Join(parts, m.styles.dimText.Render("  "))
	} else if !row.Running {
		procSummary = m.styles.stopDot.Render("○") + m.styles.dimText.Render(" no processes running")
	}

	// Command for selected process
	detailLines := make([]string, 0, 3)
	switch {
	case !ok:
		detailLines = append(detailLines, m.styles.dimText.Render("← / → to select a process or group"))
	case target.Kind == model.TargetGroup:
		members := truncateLine(strings.Join(target.ProcessNames, ", "), maxW)
		detailLines = append(detailLines, m.styles.dimText.Render("members: ")+m.styles.metaValue.Render(members))
	default:
		procDef, err := m.rc.project.Process(target.Name)
		if err != nil {
			detailLines = append(detailLines, m.styles.statusErr.Render(truncateLine(err.Error(), maxW)))
		} else {
			detailLines = append(detailLines, m.styles.dimText.Render("▸ ")+m.styles.metaValue.Render(truncateLine(procDef.Command, maxW-2)))
		}
	}

	// Output separator
	label := " output "
	if ok && target.Kind == model.TargetProcess {
		label = " " + target.Name + " "
	} else if ok {
		label = " " + target.Name + " "
	}
	sepW := max(0, maxW-lipgloss.Width(label))
	leftSep := max(0, sepW/5)
	rightSep := max(0, sepW-leftSep)
	outputSep := m.styles.separator.Render(strings.Repeat("─", leftSep)) +
		m.styles.dimText.Render(label) +
		m.styles.separator.Render(strings.Repeat("─", rightSep))

	// Action hint
	var hint string
	targetNoun := "target"
	if ok && target.Kind == model.TargetGroup {
		targetNoun = "group"
	} else if ok {
		targetNoun = "process"
	}
	targetManaged, targetExited := targetProcessState(row, target)
	if targetManaged && targetExited {
		hint = m.styles.dimText.Render("a attach tmux · r restart · x stop · " + targetNoun + " exited")
	} else if targetManaged {
		hint = m.styles.dimText.Render("a attach tmux · r restart · x stop " + targetNoun)
	} else if row.Running {
		hint = m.styles.dimText.Render("s/↵ add " + targetNoun + " · a attach tmux · r restart · x stop")
	} else {
		hint = m.styles.dimText.Render("s/↵ start " + targetNoun)
	}

	// Build lines: meta(1) + procs(1) + cmd(1) + sep(1) + [logs...] + hint(1)
	lines := make([]string, 0, capacity)
	lines = append(lines, meta)
	if procSummary != "" {
		lines = append(lines, procSummary)
	}
	lines = append(lines, detailLines...)
	lines = append(lines, outputSep)

	logSpace := capacity - len(lines) - 1
	if logSpace > 0 {
		cur := m.current()
		if cur != nil && cur.Dir == m.logDir && len(m.logLines) > 0 {
			if ok && target.Kind == model.TargetGroup {
				lines = append(lines, m.renderGroupLogs(target, logSpace, maxW)...)
			} else {
				processName := ""
				if ok {
					processName = target.Name
				}
				processLogs := m.logLines[processName]
				start := max(0, len(processLogs)-logSpace)
				for _, l := range processLogs[start:] {
					lines = append(lines, m.styles.logText.Render(truncateLine(l, maxW)))
				}
			}
		} else if !row.Running {
			lines = append(lines, m.styles.dimText.Render(targetNoun+" not running"))
		}
	}

	for len(lines) < capacity-1 {
		lines = append(lines, "")
	}
	lines = append(lines, hint)

	return m.renderPanel(panelTitle, lines, width, height, false)
}

func (m *tuiModel) renderCreateGroupPanel(width, height int) string {
	if width < 3 || height < 3 {
		return truncateLine("Create Group", max(1, width))
	}
	maxW := max(1, width-m.styles.modalBorder.GetHorizontalFrameSize())
	innerHeight := max(1, height-2)
	capacity := max(0, innerHeight-2)
	if capacity == 0 {
		return renderBordered(m.styles.modalBorder,
			[]string{m.styles.panelTitle.Render("Create Group")}, width, height)
	}

	lines := []string{
		m.styles.dimText.Render("Create a group in " + filepath.Base(m.rc.project.ConfigPath)),
		"",
		m.styles.dimText.Render("name"),
		m.renderCreateGroupNameLine(maxW),
		"",
		m.styles.dimText.Render("members"),
	}

	processNames := m.rc.project.ProcessNames()
	if len(processNames) == 0 {
		lines = append(lines, m.styles.statusErr.Render("No processes available"))
	} else {
		memberCapacity := max(1, capacity-len(lines)-2)
		start := 0
		if m.createGroupFocus == createGroupFocusMembers && m.createGroupCursor >= memberCapacity {
			start = m.createGroupCursor - memberCapacity + 1
		}
		end := min(len(processNames), start+memberCapacity)
		for i := start; i < end; i++ {
			name := processNames[i]
			cursor := "  "
			if m.createGroupFocus == createGroupFocusMembers && i == m.createGroupCursor {
				cursor = "▸ "
			}
			box := "[ ]"
			if m.createGroupSelected[name] {
				box = "[x]"
			}
			line := cursor + box + " " + name
			if m.createGroupFocus == createGroupFocusMembers && i == m.createGroupCursor {
				line = m.styles.modalFocus.Render(truncateLine(line, maxW))
			} else {
				line = m.styles.row.Render(truncateLine(line, maxW))
			}
			lines = append(lines, line)
		}
	}

	lines = append(lines, "")
	lines = append(lines, m.styles.dimText.Render("tab switch focus · space toggle member · enter save · esc cancel"))

	if len(lines) > capacity {
		lines = lines[:capacity]
	}
	for len(lines) < capacity {
		lines = append(lines, "")
	}

	content := append([]string{m.styles.panelTitle.Render("Create Group"), ""}, lines...)
	return renderBordered(m.styles.modalBorder, content, width, height)
}

func (m *tuiModel) renderCreateGroupNameLine(maxW int) string {
	line := m.createGroupInput.View()
	if strings.TrimSpace(line) == "" {
		line = m.styles.dimText.Render("group name")
	}
	line = truncateLine(line, maxW)
	if m.createGroupFocus == createGroupFocusName {
		return m.styles.modalFocus.Render(line)
	}
	return m.styles.row.Render(line)
}

func (m *tuiModel) renderPanel(title string, lines []string, width, height int, focused bool) string {
	border := m.styles.panelBorder
	if focused {
		border = m.styles.panelFocus
	}
	innerWidth := max(1, width-border.GetHorizontalFrameSize())
	innerHeight := max(1, height-border.GetVerticalFrameSize())

	content := make([]string, 0, innerHeight)
	content = append(content, m.styles.panelTitle.Render(truncateLine(title, innerWidth)))
	content = append(content, "")
	for _, line := range lines {
		content = append(content, truncateLine(line, innerWidth))
		if len(content) >= innerHeight {
			break
		}
	}
	for len(content) < innerHeight {
		content = append(content, "")
	}

	return renderBordered(border, content, width, height)
}

func renderBordered(style lipgloss.Style, lines []string, width, height int) string {
	innerWidth := max(1, width-style.GetHorizontalFrameSize())
	innerHeight := max(1, height-style.GetVerticalFrameSize())
	content := make([]string, 0, innerHeight)
	for _, line := range lines {
		if len(content) >= innerHeight {
			break
		}
		content = append(content, truncateLine(line, innerWidth))
	}
	for len(content) < innerHeight {
		content = append(content, "")
	}
	return style.Width(max(1, width)).Render(strings.Join(content, "\n"))
}

func (m *tuiModel) renderFooter(width int) string {
	m.help.SetWidth(max(1, width-1))
	helpView := m.help.ShortHelpView(m.keys.ShortHelp())
	if m.showAll {
		helpView = m.help.FullHelpView(m.keys.FullHelp())
	}
	return " " + helpView
}

// --- Helpers ---

func shortenPath(p string) string {
	home, err := os.UserHomeDir()
	if err != nil {
		return p
	}
	relative, err := filepath.Rel(home, p)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return p
	}
	if relative == "." {
		return "~"
	}
	return filepath.Join("~", relative)
}

func truncateLine(s string, width int) string {
	if width <= 0 {
		return ""
	}
	return ansi.Truncate(s, width, "…")
}

func headerRow(left, right string, width int) string {
	if width <= 0 {
		return ""
	}
	gap := width - lipgloss.Width(left) - lipgloss.Width(right)
	if gap >= 1 {
		return left + strings.Repeat(" ", gap) + right
	}
	rightWidth := lipgloss.Width(right)
	if rightWidth+1 >= width {
		return truncateLine(left, width)
	}
	left = truncateLine(left, width-rightWidth-1)
	return left + " " + right
}
