import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateAgnesImage } from "../server/agnes-client.ts";
import { contentImageDimensions } from "../shared/content.ts";

beforeEach(() => {
  vi.stubEnv("AGNES_API_KEY", "test-image-key");
  vi.stubEnv("AGNES_BASE_URL", "https://apihub.agnes-ai.com/v1/");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function mockImage(data: Record<string, unknown>) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: [data] })));
}

describe("Agnes Image 2.0 integration", () => {
  it("sends documented text-to-image parameters and converts UI dimensions", async () => {
    const fetchMock = mockImage({ url: "https://example.com/image.png" });
    await expect(generateAgnesImage({ prompt: "产品白底图", ratio: "3:4", size: "1K" })).resolves.toEqual({ url: "https://example.com/image.png" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://apihub.agnes-ai.com/v1/images/generations");
    expect(JSON.parse(String(init?.body))).toEqual({ model: "agnes-image-2.0-flash", prompt: "产品白底图", size: "768x1024", extra_body: { response_format: "url" } });
    expect(init?.headers).toMatchObject({ authorization: "Bearer test-image-key" });
  });

  it("passes multiple references under extra_body.image without tags", async () => {
    const fetchMock = mockImage({ url: "https://example.com/edit.png" });
    const images = ["data:image/png;base64,aGVsbG8=", "https://example.com/reference.png"];
    await generateAgnesImage({ prompt: "将两张产品合成展示", ratio: "9:16", size: "2K", images });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ model: "agnes-image-2.0-flash", prompt: "将两张产品合成展示", size: "1152x2048", extra_body: { image: images, response_format: "url" } });
  });

  it("accepts Base64 image responses", async () => {
    mockImage({ url: null, b64_json: "aGVsbG8=" });
    await expect(generateAgnesImage({ prompt: "产品图", ratio: "1:1", size: "1K" })).resolves.toEqual({ url: "data:image/png;base64,aGVsbG8=" });
  });

  it("surfaces provider error messages", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: { message: "Model unavailable" } }), { status: 400 }));
    await expect(generateAgnesImage({ prompt: "产品图", ratio: "1:1", size: "1K" })).rejects.toThrow("Model unavailable");
  });

  it("rejects empty results instead of saving a completed task", async () => {
    mockImage({ url: null, b64_json: null });
    await expect(generateAgnesImage({ prompt: "产品图", ratio: "1:1", size: "1K" })).rejects.toThrow("没有返回图片地址");
  });

  it("validates dimensions before calling the provider", async () => {
    const fetchMock = mockImage({ url: "https://example.com/image.png" });
    await expect(generateAgnesImage({ prompt: "产品图", ratio: "invalid", size: "1K" })).rejects.toThrow("不支持");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(contentImageDimensions("1:1", "4K")).toBe("4096x4096");
    expect(contentImageDimensions("4:3", "1K")).toBe("1024x768");
  });
});
