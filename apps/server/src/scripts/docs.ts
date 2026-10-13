// 生成讲义（§8「每一课：讲义 100–300 字，附源码链接」）与 README 能力索引：node apps/server/src/scripts/docs.ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { getLesson, LESSON_SOURCES, lessonList } from '@rescue/lessons';
import { POLICY_FLAGS } from '@rescue/protocol';

const slug = (index: number, title: string) => `${String(index).padStart(2, '0')}-${title.replace(/[\s/]+/g, '')}.md`;

await mkdir('docs/lessons', { recursive: true });
const lessons = lessonList();
for (const l of lessons) {
  const script = getLesson(l.id);
  const steps = script?.steps.map((s, i) => `${i + 1}. ${s.label}`).join('\n') ?? '';
  const sources = (LESSON_SOURCES[l.index] ?? []).map((f) => `- [\`${f}\`](../../${f})`).join('\n');
  const toggle = l.toggle
    ? `## 关掉它会怎样\n\n${l.toggle}${l.toggleKey ? `\n\n讲义面板里有一键开关：策略 \`${l.toggleKey}\`（${POLICY_FLAGS[l.toggleKey].label}，作用于 \`${POLICY_FLAGS[l.toggleKey].hook}\`）。改完点「↻ faux 运行」再跑一次对比。` : ''}\n`
    : '';
  const body = `# 第 ${l.index} 课 · ${l.title}

> 能力：${l.capability}　｜　场景：${l.scenario}　｜　里程碑：${l.milestone}

## 讲解

${l.summary}

${steps ? `## 课程脚本\n\n${script?.replay ? '本课回放录制文件，不驱动新的模型请求。' : 'faux 模式下按以下步骤运行（同时是回归测试）：'}\n\n${steps}\n` : script?.replay ? `## 课程脚本\n\n回放 \`recordings/\` 下的录制：${script.replay.map((f) => `\`${f}\``).join(' → ')}（用第一个存在的）。\n` : ''}
${toggle}
## 源码

${sources}

## 怎么运行

- 界面：底栏「课程」点 **${l.index}**；讲义面板里可切换 faux / 真实模型。
- 测试：\`node --test --test-name-pattern='第 ${l.index} 课' apps/server/src/test/\`
`;
  await writeFile(`docs/lessons/${slug(l.index, l.title)}`, body.replace(/\n{3,}/g, '\n\n'));
}

// README 能力索引：替换标记之间的内容
const index = [
  '| # | 课程 | 能力 | 讲义 | 源码 |',
  '|---|---|---|---|---|',
  ...lessons.map(
    (l) =>
      `| ${l.index} | ${l.title} | ${l.capability} | [讲义](docs/lessons/${slug(l.index, l.title)}) | ${(LESSON_SOURCES[l.index] ?? []).map((f) => `\`${f.replace(/^apps\/server\/src\//, '')}\``).join('<br>')} |`,
  ),
].join('\n');
const readme = await readFile('README.md', 'utf8');
const start = '<!-- capability-index:start -->';
const end = '<!-- capability-index:end -->';
const block = `${start}\n${index}\n${end}`;
const next = readme.includes(start) ? readme.replace(new RegExp(`${start}[\\s\\S]*?${end}`), block) : `${readme.trimEnd()}\n\n## 能力索引（22 课）\n\n${block}\n`;
await writeFile('README.md', next);
console.log(`已生成 ${lessons.length} 页讲义与 README 能力索引`);
