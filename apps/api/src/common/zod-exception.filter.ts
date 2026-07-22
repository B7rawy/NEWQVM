import { ArgumentsHost, Catch, ExceptionFilter } from "@nestjs/common";
import type { Response } from "express";
import { ZodError } from "zod";

/** Turn a thrown ZodError (from schema.parse at a controller boundary) into a clean 400,
 *  instead of a generic 500. Keeps validation consistent app-wide (CONVENTIONS §BE-4). */
@Catch(ZodError)
export class ZodExceptionFilter implements ExceptionFilter {
  catch(error: ZodError, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    res.status(400).json({
      statusCode: 400,
      error: "Bad Request",
      message: error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)),
    });
  }
}
