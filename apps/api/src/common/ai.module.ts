import { Global, Module } from "@nestjs/common";
import { AiService } from "./ai.service.js";

/** Global, like NotificationsModule and StatusModule — the other cross-cutting boundaries. */
@Global()
@Module({ providers: [AiService], exports: [AiService] })
export class AiModule {}
