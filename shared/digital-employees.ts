export const AGENT_CONTEXTS = [
  "general",
  "product",
  "pricing",
  "sourcing",
  "collection",
  "publishing",
  "kol",
  "content",
  "supply",
] as const;

export type AgentContext = typeof AGENT_CONTEXTS[number];
export type AgentCategory = "运营" | "商品" | "增长" | "履约" | "内容";
type AgentStatus = "ready" | "foundation" | "planned";
export type AgentConnection = "tiktok" | "miaoshou" | "tmapi" | "kolBridge";

export interface DigitalEmployee {
  id: AgentContext;
  name: string;
  shortName: string;
  category: AgentCategory;
  status: AgentStatus;
  description: string;
  capabilities: readonly string[];
  /** 该 Agent 允许使用的工具名称列表；"*" 表示拥有全部工具权限（仅运营总监） */
  allowedTools: readonly string[];
  welcome: string;
  followUps: readonly string[];
  placeholder: string;
  workingLabel: string;
  connection?: AgentConnection;
  featured?: boolean;
}

export const DIGITAL_EMPLOYEES: readonly DigitalEmployee[] = [
  {
    id: "general",
    name: "运营总监 Agent",
    shortName: "运营总监",
    category: "运营",
    status: "ready",
    featured: true,
    description: "理解经营目标，拆解任务并调度合适的数字员工，最后汇总业务结果。",
    capabilities: ["任务拆解", "跨 Agent 调度", "结果汇总与审批"],
    allowedTools: ["*"],
    welcome: "今天想先处理什么？我会判断由哪个数字员工执行，并在需要修改数据时先让你确认。",
    followUps: ["检查当前最需要处理的经营问题", "查看最近业务任务", "分析最近 7 天店铺表现"],
    placeholder: "描述你的经营目标，我会安排合适的数字员工…",
    workingLabel: "正在拆解目标并调度数字员工",
  },
  {
    id: "product",
    name: "商品管理 Agent",
    shortName: "商品管理",
    category: "商品",
    status: "ready",
    connection: "tiktok",
    description: "统一管理每个 SKU 的商品资料、成本、利润、结算记录和表格导出。",
    capabilities: ["SKU 台账", "成本补全", "结算与导出"],
    allowedTools: ["list_products", "explain_product_operations", "prepare_inventory_update", "prepare_price_update", "get_workflow_status", "respond"],
    welcome: "这里是商品管理 Agent。可以查询 SKU 台账、缺失成本、利润和实际结算记录。",
    followUps: ["查询哪些商品还缺成本", "找出预计亏损的商品", "导出全部 SKU 利润表"],
    placeholder: "查询商品、SKU、成本、利润或结算…",
    workingLabel: "正在核对商品和 SKU 台账",
  },
  {
    id: "pricing",
    name: "定价 Agent",
    shortName: "定价",
    category: "商品",
    status: "foundation",
    connection: "tiktok",
    description: "根据采购、物流、平台费用和目标利润计算保本价与价格方案。",
    capabilities: ["保本价", "利润测算", "成本修改审批"],
    allowedTools: ["list_products", "explain_product_operations", "prepare_price_update", "get_workflow_status", "respond"],
    welcome: "这里是定价 Agent。可以计算保本价、检查亏损，并通过审批卡修改本地成本参数。",
    followUps: ["找出预计亏损的商品", "查询哪些商品还缺成本", "导出全部 SKU 利润表"],
    placeholder: "询问保本价、利润，或调整某个 SKU 的成本…",
    workingLabel: "正在读取成本并重新计算利润",
  },
  {
    id: "sourcing",
    name: "选品 Agent",
    shortName: "选品",
    category: "商品",
    status: "foundation",
    connection: "tmapi",
    description: "通过图片或 1688 商品识别货源，并结合泰国店铺成本筛选候选商品。",
    capabilities: ["以图搜同款", "1688 货源读取", "候选利润估算"],
    allowedTools: ["start_supplier_publish_workflow", "get_workflow_status", "respond"],
    welcome: "这里是选品 Agent。上传商品图片或提供 1688 链接，我会读取真实货源并估算泰国店铺利润。",
    followUps: ["帮我找这张图片的1688同款", "检查一个1688商品的SKU和采购价"],
    placeholder: "上传图片，或输入 1688 商品链接进行选品…",
    workingLabel: "正在搜索货源并比较候选商品",
  },
  {
    id: "collection",
    name: "采集 Agent",
    shortName: "采集",
    category: "履约",
    status: "ready",
    connection: "miaoshou",
    description: "把确认过的供应商商品采集到妙手公共采集箱，并保存来源关系。",
    capabilities: ["1688 链接采集", "公共采集箱", "来源编号追踪"],
    allowedTools: ["start_supplier_publish_workflow", "get_workflow_status", "respond"],
    welcome: "这里是采集 Agent。提供 1688 商品链接后，我会先生成审核卡，再采集到妙手公共采集箱。",
    followUps: ["查看公共采集箱", "查看最近的妙手采集任务"],
    placeholder: "粘贴 1688 链接，或查询妙手采集箱…",
    workingLabel: "正在核对货源和妙手采集状态",
  },
  {
    id: "publishing",
    name: "上架 Agent",
    shortName: "上架",
    category: "履约",
    status: "ready",
    connection: "miaoshou",
    description: "串联采集、认领、类目资料、定价、发布和结果回查，支持失败恢复。",
    capabilities: ["妙手认领", "商品资料补全", "TikTok 发布回查"],
    allowedTools: ["start_supplier_publish_workflow", "get_workflow_status", "approve_workflow", "retry_workflow", "verify_workflow", "respond"],
    welcome: "这里是上架 Agent。提供 1688 链接和目标后，我会建立可恢复的完整上架任务，每次真实写入前都会让你确认。",
    followUps: ["查看最近业务任务", "查看TikTok采集箱待发布商品"],
    placeholder: "输入上架目标、1688 链接，或查询发布进度…",
    workingLabel: "正在检查上架任务和平台状态",
  },
  {
    id: "kol",
    name: "达人 BD Agent",
    shortName: "达人 BD",
    category: "增长",
    status: "ready",
    connection: "kolBridge",
    description: "筛选达人、读取达人库、创建建联任务并跟踪邀约结果。",
    capabilities: ["达人筛选", "批量建联", "建联数据"],
    allowedTools: ["get_kol_bridge_status", "list_kol_creators", "get_kol_stats", "start_kol_outreach_workflow", "get_workflow_status", "approve_workflow", "retry_workflow", "verify_workflow", "respond"],
    welcome: "这里是达人 BD Agent。可以读取真实达人库和建联数据，也可以根据条件生成邀约任务。真正发送前会让你确认。",
    followUps: ["查看达人库", "查看达人建联数据", "筛选粉丝超过 10 万的美妆达人"],
    placeholder: "筛选达人、查看数据，或创建建联任务…",
    workingLabel: "正在读取达人数据并核对建联条件",
  },
  {
    id: "content",
    name: "内容 Agent",
    shortName: "内容",
    category: "内容",
    status: "ready",
    description: "生成商品标题、卖点、图片和短视频，并把所有成品统一保存到本地资产库。",
    capabilities: ["标题与脚本", "商品图片", "关键帧视频"],
    allowedTools: ["list_products", "respond"],
    welcome: "这里是内容 Agent。可以创作标题、卖点、脚本、商品图片和短视频，生成结果会自动保存到资产库。",
    followUps: ["为商品生成泰语标题", "制作一张9:16商品宣传图", "根据商品图片生成5秒短视频"],
    placeholder: "描述想创作的文字、图片或视频…",
    workingLabel: "正在创作内容并整理素材",
  },
  {
    id: "supply",
    name: "供应链 Agent",
    shortName: "供应链",
    category: "履约",
    status: "planned",
    description: "管理供应商、采购、库存、物流成本和补货建议。",
    capabilities: ["供应商管理", "采购跟踪", "库存与补货"],
    allowedTools: ["respond"],
    welcome: "供应链 Agent 正在规划中。",
    followUps: [],
    placeholder: "",
    workingLabel: "",
  },
] as const;

export function isAgentContext(value: unknown): value is AgentContext {
  return typeof value === "string" && (AGENT_CONTEXTS as readonly string[]).includes(value);
}

export function getDigitalEmployee(id: AgentContext): DigitalEmployee {
  return DIGITAL_EMPLOYEES.find((employee) => employee.id === id) ?? DIGITAL_EMPLOYEES[0];
}
