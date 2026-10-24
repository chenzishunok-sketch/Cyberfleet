import { describe, expect, it } from "vitest";
import { isShellAnswer } from "../server/response-presentation.ts";

// 这组用例守的是一个已经踩过的坑：
// ReAct 已经查到数据，模型却只回一句「已分析」，而当时的收敛逻辑把这句话原样当回答返回，
// 用户看到的就是"答了，但没有任何结果"。isShellAnswer 只负责把这种「只确认动作、没有内容」的句子认出来，
// 认出来之后由调用方打回模型重写，不在这里替模型写答案。
describe("isShellAnswer", () => {
  it("把只有动作确认、没有任何内容的句子判为空壳", () => {
    for (const text of [
      "已分析",
      "已分析。",
      "分析完成",
      "已完成分析",
      "已完成多步分析。",
      "任务完成",
      "处理成功",
      "已完成",
      "我已读取数据",
      "已调用接口",
      "请查看上方结果",
      "好的",
      "收到。",
      "respond",
    ]) {
      expect(isShellAnswer(text), text).toBe(true);
    }
  });

  it("空内容和纯空白也算空壳", () => {
    expect(isShellAnswer("")).toBe(true);
    expect(isShellAnswer("   \n  ")).toBe(true);
    expect(isShellAnswer(undefined)).toBe(true);
    expect(isShellAnswer(null)).toBe(true);
  });

  it("短但拿到了事实的回答不算空壳", () => {
    // 用户问「库存多少」，一句具体的数字就是完整回答，不能因为字少就拦
    expect(isShellAnswer("浴室地垫现在库存 4053 件。")).toBe(false);
    expect(isShellAnswer("近 7 天卖了 94 件，退款 3 单。")).toBe(false);
  });

  it("正常的能力介绍不算空壳", () => {
    // 曾经的质量门把这类回答判成「泛化能力清单」再整段改写成兜底，用户反馈答非所问。
    // 这里必须守住：自我介绍是有效回答。
    expect(isShellAnswer("我可以帮你看店铺销售、库存和选品，你想先看哪一块？")).toBe(false);
    expect(isShellAnswer("我可以查询经营数据，也可以帮你准备改价和改库存的计划。")).toBe(false);
  });

  it("多段正文一律不算空壳", () => {
    expect(isShellAnswer("结论先说：近 30 天在上升。\n\n依据：订单从 1000 涨到 2101。")).toBe(false);
  });
});
