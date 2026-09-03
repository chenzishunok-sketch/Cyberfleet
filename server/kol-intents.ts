export interface KolOutreachInput {
  category?: string;
  minFollowers?: number;
  commissionRate: number;
  message?: string;
  batchSize: number;
  totalTarget: number;
  freeSample: boolean;
}

export type KolIntent =
  | { kind: "status" }
  | { kind: "creators"; category?: string; minFollowers?: number }
  | { kind: "stats" }
  | { kind: "outreach"; input: KolOutreachInput };

function amount(value: string, unit?: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return unit && /万|w/i.test(unit) ? parsed * 10_000 : parsed;
}

function filters(text: string) {
  const category = text.match(/(美妆个护|美妆|服饰|穿搭|数码|3C|母婴|家居|美食|健身|宠物|户外)/i)?.[1];
  const follower = text.match(/粉丝(?:数)?\s*(?:大于|超过|不少于|>|≥)?\s*(\d+(?:\.\d+)?)\s*(万|w)?/i);
  return {
    ...(category ? { category } : {}),
    ...(follower ? { minFollowers: Math.round(amount(follower[1], follower[2])) } : {}),
  };
}

export function parseKolIntent(text: string, kolContext = false): KolIntent | undefined {
  const normalized = text.trim();
  const hasKolSignal = kolContext || /(KOL|达人|博主|主播|建联|邀约)/i.test(normalized);
  if (!hasKolSignal) return undefined;
  if (/(桥接|插件|连接).*(状态|是否|正常|在线)|(?:状态|是否|正常|在线).*(桥接|插件|连接)/i.test(normalized)) return { kind: "status" };
  if (/(数据|统计|效果|成功率|看板|报表)/i.test(normalized) && !/(发送|执行|创建|开始|发起|批量触达)/i.test(normalized)) return { kind: "stats" };
  const selectedFilters = filters(normalized);
  if (/(达人库|达人列表|查看达人|浏览达人|搜索达人|筛选.*达人|达人.*筛选|找达人)/i.test(normalized) && !/(发送|联系|建联|邀约)/i.test(normalized)) {
    return { kind: "creators", ...selectedFilters };
  }
  if (!/(发送|联系|建联|邀约|批量触达|发消息)/i.test(normalized)) return undefined;
  const commission = normalized.match(/(?:佣金\s*[:：]?\s*(\d+(?:\.\d+)?)\s*%|(\d+(?:\.\d+)?)\s*%\s*佣金)/i);
  const target = normalized.match(/(?:给|联系|邀约|建联|触达)\s*(\d+)\s*(?:个|位|名)?/i)
    ?? normalized.match(/(\d+)\s*(?:个|位|名)\s*(?:达人|博主|主播)/i);
  const batch = normalized.match(/(?:每组|每批|一批)\s*(\d+)\s*(?:个|位|名)?/i);
  const quotedMessage = normalized.match(/(?:话术|消息|文案)\s*(?:是|为|用|[:：])\s*["“']([^"”']{2,500})["”']/i)?.[1];
  const trailingMessage = normalized.match(/(?:话术|消息|文案)\s*(?:是|为|用|[:：])\s*([^\n。；;]{2,500})/i)?.[1];
  const message = (quotedMessage ?? trailingMessage)?.trim();
  return {
    kind: "outreach",
    input: {
      ...selectedFilters,
      commissionRate: Number(commission?.[1] ?? commission?.[2] ?? 10),
      ...(message ? { message } : {}),
      batchSize: Math.max(1, Number(batch?.[1] ?? 25)),
      totalTarget: Math.max(1, Number(target?.[1] ?? 50)),
      freeSample: /(免费样品|寄样|送样)/i.test(normalized),
    },
  };
}
