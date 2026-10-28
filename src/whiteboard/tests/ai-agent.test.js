import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_TOOLS,
  boardInfo,
  executeBoardTool,
  findObjects,
  parseAgentReply,
  readObject,
} from "../src/ai/agent.js";
import { item } from "../src/model.js";

function context(items = [], initial = new Set(), editable = true) {
  const board = { title: "Launch", items };
  let selection = new Set(initial);
  return {
    board,
    get selection() {
      return selection;
    },
    ctx: {
      board: () => board,
      view: () => ({ items: board.items }),
      selection: () => selection,
      language: "en",
      center: () => ({ x: 0, y: 0 }),
      mutate: (change) => change(),
      select: (ids) => {
        selection = new Set(ids);
      },
      canEdit: () => editable,
    },
  };
}

test("whiteboard agent protocol", async (t) => {
  await t.test(
    "reads one tool call, including a fenced or wrapped object",
    () => {
      assert.deepEqual(parseAgentReply('{"tool":"get_board","args":{}}'), {
        tool: "get_board",
        args: {},
      });
      assert.deepEqual(
        parseAgentReply(
          '```json\n{"tool":"find_objects","args":{"query":"risk"}}\n```',
        ),
        { tool: "find_objects", args: { query: "risk" } },
      );
      assert.deepEqual(parseAgentReply('I will look.\n{"tool":"get_board"}'), {
        tool: "get_board",
        args: {},
      });
      assert.deepEqual(parseAgentReply('{"message":"All done."}'), {
        tool: "finish",
        args: { message: "All done." },
      });
      // Prose is a final answer, not a parser error.
      assert.equal(parseAgentReply("I added three notes.").tool, "finish");
      assert.throws(() => parseAgentReply("  "), /returned nothing/);
    },
  );

  await t.test(
    "summarizes and finds objects without sending the whole board",
    () => {
      const note = item("note", 10, 20, {
        text: "Launch risk",
        w: 200,
        h: 100,
      });
      const frame = item("frame", 0, 0, { text: "Risks", w: 400, h: 300 });
      const c = context([note, frame]);
      assert.deepEqual(boardInfo(c.ctx), {
        title: "Launch",
        objects: 2,
        counts: { note: 1, frame: 1 },
        selected: 0,
        bounds: { x: 0, y: 0, w: 400, h: 300 },
      });
      assert.deepEqual(findObjects(c.ctx, { query: "risk" }), {
        total: 2,
        items: [
          {
            id: note.id,
            type: "note",
            text: "Launch risk",
            x: 10,
            y: 20,
            w: 200,
            h: 100,
            color: "#f6e7a4",
          },
          {
            id: frame.id,
            type: "frame",
            text: "Risks",
            x: 0,
            y: 0,
            w: 400,
            h: 300,
            color: "#f6e7a4",
          },
        ],
      });
      assert.equal(findObjects(c.ctx, { type: "note" }).items.length, 1);
      assert.equal(readObject(c.ctx, note.id).text, "Launch risk");
      assert.throws(() => readObject(c.ctx, "missing"), /no object/);
    },
  );

  await t.test(
    "adds, updates, arranges, frames and deletes through the board model",
    () => {
      const c = context();
      const added = executeBoardTool(
        "add_notes",
        {
          notes: [{ text: "One" }, { text: "Two", color: "blue" }],
          columns: 2,
        },
        c.ctx,
      );
      assert.equal(added.ok, true);
      assert.equal(c.board.items.length, 2);
      assert.deepEqual(
        c.board.items.map((i) => i.text),
        ["One", "Two"],
      );
      assert.equal(c.selection.size, 2);

      const ids = c.board.items.map((i) => i.id);
      const updated = executeBoardTool(
        "update_objects",
        { objects: [{ id: ids[0], text: "One changed", x: 50 }] },
        c.ctx,
      );
      assert.equal(updated.ok, true);
      assert.equal(c.board.items[0].text, "One changed");
      assert.equal(c.board.items[0].x, 50);

      const arranged = executeBoardTool(
        "arrange_grid",
        { ids, columns: 2, gap: 20 },
        c.ctx,
      );
      assert.equal(arranged.ok, true);
      assert.equal(arranged.result.arranged, 2);
      assert.equal(arranged.result.columns, 2);

      const framed = executeBoardTool(
        "create_frame",
        { ids, title: "Ideas" },
        c.ctx,
      );
      assert.equal(framed.ok, true);
      const frame = c.board.items.find((i) => i.type === "frame");
      assert.equal(frame.text, "Ideas");
      assert.equal(
        c.board.items.filter((i) => i.parentId === frame.id).length,
        2,
      );

      const deleted = executeBoardTool(
        "delete_objects",
        { ids: [ids[0]] },
        c.ctx,
      );
      assert.equal(deleted.ok, true);
      assert.equal(deleted.result.deleted, 1);
      assert.equal(
        c.board.items.some((i) => i.id === ids[0]),
        false,
      );
    },
  );

  await t.test(
    "refuses writes on a read-only board and reports unknown tools",
    () => {
      const c = context([], new Set(), false);
      const refused = executeBoardTool(
        "add_notes",
        { notes: [{ text: "No" }] },
        c.ctx,
      );
      assert.equal(refused.ok, false);
      assert.equal(c.board.items.length, 0);
      assert.deepEqual(executeBoardTool("nope", {}, c.ctx), {
        ok: false,
        error: "There is no tool called nope.",
      });
      assert.match(AGENT_TOOLS, /finish/);
    },
  );
});
