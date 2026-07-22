import { Body, Controller, Param, Post } from "@nestjs/common";
import { submitQuoteSchema, VendorRfqService } from "./vendor-rfq.service.js";

/**
 * PUBLIC vendor quote portal — unauthenticated, token-gated (the emailed /quote-access/:token link).
 * No AuthGuard: the token is the credential. The service resolves it and scopes writes to the
 * token's tenant so RLS still applies.
 */
@Controller("quote-access")
export class QuoteAccessController {
  constructor(private readonly vendorRfq: VendorRfqService) {}

  @Post(":token/quote")
  submit(@Param("token") token: string, @Body() body: unknown) {
    return this.vendorRfq.submitQuoteByToken(token, submitQuoteSchema.parse(body));
  }
}
