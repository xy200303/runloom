import { describe, expect, it } from "vitest";
import { createRunloomAgent } from "../src/index.js";

describe("A2A peers", () => {
  it("registers and lists A2A peers through the public agent API", async () => {
    const agent = await createRunloomAgent({
      provider: "openai-responses",
      model: "gpt-4.1",
      workspace: process.cwd(),
      apiKey: ""
    });
    const eventTypes: string[] = [];
    agent.subscribe((event) => eventTypes.push(event.type));

    try {
      const capabilities = [
        {
          name: "summarize-docs",
          description: "Summarize project documentation",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" }
        }
      ];

      expect(await agent.listA2APeers()).toEqual([]);
      await agent.registerA2APeer({
        id: "docs",
        name: "Documentation Agent",
        version: "0.1.0",
        endpoint: "http://127.0.0.1:43120/a2a",
        transport: "http",
        enabled: true,
        status: "available",
        capabilities
      });
      await agent.registerA2APeer({
        id: "review",
        name: "Code Review Agent",
        transport: "custom",
        enabled: false,
        status: "disabled",
        capabilities: [{ name: "review-code" }]
      });
      capabilities[0].inputSchema = { type: "string" };

      const peers = await agent.listA2APeers();
      expect(peers.map((peer) => peer.name)).toEqual(["Code Review Agent", "Documentation Agent"]);
      expect(peers[1]).toMatchObject({
        id: "docs",
        name: "Documentation Agent",
        version: "0.1.0",
        endpoint: "http://127.0.0.1:43120/a2a",
        transport: "http",
        enabled: true,
        status: "available",
        capabilities: [
          {
            name: "summarize-docs",
            description: "Summarize project documentation",
            inputSchema: { type: "object" },
            outputSchema: { type: "object" }
          }
        ]
      });
      expect(eventTypes).toEqual(["a2a.peer.discovered", "a2a.peer.discovered"]);
    } finally {
      await agent.close();
    }
  });
});
