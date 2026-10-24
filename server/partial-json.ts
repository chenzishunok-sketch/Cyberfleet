/**
 * 从「还没写完」的 JSON 文本里，取出某个字符串字段当前已经到位的值。
 *
 * 为什么需要它：模型用 tool_call 回答时，正文放在 arguments 的 content 字段里，
 * 而 arguments 是一段边生成边到达的 JSON 字符串（实测一次回答分 300 多片）。
 * 如果等整段 JSON 收完再解析，用户就要干等模型写完才看到第一个字。
 * 这个函数允许在 JSON 还没闭合时先拿到已生成的部分，把增量推给前端。
 *
 * 设计原则：只认「安全的部分」。遇到还不完整的转义序列（如刚读到 `\u12`）
 * 就停在它前面，等下一片数据再继续，绝不猜一个字符出去。
 */
export function extractPartialStringField(json: string, field: string): string | undefined {
  const key = `"${field}"`;
  let index = json.indexOf(key);
  if (index < 0) return undefined;
  index += key.length;

  while (index < json.length && /\s/.test(json[index] ?? "")) index += 1;
  if (json[index] !== ":") return undefined;
  index += 1;
  while (index < json.length && /\s/.test(json[index] ?? "")) index += 1;
  if (json[index] !== '"') return undefined;
  index += 1;

  let out = "";
  while (index < json.length) {
    const char = json[index] ?? "";
    if (char === '"') return out;
    if (char !== "\\") {
      out += char;
      index += 1;
      continue;
    }

    const escaped = json[index + 1];
    // 转义符刚到、后面还没跟字符：等下一片
    if (escaped === undefined) return out;
    switch (escaped) {
      case '"': out += '"'; index += 2; break;
      case "\\": out += "\\"; index += 2; break;
      case "/": out += "/"; index += 2; break;
      case "b": out += "\b"; index += 2; break;
      case "f": out += "\f"; index += 2; break;
      case "n": out += "\n"; index += 2; break;
      case "r": out += "\r"; index += 2; break;
      case "t": out += "\t"; index += 2; break;
      case "u": {
        const hex = json.slice(index + 2, index + 6);
        // 码点还没收全或不是合法十六进制：停在这里，等下一片
        if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) return out;
        out += String.fromCharCode(Number.parseInt(hex, 16));
        index += 6;
        break;
      }
      default:
        // 未知转义，不再往下猜
        return out;
    }
  }
  // JSON 还没走到 content 的结束引号：返回已生成的部分
  return out;
}
