import { GroupGuard } from "./durable/group-guard";
import { GlobalBudget } from "./durable/global-budget";
import type { Env } from "./config";
import { errorCode } from "./errors";
import { ConsoleLogger } from "./log";
import { handleError, handleScheduled, handleWebhook } from "./worker";

export { GlobalBudget, GroupGuard };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await handleWebhook(request, env, ctx);
    } catch (error) {
      new ConsoleLogger().error({
        outcome: "request_rejected",
        code: errorCode(error),
      });
      return handleError(error);
    }
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    await handleScheduled(controller, env, ctx);
  },
};
