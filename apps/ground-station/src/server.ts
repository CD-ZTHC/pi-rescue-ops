// 地面站（§5.10）：独立的 stdio MCP server。
// - ship_registry_lookup：船舶登记（含需要打码的个人信息字段）
// - station_manual_search：站务手册检索
// - space_weather_forecast：天气卫星上线后才注册，随后发出 tools/list_changed
// - _uplink：救援站内部上行通道（下划线开头，不交给模型），推送耀斑计划、触发卫星上线
import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'zhinv7-ground-station', version: '0.1.0' }, { capabilities: { tools: { listChanged: true } } });

const VESSEL_TYPES: Record<string, string> = { 曙光: '客船', 远航: '矿船', 青鸟: '科考船', 启明: '客船', 长庚: '矿船', 玄武: '矿船', 白鹭: '科考船', 海燕: '客船', 天枢: '科考船', 摇光: '客船' };
const SURNAMES = ['李', '王', '张', '刘', '陈', '杨', '赵', '黄', '周', '吴'];
const GIVEN = ['明远', '晓岚', '振华', '思齐', '一帆', '若曦', '建国', '星河', '安澜', '子墨'];

function hash(s: string): number {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619) >>> 0;
  return h;
}

server.registerTool(
  'ship_registry_lookup',
  {
    title: '船舶登记查询',
    description: '按船名查询地面站的船舶登记：船型、建造年份、额定载员，以及船长与联系方式。',
    inputSchema: { name: z.string().describe('船名，例如「曙光号」或「曙光」') },
    outputSchema: {
      vessel: z.string(),
      type: z.string(),
      built: z.number(),
      capacity: z.number(),
      captain: z.string(),
      phone: z.string(),
      idNumber: z.string(),
      homePort: z.string(),
    },
  },
  async ({ name }) => {
    const key = Object.keys(VESSEL_TYPES).find((k) => name.includes(k));
    if (!key) return { content: [{ type: 'text', text: `登记库里没有「${name}」` }], isError: true };
    const h = hash(key);
    const record = {
      vessel: `${key}号`,
      type: VESSEL_TYPES[key],
      built: 2140 + (h % 40),
      capacity: 4 + (h % 12),
      captain: `${SURNAMES[h % 10]}${GIVEN[(h >> 4) % 10]}`,
      phone: `13${String(h).padStart(9, '0').slice(0, 9)}`,
      idNumber: `ZN7-${String(h % 1000000).padStart(6, '0')}`,
      homePort: ['天津港', '文昌港', '酒泉港'][h % 3],
    };
    const text = `船舶登记：${record.vessel}（${record.type}，${record.built} 年建造，额定载员 ${record.capacity} 人），船长：${record.captain}，联系电话：${record.phone}，证件号：${record.idNumber}，母港：${record.homePort}`;
    return { content: [{ type: 'text', text }], structuredContent: record };
  },
);

const MANUAL = [
  { title: '耀斑区飞行', text: '耀斑期间无人机进入危险区，燃料消耗按暴露比例增加，并可能受损；预警阶段即应改走绕行航线。' },
  { title: '诱饵信标识别', text: '诱饵信标的应答码格式规整、信号强度恒定、位置静止；真实遇险船通常有设备老化特征与漂移。' },
  { title: '舱段火情处置', text: '先查看监控确定火点网格，再对该网格排空；排错区段会造成人员伤亡。火情处置完毕后才能修复。' },
  { title: '伤员分级', text: '心律不齐或血氧持续低于 90% 的伤员属于危急，需在 90 秒内入住医疗舱。' },
  { title: '燃料预留', text: '对倒计时长但价值高的信号，可先预留燃料，避免被其他出动占用。' },
];

server.registerTool(
  'station_manual_search',
  {
    title: '站务手册检索',
    description: '在救援站操作手册中检索条目。',
    inputSchema: { query: z.string().describe('关键词，例如「诱饵」「耀斑」') },
  },
  async ({ query }) => {
    const words = query.split(/[\s，,、]+/).filter(Boolean);
    const hits = MANUAL.filter((m) => words.some((w) => m.title.includes(w) || m.text.includes(w)));
    const list = hits.length ? hits : MANUAL.slice(0, 1);
    return { content: [{ type: 'text', text: list.map((m) => `【${m.title}】${m.text}`).join('\n') }], structuredContent: { results: list } };
  },
);

// 上行数据：救援站推送的耀斑计划（地面站的「预报」带误差）
let uplink: { tick: number; nextFlare?: { sectors: string[]; startTick: number } } = { tick: 0 };
let forecastTool: RegisteredTool | undefined;

const fmt = (tick: number) => `T+${String(Math.floor(tick / 60)).padStart(2, '0')}:${String(tick % 60).padStart(2, '0')}`;

function registerForecast() {
  forecastTool = server.registerTool(
    'space_weather_forecast',
    {
      title: '太空天气预报',
      description: '天气卫星提供的耀斑预报：未来可能爆发耀斑的星区与时间（带误差）。比站内预警更早。',
      inputSchema: {},
    },
    async () => {
      const f = uplink.nextFlare;
      if (!f) return { content: [{ type: 'text', text: '未来 5 分钟内无明显耀斑活动。' }], structuredContent: { flare: null } };
      const jitter = (hash(String(f.startTick)) % 31) - 15;
      const eta = f.startTick + jitter;
      const text = `预计 ${fmt(eta)} 前后（±20 秒）${f.sectors.join('、')} 区出现耀斑，距今约 ${Math.max(0, eta - uplink.tick)} 秒，把握 70%。`;
      return { content: [{ type: 'text', text }], structuredContent: { flare: { sectors: f.sectors, eta, confidence: 0.7 } } };
    },
  );
}

server.registerTool(
  '_uplink',
  {
    description: '救援站内部上行通道（不交给模型）',
    inputSchema: {
      tick: z.number(),
      nextFlare: z.object({ sectors: z.array(z.string()), startTick: z.number() }).optional(),
      satellite: z.enum(['online', 'offline']).optional(),
    },
  },
  async ({ tick, nextFlare, satellite }) => {
    uplink = { tick, nextFlare };
    if (satellite === 'online' && !forecastTool) registerForecast(); // registerTool 会自动发 tools/list_changed
    if (satellite === 'offline' && forecastTool) {
      forecastTool.remove();
      forecastTool = undefined;
    }
    return { content: [{ type: 'text', text: 'ok' }] };
  },
);

if (process.env.GS_SATELLITE === 'online') registerForecast();

await server.connect(new StdioServerTransport());
