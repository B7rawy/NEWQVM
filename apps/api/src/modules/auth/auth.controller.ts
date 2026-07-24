import { Body, Controller, Post } from "@nestjs/common";
import { AuthService, loginSchema, signupSchema } from "./auth.service.js";

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("login")
  login(@Body() body: unknown) {
    return this.auth.login(loginSchema.parse(body));
  }

  /** Public self-registration for a counterparty (vendor/workshop). Creates a pending account + token. */
  @Post("signup")
  signup(@Body() body: unknown) {
    return this.auth.signup(signupSchema.parse(body));
  }
}
