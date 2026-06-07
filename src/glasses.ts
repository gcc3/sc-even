// Glasses display: one full-screen text container that shows a status line, the
// single most recent spoken sentence, and the AI's answer to it.
// createStartUpPageContainer may only be called once, so this sets it up and then
// pushes every later update through textContainerUpgrade.

import {
  CreateStartUpPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";

const CONTAINER_ID = 1;
const CONTAINER_NAME = "caption"; // max 16 chars
const SCREEN_WIDTH = 576;
const SCREEN_HEIGHT = 288;

// How much of the answer to keep on screen. The display is small (576x288), so we
// trim to the most recent characters at a word boundary.
const MAX_ANSWER_CHARS = 300;

export interface Display {
  render(state: { status: string; sentence: string; answer: string }): Promise<void>;
}

export async function createDisplay(bridge: EvenAppBridge): Promise<Display> {
  const main = new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: CONTAINER_ID,
    containerName: CONTAINER_NAME,
    content: "Starting…",
    isEventCapture: 1,
  });

  const result = await bridge.createStartUpPageContainer(
    new CreateStartUpPageContainer({ containerTotalNum: 1, textObject: [main] }),
  );
  if (result !== 0) throw new Error(`createStartUpPageContainer failed: ${result}`);

  return {
    async render({ status, sentence, answer }) {
      // One sentence (what was just said) plus the AI answer beneath it.
      const lines: string[] = [];
      if (status) lines.push(status);
      if (sentence) lines.push(sentence);
      if (answer) lines.push(trimTail(answer, MAX_ANSWER_CHARS));
      const content = lines.join("\n");
      await bridge.textContainerUpgrade(
        new TextContainerUpgrade({
          containerID: CONTAINER_ID,
          containerName: CONTAINER_NAME,
          contentOffset: 0,
          contentLength: content.length,
          content,
        }),
      );
    },
  };
}

function trimTail(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(text.length - max);
  const space = cut.indexOf(" ");
  return space > 0 ? cut.slice(space + 1) : cut;
}
