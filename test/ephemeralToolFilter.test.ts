import { assert } from "chai";
import { EPHEMERAL_PAPER_CONVERSATION_KEY_BASE } from "../src/shared/conversationKeySpace";
import { isToolWithheldForEphemeralRequest } from "../src/agent/tools/registry";

describe("isToolWithheldForEphemeralRequest", function () {
  const write = { spec: { executionClass: "external_effect" } } as never;
  const read = { spec: { executionClass: "read" } } as never;
  const ephemeral = { conversationKey: EPHEMERAL_PAPER_CONVERSATION_KEY_BASE };
  const durable = { conversationKey: 1_000_000_001 };

  it("withholds external-effect tools from an ephemeral key only", function () {
    assert.isTrue(isToolWithheldForEphemeralRequest(write, ephemeral));
    assert.isFalse(isToolWithheldForEphemeralRequest(write, durable));
    assert.isFalse(isToolWithheldForEphemeralRequest(read, ephemeral));
  });
});
