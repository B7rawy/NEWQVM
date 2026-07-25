import { Module } from "@nestjs/common";
import { WorkflowController } from "./workflow.controller.js";
import { WorkflowService } from "./workflow.service.js";

@Module({ controllers: [WorkflowController], providers: [WorkflowService] })
export class WorkflowModule {}
