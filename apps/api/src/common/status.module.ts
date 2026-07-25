import { Global, Module } from "@nestjs/common";
import { StatusService } from "./status.service.js";

/** Global so every domain module can inject the single status-write entry point without wiring
 *  it into each module's imports (same pattern as NotificationsModule, the other cross-cutting
 *  boundary service). */
@Global()
@Module({ providers: [StatusService], exports: [StatusService] })
export class StatusModule {}
