import { Module } from "@nestjs/common";
import { WorkflowController } from "./workflow.controller.js";
import { WorkflowService } from "./workflow.service.js";
import { WorkflowDigestService } from "./digest.service.js";
import { WorkflowWebhookDispatchService } from "./webhook-dispatch.service.js";

/**
 * WorkflowDigestService and WorkflowWebhookDispatchService have no controller and are exported to
 * nobody. They are registered here because a provider is how a Nest application gets a lifecycle:
 * onApplicationBootstrap arms their timers and onModuleDestroy disarms them, so the jobs start and
 * stop with the process rather than with a request. Each must be registered in exactly ONE module —
 * a second registration is a second instance, and a second instance is a second timer.
 *
 * For the digest that would mean the same daily message sent twice. For the dispatcher it would
 * mean two tickers inside ONE process, which the `running` flag does not protect against because it
 * is per instance; what would save it is `for update skip locked` on the claim, so the failure mode
 * is wasted work rather than a duplicated delivery. Registering it once is still the rule, because
 * relying on the second line of defence for something the first line should never allow is how the
 * first line stops being maintained.
 */
@Module({
  controllers: [WorkflowController],
  providers: [WorkflowService, WorkflowDigestService, WorkflowWebhookDispatchService],
})
export class WorkflowModule {}
