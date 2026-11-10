import { describe, expect, it } from "vitest";
import {
  detectIntent,
  findContainer,
  isKnownContainer,
  nameKey,
  resolveContainerMentions,
} from "../../../src/server/agent/mentions.js";

const NAMES = ["plex", "pihole", "homeassistant", "nginx-proxy", "uptime-kuma"];

describe("resolveContainerMentions", () => {
  it("matches case-insensitively", () => {
    expect(resolveContainerMentions("Is the PLEX server feeling okay?", NAMES)).toEqual(["plex"]);
  });

  it("treats spaces, hyphens, and underscores as equivalent", () => {
    expect(resolveContainerMentions("How is Pi hole doing?", NAMES)).toEqual(["pihole"]);
    expect(resolveContainerMentions("check pi-hole", NAMES)).toEqual(["pihole"]);
    expect(resolveContainerMentions("is home assistant alive", NAMES)).toEqual(["homeassistant"]);
    expect(resolveContainerMentions("restart nginx proxy", NAMES)).toEqual(["nginx-proxy"]);
    expect(resolveContainerMentions("look at nginx_proxy", NAMES)).toEqual(["nginx-proxy"]);
    expect(resolveContainerMentions("uptimekuma status", NAMES)).toEqual(["uptime-kuma"]);
  });

  it("matches whole words only", () => {
    expect(resolveContainerMentions("the plexus of wires", NAMES)).toEqual([]);
    expect(resolveContainerMentions("supplex", NAMES)).toEqual([]);
    expect(resolveContainerMentions("nginx alone", NAMES)).toEqual([]);
  });

  it("handles punctuation and possessives around names", () => {
    expect(resolveContainerMentions("plex's logs?", NAMES)).toEqual(["plex"]);
    expect(resolveContainerMentions("(pihole)", NAMES)).toEqual(["pihole"]);
  });

  it("orders by first mention and removes duplicates", () => {
    expect(resolveContainerMentions("pihole, then plex, then pihole again", NAMES)).toEqual([
      "pihole",
      "plex",
    ]);
  });

  it("accepts ContainerInfo-like objects and returns original names", () => {
    const containers = [{ name: "My_App" }, { name: "plex" }];
    expect(resolveContainerMentions("what about my app", containers)).toEqual(["My_App"]);
  });

  it("returns nothing for empty inputs", () => {
    expect(resolveContainerMentions("", NAMES)).toEqual([]);
    expect(resolveContainerMentions("plex", [])).toEqual([]);
  });
});

describe("findContainer / isKnownContainer", () => {
  it("resolves exact names under normalization", () => {
    expect(findContainer("Pi hole", NAMES)).toBe("pihole");
    expect(findContainer("Nginx_Proxy", NAMES)).toBe("nginx-proxy");
    expect(findContainer("plex", NAMES)).toBe("plex");
  });

  it("resolves a container named inside a longer phrase", () => {
    expect(findContainer("the plex server", NAMES)).toBe("plex");
  });

  it("returns undefined for unknown names", () => {
    expect(findContainer("jellyfin", NAMES)).toBeUndefined();
    expect(findContainer("plexus", NAMES)).toBeUndefined();
    expect(findContainer("", NAMES)).toBeUndefined();
    expect(findContainer("---", NAMES)).toBeUndefined();
    expect(isKnownContainer("jellyfin", NAMES)).toBe(false);
    expect(isKnownContainer("PIHOLE", NAMES)).toBe(true);
  });

  it("nameKey drops separators and case", () => {
    expect(nameKey("Nginx-Proxy")).toBe("nginxproxy");
    expect(nameKey("home assistant")).toBe(nameKey("homeassistant"));
  });
});

describe("detectIntent", () => {
  it("detects summarize words as whole words, case-insensitively", () => {
    expect(detectIntent("Summarize the plex logs")).toBe("summarize");
    expect(detectIntent("please summarise pihole")).toBe("summarize");
    expect(detectIntent("give me a summary of nginx-proxy")).toBe("summarize");
    expect(detectIntent("show LOGS for plex")).toBe("summarize");
  });

  it("treats everything else as chat", () => {
    expect(detectIntent("Is the Plex server feeling okay?")).toBe("chat");
    expect(detectIntent("summaryless blogs")).toBe("chat");
    expect(detectIntent("")).toBe("chat");
  });
});
