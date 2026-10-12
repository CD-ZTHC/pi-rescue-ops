// System prompt 分段（§5.3）：稳定在前，易变在后，以利于前缀缓存。
import type { SystemMessage } from '@earendil-works/pi-ai';
import type { WatchPhase, WorldSnapshot } from '@rescue/protocol';
import { MODULE_NAMES } from '@rescue/protocol';

export interface PromptSpec {
  name: string;
  title: string;
  mission: string;
  toolsGuide: string;
}

const RULES_SECTION = `<rules>
- 世界时间以秒计，一班 12 分钟。信号会在倒计时结束后失联。
- 约 15% 的求救信号是恶作剧或诱饵：在派出资源前先用扫描核实。
- 资源有限：燃料 100，无人机 3 架，医疗舱床位 4。
- 你的工具返回的是「已受理」回执，真正发生的事会以【站务】消息告知你。
- 全程使用简体中文，语气简洁、专业，像舰桥上的值班军官。
</rules>`;

const PHASE_TEXT: Record<WatchPhase, string> = {
  calm: '平稳：按部就班处理信号。',
  storm: '风暴：耀斑活动增强，注意危险区。',
  crisis: '危机：多个危急信号并存，优先保住人命。',
  handover: '交班：停止新的行动，准备交班报告。',
};

export function stationStatusSection(world: WorldSnapshot): string {
  const text = world.modules.map((m) => `${MODULE_NAMES[m.id]}：${m.status === 'ok' ? '正常' : m.status === 'damaged' ? '受损' : '离线'}`);
  return `<station_status>\n${text.join('\n')}\n</station_status>`;
}

export function watchPhaseSection(phase: WatchPhase): string {
  return `<watch_phase>${PHASE_TEXT[phase]}</watch_phase>`;
}

/** 首条 system 消息的 content + sections */
export function renderBaseSystem(spec: PromptSpec, world: WorldSnapshot): Pick<SystemMessage, 'content' | 'sections'> {
  return {
    content: `你是「织女-7」轨道救援站的${spec.title}「${spec.name}」。`,
    sections: {
      mission: `<mission>\n${spec.mission}\n</mission>`,
      rules: RULES_SECTION,
      tools_guide: `<tools_guide>\n${spec.toolsGuide}\n</tools_guide>`,
      station_status: stationStatusSection(world),
      watch_phase: watchPhaseSection(world.phase),
    },
  };
}
