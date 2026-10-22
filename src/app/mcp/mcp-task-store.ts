import { join } from "node:path";
import type {
  SubmissionGateResult,
  SubmissionImage,
  SubmissionSource,
} from "@src/features/weixin-article/services/article-submission-gate.service.ts";

export type McpTaskStatus = "submitted" | "gate_passed" | "gate_blocked";

export interface McpTaskImage extends SubmissionImage {
  weixinMediaId?: string;
  weixinUrl?: string;
}

export interface McpTask {
  taskId: string;
  accountId: string;
  businessKey: string;
  contentHash: string;
  title: string;
  digest: string;
  author?: string;
  sources: SubmissionSource[];
  images: McpTaskImage[];
  status: McpTaskStatus;
  gate?: SubmissionGateResult & { evaluatedAt: string; contentHash: string };
  createdAt: string;
  updatedAt: string;
}

/**
 * 每个任务一个目录：task.json / article.html / article.md / sources.json / gate.json / run.log.jsonl
 */
export class McpTaskStore {
  constructor(private readonly baseDir: string) {}

  dir(taskId: string): string {
    if (!/^[\w-]+$/.test(taskId)) throw new Error("非法 taskId");
    return join(this.baseDir, taskId);
  }

  async get(taskId: string): Promise<McpTask | null> {
    try {
      return JSON.parse(
        await Deno.readTextFile(join(this.dir(taskId), "task.json")),
      ) as McpTask;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return null;
      throw error;
    }
  }

  async getHtml(taskId: string): Promise<string> {
    return await Deno.readTextFile(join(this.dir(taskId), "article.html"));
  }

  async create(
    task: McpTask,
    files: { html: string; markdown?: string },
  ): Promise<void> {
    const dir = this.dir(task.taskId);
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(join(dir, "article.html"), files.html);
    if (files.markdown !== undefined) {
      await Deno.writeTextFile(join(dir, "article.md"), files.markdown);
    }
    await Deno.writeTextFile(
      join(dir, "sources.json"),
      JSON.stringify(task.sources, null, 2),
    );
    await this.save(task);
  }

  async save(task: McpTask): Promise<void> {
    const dir = this.dir(task.taskId);
    await Deno.mkdir(dir, { recursive: true });
    task.updatedAt = new Date().toISOString();
    const tmp = join(dir, "task.json.tmp");
    await Deno.writeTextFile(tmp, JSON.stringify(task, null, 2));
    await Deno.rename(tmp, join(dir, "task.json"));
    if (task.gate) {
      await Deno.writeTextFile(
        join(dir, "gate.json"),
        JSON.stringify(task.gate, null, 2),
      );
    }
  }

  async log(taskId: string, type: string, detail: unknown): Promise<void> {
    const dir = this.dir(taskId);
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(
      join(dir, "run.log.jsonl"),
      JSON.stringify({ at: new Date().toISOString(), type, detail }) + "\n",
      { append: true },
    );
  }
}
