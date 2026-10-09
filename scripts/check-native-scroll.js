// Native scroll check for the installed WTS app. It reads the accessibility tree of the real WKWebView window.
// It opens a workspace and its Code review view. It does not change files, run agents, or post comments.
// Usage: osascript -l JavaScript scripts/check-native-scroll.js "<part of a workspace name>"
// Requires Accessibility permission for the app that runs osascript.
function run(argv) {
  const cardLabel = argv[0];
  const se = Application("System Events");
  const proc = se.applicationProcesses.byName("wts-desktop");
  if (!proc.exists()) throw new Error("WTS is not running. Open /Applications/WTS.app.");
  // WebKit refreshes the accessibility tree of a background window slowly. The check brings WTS to the front.
  Application("WTS").activate();
  delay(1.5);
  const win = proc.windows[0];

  const read = (el, key) => { try { return el[key](); } catch (error) { return undefined; } };
  const label = (el) => read(el, "description") || read(el, "name") || read(el, "title") || "";
  // Controls do not hold the targets. The search does not read inside buttons, which keeps it fast on a full board.
  function find(root, test, budget = 8000) {
    const queue = [root];
    while (queue.length && budget-- > 0) {
      const el = queue.shift();
      if (test(el)) return el;
      if (el !== root && read(el, "role") === "AXButton") continue;
      const kids = read(el, "uiElements") || [];
      for (const kid of kids) queue.push(kid);
    }
    return null;
  }
  function press(el) { el.actions.byName("AXPress").perform(); delay(2.5); }

  if (cardLabel) {
    const spaces = find(win, (el) => label(el) === "Open Spaces");
    if (spaces) press(spaces);
    const card = find(win, (el) => read(el, "role") === "AXButton" && /^Open .* details$/.test(label(el)) && label(el).includes(cardLabel));
    if (!card) throw new Error(`No workspace card matches "${cardLabel}". Open Spaces and try again.`);
    press(card);
  }
  const tab = find(win, (el) => read(el, "role") === "AXRadioButton" && /^(Changes|Code review)/.test(label(el)));
  if (!tab) throw new Error("The Changes tab is not on the screen. Open a workspace and try again.");
  press(tab);
  delay(3);

  const screen = find(win, (el) => label(el) === "Change review");
  if (!screen) throw new Error("The Change review panel did not open.");
  const [screenX, screenY] = read(screen, "position");
  const [screenW, screenH] = read(screen, "size");
  const [winX, winY] = read(win, "position");
  const [winW, winH] = read(win, "size");
  const bottom = Math.min(screenY + screenH, winY + winH);

  // Each direct region of the panel must end inside the panel. A region that ends lower is clipped and cannot scroll.
  const outside = [];
  const stack = [{ el: screen, depth: 0 }];
  while (stack.length) {
    const { el, depth } = stack.pop();
    if (depth > 4) continue;
    for (const kid of read(el, "uiElements") || []) {
      const position = read(kid, "position");
      const size = read(kid, "size");
      if (position && size && size[1] > 40 && position[1] < bottom && position[1] + size[1] > bottom + 2) {
        outside.push(`${read(kid, "role")} "${label(kid)}" ends ${Math.round(position[1] + size[1] - bottom)} px below the panel`);
      }
      stack.push({ el: kid, depth: depth + 1 });
    }
  }
  const summary = `Window ${winW}x${winH}. Change review panel ${screenW}x${screenH} at ${screenX},${screenY}.`;
  if (outside.length) throw new Error(`${summary}\nClipped regions:\n${outside.join("\n")}`);
  return `Passed: ${summary} All regions end inside the panel.`;
}
