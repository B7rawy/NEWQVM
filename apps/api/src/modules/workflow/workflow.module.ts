import { Module } from "@nestjs/common";
import { WorkflowController } from "./workflow.controller.js";
import { WorkflowService } from "./workflow.service.js";
import { WorkflowDigestService } from "./digest.service.js";

/**
 * WorkflowDigestService has no controller and is exported to nobody. It is registered here because
 * a provider is how a Nest application gets a lifecycle: onApplicationBootstrap arms the daily
 * timer and onModuleDestroy disarms it, so the job starts and stops with the process rather than
 * with a request. It must be registered in exactly ONE module — a second registration is a second
 * instance, and a second instance is a second timer sending the same digest.
 */
@Module({
  controllers: [WorkflowController],
  providers: [WorkflowService, WorkflowDigestService],
})
export class WorkflowModule {}
