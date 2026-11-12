// Launch → Sprint planning (M25): one entry for both planners.
//
// The planner (M15, #planner) and the flow (M23, #planflow) used to be two
// sidebar entries. Both stay for now (settled 2026-10-16); this screen is the
// one way in, and whether the flow replaces the planner is revisited after the
// team has used both. Each keeps its own draft, so picking one here never
// touches the other's.

import { icon } from "../components/icons.js";
import { viewHeader } from "../components/view-header.js";

export const PLANNING_CHOICES = [
  {
    hash: "#planflow",
    iconName: "flag",
    title: "Step-by-step planning wizard",
    body:
      "Set up, wrap up the outgoing sprint, plan, then review and start: the writes, " +
      "the close, the start and the freeze in one confirm.",
  },
  {
    hash: "#planner",
    iconName: "calendar",
    title: "Legacy manual flow",
    body:
      "The sprint planner: capacity, drag and drop, and a reviewed push. The sprint " +
      "itself is completed and started in Jira.",
  },
];

export function mount(container) {
  container.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "planning-choice-wrap";
  wrap.appendChild(
    viewHeader({
      iconName: "calendar",
      title: "Sprint planning",
      subtitle: "Two ways to plan the next sprint. Each keeps its own draft.",
    })
  );

  const grid = document.createElement("div");
  grid.className = "planning-choices";
  for (const choice of PLANNING_CHOICES) {
    const link = document.createElement("a");
    link.className = "planning-choice";
    link.href = choice.hash;
    const mark = document.createElement("span");
    mark.className = "planning-choice-icon";
    mark.appendChild(icon(choice.iconName, 22));
    const title = document.createElement("span");
    title.className = "planning-choice-title";
    title.textContent = choice.title;
    const body = document.createElement("span");
    body.className = "planning-choice-body";
    body.textContent = choice.body;
    link.append(mark, title, body);
    grid.appendChild(link);
  }
  wrap.appendChild(grid);
  container.appendChild(wrap);
  // Enter opens the wizard without reaching for the mouse.
  grid.querySelector("a")?.focus();
}
