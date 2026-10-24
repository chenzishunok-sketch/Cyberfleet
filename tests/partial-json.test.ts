import { describe, expect, it } from "vitest";
import { extractPartialStringField } from "../server/partial-json.ts";

// 这组用例守的是一个体感问题：模型回答时，正文在 tool_call 的 arguments 里，
// 而 arguments 是边生成边到达的（实测一次 300 多片）。如果只认完整 JSON，
// 用户就要等模型把整段答案写完才看到第一个字。
describe("extractPartialStringField", () => {
  it("完整 JSON 能取出字段", () => {
    expect(extractPartialStringField('{"content":"库存还有 4053 件","followUps":[]}', "content")).toBe("库存还有 4053 件");
  });

  it("JSON 还没闭合时返回已生成的部分（这就是流式的关键）", () => {
    expect(extractPartialStringField('{"content":"库存还', "content")).toBe("库存还");
    // 冒号到了但引号还没到：值还没开始，返回 undefined 而不是空串
    expect(extractPartialStringField('{"content":', "content")).toBeUndefined();
    expect(extractPartialStringField('{"cont', "content")).toBeUndefined();
  });

  it("正确处理转义：换行、引号、反斜杠", () => {
    expect(extractPartialStringField('{"content":"第一行\\n第二行', "content")).toBe("第一行\n第二行");
    expect(extractPartialStringField('{"content":"他说\\"好\\"","x":1}', "content")).toBe('他说"好"');
    expect(extractPartialStringField('{"content":"C:\\\\tmp","x":1}', "content")).toBe("C:\\tmp");
  });

  it("转义序列没收全时停在它前面，不吐半个字符", () => {
    // \u 后面只到了 3 位十六进制，不能猜
    expect(extractPartialStringField('{"content":"库存\\u4e', "content")).toBe("库存");
    // 结尾只有一个反斜杠
    expect(extractPartialStringField('{"content":"库存\\', "content")).toBe("库存");
  });

  it("unicode 转义能正确还原成中文", () => {
    expect(extractPartialStringField('{"content":"\\u5e93\\u5b58"}', "content")).toBe("库存");
    // 代理对（emoji）分两段拼起来
    expect(extractPartialStringField('{"content":"\\ud83d\\ude00"}', "content")).toBe("😀");
  });

  it("字段不存在或不是字符串时返回 undefined", () => {
    expect(extractPartialStringField('{"followUps":[]}', "content")).toBeUndefined();
    expect(extractPartialStringField('{"content":123}', "content")).toBeUndefined();
  });

  it("不误取同名子串（content 与 contentX）", () => {
    expect(extractPartialStringField('{"contentX":"错的","content":"对的"}', "content")).toBe("对的");
  });
});
