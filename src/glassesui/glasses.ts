// Glasses display: one full-screen text container that mirrors the web terminal.
// We never send more than one screenful, so the firmware draws no scroll bar; instead
// the container captures touch-bar scroll events (isEventCapture) and we page through
// the saved session transcript ourselves — showPreviousView/showNextView walk a frozen
// snapshot one screenful at a time, and reaching the bottom resumes following the live
// output. A status line (e.g. "● listening") is appended at the end so it sits at the
// bottom; in history a "↕ page/total" indicator takes its place.
//
// NOTE: this intentionally uses a SINGLE container. A previous attempt to pin the
// status to the bottom-right via a second container worked in the simulator but left
// the real glasses blank — the firmware rejects the 2-container startup page, and
// since createStartUpPageContainer may only be called once there's no fallback. Keep
// it to one container.

import {
  CreateStartUpPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import { tailRows, visualRows } from "../utils/textUtils";

const CONTAINER_ID = 1;
const CONTAINER_NAME = "caption"; // max 16 chars
const SCREEN_WIDTH = 576;
const SCREEN_HEIGHT = 288;

// A big rounded border framing the whole view. The container is inset by the
// border width on every side so the stroke stays fully on-screen, and padding
// is widened so text never touches the border.
const BORDER_WIDTH = 1;
const BORDER_RADIUS = 28;
const BORDER_COLOR = 5;
const PADDING = 12;

// We can't command the device's native scroll, so we only ever send the tail that
// fits one screen (see `tailRows`); if we send more, the content overflows the usable
// area and the firmware draws a scroll bar. The usable height is the screen minus the
// border AND the top+bottom padding (288 - 2 - 2*PADDING ≈ 262px), so these counts
// must stay conservative — overshooting by even one row brings the scroll bar back.
// Rough estimates of the default font; tune against the glasses.
const CHARS_PER_LINE = 48; // how many chars fit on one wrapped row
const SCREEN_ROWS = 9; // how many wrapped rows fit vertically (kept low to avoid overflow)

export interface Display {
  // Live update. While the user is following the newest output (the default) this
  // renders the last screenful so the bottom stays visible — the device's scroll
  // can't be driven programmatically, and trimming avoids a scroll bar. `history` is
  // the full session transcript, kept so the touch bar can page back through it.
  // While the user has scrolled into history this only stores the new state; the
  // shown page stays put until they scroll (or `followLive` snaps back).
  render(state: { status: string; text: string; history: string }): Promise<void>;
  // Touch-bar scroll: page one screenful toward older (previous) text. The first
  // call snapshots the transcript so paging stays stable while new text streams in.
  showPreviousView(): Promise<void>;
  // Touch-bar scroll: page one screenful toward newer (next) text; reaching the
  // bottom resumes following the live output.
  showNextView(): Promise<void>;
  // Drop any scrollback and follow the live output again, without rendering. The
  // next `render` (or `showNextView` past the bottom) draws the live view.
  followLive(): void;
}

export async function createDisplay(bridge: EvenAppBridge): Promise<Display> {
  const main = new TextContainerProperty({
    xPosition: BORDER_WIDTH,
    yPosition: BORDER_WIDTH,
    width: SCREEN_WIDTH - BORDER_WIDTH * 2,
    height: SCREEN_HEIGHT - BORDER_WIDTH * 2,
    borderWidth: BORDER_WIDTH,
    borderColor: BORDER_COLOR,
    borderRadius: BORDER_RADIUS,
    paddingLength: PADDING,
    containerID: CONTAINER_ID,
    containerName: CONTAINER_NAME,
    content: "Starting…",
    isEventCapture: 1,
  });

  const result = await bridge.createStartUpPageContainer(
    new CreateStartUpPageContainer({ containerTotalNum: 1, textObject: [main] }),
  );
  if (result !== 0) throw new Error(`createStartUpPageContainer failed: ${result}`);

  // The most recent live state, so a scroll event (which carries no text) can render
  // off it, and so `followLive` can redraw the live view.
  let last = { status: "", text: "", history: "" };
  // Rows scrolled up from the bottom of `frozen`; 0 = bottom-most page.
  let offset = 0;
  // Snapshot of the session transcript taken when the user first scrolls up. Paging
  // works off this fixed copy so the view doesn't drift as new text streams in.
  // `null` = following the live output.
  let frozen: string | null = null;

  // One screenful for history paging. We always reserve a row for the position
  // indicator, matching the live view's reserved status row.
  const VIEW_ROWS = SCREEN_ROWS - 1;

  async function send(content: string) {
    await bridge.textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: CONTAINER_ID,
        containerName: CONTAINER_NAME,
        contentOffset: 0,
        contentLength: content.length,
        content,
      }),
    );
  }

  async function renderLive() {
    // Trim trailing newlines off the body so the status doesn't get pushed down by a
    // dangling blank line.
    let body = last.text.replace(/\n+$/, "");
    // Always keep only the last screenful so the content never overflows the
    // container — that's what makes the device draw a scroll bar. Trimming on
    // every render (not just while generating) keeps the newest text in view and
    // the scroll bar gone. Reserve a row for the status line appended below.
    body = tailRows(body, SCREEN_ROWS - (last.status ? 1 : 0), CHARS_PER_LINE);
    const content = last.status ? (body ? `${body}\n${last.status}` : last.status) : body;
    await send(content);
  }

  async function renderHistory() {
    const rows = visualRows(frozen ?? "", CHARS_PER_LINE);
    const total = rows.length;
    const maxOffset = Math.max(0, total - VIEW_ROWS);
    offset = Math.min(Math.max(offset, 0), maxOffset);
    const end = total - offset; // exclusive; the bottom row of this page
    const start = Math.max(0, end - VIEW_ROWS);
    const windowText = rows.slice(start, end).join("\n");
    // Position indicator: page 1 is the oldest screenful, the last page is the
    // newest. Scrolling down past the last page returns to the live view.
    // Derive page from `end` so non-uniform final pages still reach 1/n.
    const pages = Math.max(1, Math.ceil(total / VIEW_ROWS));
    const pageFromTop = Math.max(1, Math.ceil(end / VIEW_ROWS));
    const indicator = `↕ ${pageFromTop}/${pages}`;
    await send(windowText ? `${windowText}\n${indicator}` : indicator);
  }

  return {
    async render(state) {
      last = state;
      // While paging through history, hold the shown page; just keep the live state
      // current so we can snap back to it later.
      if (frozen === null) await renderLive();
    },

    async showPreviousView() {
      if (frozen === null) {
        const snapshot = last.history.replace(/\n+$/, "");
        // Nothing above the current screen — the whole session already fits.
        if (visualRows(snapshot, CHARS_PER_LINE).length <= VIEW_ROWS) return;
        frozen = snapshot;
        offset = 0;
      }
      offset += VIEW_ROWS;
      await renderHistory();
    },

    async showNextView() {
      if (frozen === null) return; // already following live
      offset -= VIEW_ROWS;
      if (offset <= 0) {
        frozen = null;
        offset = 0;
        await renderLive();
        return;
      }
      await renderHistory();
    },

    followLive() {
      frozen = null;
      offset = 0;
    },
  };
}
