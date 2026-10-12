// JSONL 落盘（§9）：每个班次一个 missions/<missionId>.jsonl，按 seq 依次写入所有总线消息。
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ServerMsg } from '@rescue/protocol';
import type { Bus } from './bus.ts';

export class Journal {
  readonly file: string;
  private buffer: string[] = [];
  private writing: Promise<void> = Promise.resolve();
  private ready: Promise<void>;
  private off?: () => void;

  constructor(dir: string, missionId: string) {
    this.file = join(dir, `${missionId}.jsonl`);
    this.ready = mkdir(dir, { recursive: true }).then(() => undefined);
  }

  attach(bus: Bus): void {
    this.off = bus.subscribe((msg) => this.write(msg));
  }

  write(entry: ServerMsg | Record<string, unknown>): void {
    this.buffer.push(JSON.stringify(entry));
    if (this.buffer.length >= 200) void this.flush();
  }

  /** 把缓冲写入磁盘。agent_end 的 awaited 监听器会等待它完成。 */
  flush(): Promise<void> {
    if (this.buffer.length === 0) return this.writing;
    const chunk = this.buffer.join('\n') + '\n';
    this.buffer = [];
    this.writing = this.writing.then(async () => {
      await this.ready;
      await appendFile(this.file, chunk, 'utf8');
    });
    return this.writing;
  }

  async close(): Promise<void> {
    this.off?.();
    await this.flush();
  }
}
