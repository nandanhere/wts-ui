-- Open Task changes for a task without a complete record before this check.
-- This check reads the WTS window. It does not change files or send messages.
tell application "System Events"
	tell application process "wts-desktop"
		set resultDialog to group "Task changes" of UI element 1 of scroll area 1 of group 1 of group 1 of window 1
		set recoveryLink to UI element "View current local changes" of resultDialog
		set recoveryMessage to static text "This task has no complete change record. Open the current local changes to inspect the workspace." of group 3 of resultDialog
		set {dialogX, dialogY} to position of resultDialog
		set {dialogWidth, dialogHeight} to size of resultDialog
		repeat with targetElement in {recoveryLink, recoveryMessage}
			set {elementX, elementY} to position of targetElement
			set {elementWidth, elementHeight} to size of targetElement
			if elementWidth < 1 or elementHeight < 1 then error "Recovery content has no visible area."
			if elementX < dialogX or elementY < dialogY or elementX + elementWidth > dialogX + dialogWidth + 1 or elementY + elementHeight > dialogY + dialogHeight + 1 then
				error "Recovery content is outside the Task changes dialog."
			end if
		end repeat
		return "Passed: The recovery message and link are inside the Task changes dialog."
	end tell
end tell
