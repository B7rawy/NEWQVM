import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";

async function bootstrap() {
  // Input validation is done with zod at each boundary (CONVENTIONS §BE-4), not class-validator.
  const app = await NestFactory.create(AppModule, { cors: true });
  app.setGlobalPrefix("api");
  const port = Number(process.env.API_PORT ?? 4000);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`[qvm-api] listening on http://localhost:${port}/api`);
}

void bootstrap();
