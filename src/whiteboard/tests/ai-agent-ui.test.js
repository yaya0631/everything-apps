import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createAI } from "../src/ai/ai-ui.js";
import { board, item } from "../src/model.js";

test("the whiteboard agent runs board tools, then shows the model's finish message", async () => {
  const b = board("Launch");
  b.items = [item("note", 0, 0, { id: "n1", text: "Existing note" })];
  const prompts = [];
  const replies = [
    JSON.stringify({
      tool: "add_notes",
      args: { notes: [{ text: "Risk one" }, { text: "Risk two" }], columns: 2 },
    }),
    JSON.stringify({
      tool: "finish",
      args: { message: "Added the two risks." },
    }),
  ];
  const dom = new JSDOM(
    "<dialog><div id='ai-work'></div><p id='ai-status'></p></dialog>",
  );
  const ai = createAI({
    org: {
      info: { role: "member", policy: { ai: { enabled: true } } },
      allows: () => true,
      request: async (op, data) => {
        prompts.push(data.prompt);
        return { text: replies.shift() };
      },
    },
    session: () => null,
    board: () => b,
    view: () => b,
    selection: () => new Set(),
    modal: () => null,
    toast: () => {},
    icon: () => "",
    mutate: (change) => change(),
    center: () => ({ x: 0, y: 0 }),
    select: () => {},
    canEdit: () => true,
    puter: () => null,
  });
  globalThis.document = dom.window.document;
  try {
    const d = dom.window.document.querySelector("dialog");
    d.close = () => {};
    await ai.agent(d);
    const form = d.querySelector("#ai-agent");
    assert.ok(form, "the agent form opens in the dialog");
    form.querySelector("textarea").value = "Add two risks in a row at the top.";
    await form.onsubmit({ preventDefault() {} });
    assert.deepEqual(b.items.map((i) => i.text).sort(), [
      "Existing note",
      "Risk one",
      "Risk two",
    ]);
    assert.equal(prompts.length, 2);
    assert.match(prompts[0], /Add two risks/);
    assert.match(prompts[1], /Tool add_notes result/);
    assert.match(
      d.querySelector("#ai-agent-result").textContent,
      /Added the two risks/,
    );
    assert.match(
      d.querySelector("#ai-agent-result").textContent,
      /1 tool step changed the board/,
    );
  } finally {
    delete globalThis.document;
  }
});

test("the whiteboard assistant offers the server's tool models and sends the chosen one", async () => {
  const dom = new JSDOM("<!doctype html><body></body>", {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "localStorage", "HTMLElement"];
  const previous = Object.fromEntries(keys.map((key) => [key, globalThis[key]]));
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const b = board("Launch");
    const chats = [];
    let d;
    const ai = createAI({
      org: { info: null, allows: () => true },
      session: () => null,
      board: () => b,
      view: () => b,
      selection: () => new Set(),
      modal(title, html, init) {
        d = document.createElement("dialog");
        d.innerHTML = html;
        d.close = () => {};
        document.body.append(d);
        init(d);
        return d;
      },
      icon: () => "",
      mutate: (change) => change(),
      center: () => ({ x: 0, y: 0 }),
      select: () => {},
      canEdit: () => true,
      toast: () => {},
      puter: () => ({
        ai: {
          models: async () => [
            { id: "no-tools", label: "No tools", tools: false },
            { id: "tools-a", label: "Tools A" },
            { id: "tools-b", label: "Tools B", tools: true },
          ],
          chat: async (...args) => {
            chats.push(args);
            return "Summary";
          },
        },
        auth: { isSignedIn: () => true },
      }),
    });
    ai.open();
    const field = d.querySelector("#ai-model-field");
    const select = d.querySelector("#ai-model");
    assert.ok(field, "the model field exists for a personal board");
    assert.ok(select, "the model select exists");
    assert.equal(field.hidden, true, "the field stays hidden until models arrive");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(field.hidden, false);
    assert.deepEqual(
      [...select.options].map((option) => option.value),
      ["tools-a", "tools-b"],
      "models that cannot call tools are not offered",
    );
    assert.equal(select.value, "tools-a");
    select.value = "tools-b";
    select.dispatchEvent(new dom.window.Event("change"));
    assert.equal(
      localStorage.getItem("whiteboard:assistant:model"),
      "tools-b",
      "the choice is remembered",
    );
    assert.equal(await ai.ask("summarize", "x"), "Summary");
    assert.equal(chats[0][2].model, "tools-b");
  } finally {
    for (const key of keys) globalThis[key] = previous[key];
  }
});
