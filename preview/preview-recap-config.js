// Local preview harness for Launch → Recap config.
//
// The shared fixture's boards, each given a run of closed sprints so the list,
// the quick picks and "Show older" have something to do. The fixture itself
// answers one closed sprint per board, which is all the recap needs. Not shipped.
//
// States: ?theme=light · ?board=error (the second board's sprint list fails)
import { params } from "./preview-fixture.js";

document.documentElement.dataset.theme = params.get("theme") || "dark";

const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const base = globalThis.fetch;
globalThis.fetch = async (input, options = {}) => {
  const url = String(input);
  const closed = /\/board\/(\d+)\/sprint\?.*state=closed/.exec(url);
  if (closed) {
    const board = Number(closed[1]);
    if (params.get("board") === "error" && board === 2) {
      return { ok: false, status: 500, headers: { get: () => null }, json: async () => ({}), text: async () => "Server error" };
    }
    // Twelve fortnights back from about ten days ago.
    const values = Array.from({ length: 12 }, (_, i) => {
      const end = Date.now() - (10 + i * 14) * DAY;
      return {
        id: board * 100 + (40 - i), name: `${["ACME", "PLAT", "DATA"][board - 1]} ${40 - i}`, state: "closed",
        startDate: iso(end - 11 * DAY), endDate: iso(end), completeDate: iso(end + DAY),
      };
    });
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ values, total: values.length }), text: async () => JSON.stringify({ values }) };
  }
  return base(input, options);
};

const { getCredentials } = await import("../js/credentials.js");
const { mount } = await import("../js/views/recap-config.js");
await mount(document.getElementById("view-container"), await getCredentials());
