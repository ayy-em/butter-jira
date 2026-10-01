// Launch → Sprint planning (M23): the planning flow. A mode of the planner view
// rather than a second copy of it — the plan screen is the same one — with its
// own draft, so the planner and the flow can be used and compared side by side.

import { mount as mountPlanner } from "./planner.js";

export function mount(container, creds) {
  return mountPlanner(container, creds, { flow: true });
}
