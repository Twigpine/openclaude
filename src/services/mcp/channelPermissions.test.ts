import { describe, expect, test } from "bun:test";
import {
  channelPermissionRequestId,
  createChannelPermissionCallbacks,
  truncateForPreview,
} from "./channelPermissions.js";

describe("channelPermissions", () => {
  test("keeps equal tool-use IDs from concurrent subagents distinct", () => {
    const callbacks = createChannelPermissionCallbacks();
    const first = channelPermissionRequestId("call_1", "session-a", "agent-a");
    const second = channelPermissionRequestId("call_1", "session-a", "agent-b");
    const resolved: string[] = [];

    expect(first).not.toBe(second);
    callbacks.onResponse(first, () => resolved.push("agent-a"));
    callbacks.onResponse(second, () => resolved.push("agent-b"));

    expect(callbacks.resolve(first, "allow", "channel")).toBe(true);
    expect(callbacks.resolve(second, "deny", "channel")).toBe(true);
    expect(resolved).toEqual(["agent-a", "agent-b"]);
  });

  describe("truncateForPreview", () => {
    test("redacts DATABASE_PASSWORD=correct&horse=battery fully in command objects", () => {
      const input = { command: "export DATABASE_PASSWORD=correct&horse=battery" };
      const result = truncateForPreview(input);
      expect(result).toContain("DATABASE_PASSWORD");
      expect(result).not.toContain("correct");
      expect(result).not.toContain("horse=battery");
      expect(result).toContain("[REDACTED]");
    });

    test("redacts x-api-key=abc&def=ghi in command objects", () => {
      const input = { command: "export x-api-key=abc&def=ghi" };
      const result = truncateForPreview(input);
      expect(result).toContain("x-api-key");
      expect(result).not.toContain("abc");
      expect(result).not.toContain("def=ghi");
    });

    test("preserves safe URL parameters inside URL query strings", () => {
      const input = { url: "https://example.com/v1?OPENAI_API_KEY=secret&mode=test" };
      const result = truncateForPreview(input);
      expect(result).toContain("https://example.com/v1?OPENAI_API_KEY=redacted&mode=test");
    });
  });
});
